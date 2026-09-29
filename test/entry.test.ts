import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerMessageHook, type ApiLike } from "../src/entry.ts";
import type { SpawnFn } from "../src/checker.ts";
import { NULL_DIAG_SINK, type DiagRecord } from "../src/diaglog.ts";

function fakeApi(pluginConfig?: Record<string, unknown>): {
  api: ApiLike;
  registered: string[];
  injected: Array<Record<string, unknown>>;
  logs: string[];
} {
  const registered: string[] = [];
  const injected: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const api: ApiLike = {
    pluginConfig,
    logger: {
      info: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
    },
    session: {
      workflow: {
        enqueueNextTurnInjection: async (injection) => {
          injected.push(injection as Record<string, unknown>);
          return { enqueued: true, id: "inj-1", sessionKey: injection.sessionKey };
        },
      },
    },
    on: (hook) => {
      registered.push(hook);
    },
  };
  return { api, registered, injected, logs };
}

function okSpawn(stdout: string): { spawn: SpawnFn; calls: { n: number } } {
  const state = { n: 0 };
  const spawn: SpawnFn = () => {
    state.n += 1;
    return {
      stdout: { on(_e: string, cb: (c: string) => void) { setImmediate(() => cb(stdout)); } },
      stderr: { on() {} },
      on(ev: string, cb: any) {
        if (ev === "close") setImmediate(() => cb(0));
      },
      kill() {},
    } as never;
  };
  return { spawn, calls: state };
}

async function image(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "vmhook-e-"));
  const file = path.join(dir, "pic.jpg");
  await writeFile(file, Buffer.alloc(6, 1));
  return file;
}

test("registration wires the message_received hook", () => {
  const { api, registered } = fakeApi({ workspaceDir: "/ws" });
  registerMessageHook(api);
  assert.deepEqual(registered, ["message_received"]);
});

test("config defaults resolve under the host user home", () => {
  const { api } = fakeApi();
  const { config } = registerMessageHook(api);
  const home = process.env.HOME ?? "~";
  assert.equal(
    config.workspaceDir,
    `${home.replace(/\/+$/, "")}/.openclaw/workspace`,
  );
  assert.equal(config.checkTimeoutMs, 30000);
});

test("image event flows to injection with placement prepend_context", async () => {
  const file = await image();
  const { api, injected } = fakeApi({ workspaceDir: "/ws" });
  const { spawn } = okSpawn('{"ok":true,"hits":[{"name":"Anna","kind":"person","score":0.9,"confidence":"certain"}]}');
  const { handle } = registerMessageHook(api, { spawn, diag: NULL_DIAG_SINK });
  handle(
    { messageId: "e1", media: [{ kind: "image", path: file }] },
    { sessionKey: "agent:main:whatsapp:direct:+49xxxxxxx" },
  );
  // detached: wait a tick for the chained promise.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(injected.length, 1);
  assert.equal(injected[0]!.placement, "prepend_context");
  assert.equal(injected[0]!.text, "[Visual Memory] Treffer: Anna (person, certain, 0.90)");
  assert.equal(typeof injected[0]!.ttlMs, "number");
  assert.match(String(injected[0]!.idempotencyKey), /visual-memory:.*e1/);
});

test("config from pluginConfig overrides defaults", () => {
  const { api } = fakeApi({ checkTimeoutMs: 45000, enabled: false });
  const { config } = registerMessageHook(api);
  assert.equal(config.checkTimeoutMs, 45000);
  assert.equal(config.enabled, false);
});

test("staging-pending event schedules exactly one guarded retry via wiring", async () => {
  const { api } = fakeApi({ workspaceDir: "/ws", stagingRetryMs: 7000 });
  const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
  const records: DiagRecord[] = [];
  const { handle } = registerMessageHook(api, {
    diag: { record: (r) => records.push(r) },
    schedule: (fn, delayMs) => {
      scheduled.push({ fn, delayMs });
      return null;
    },
    fileExists: () => false,
  });
  handle(
    {
      messageId: "w1",
      mediaStagingPending: true,
      originalMedia: [{ kind: "image", url: "https://x/y.jpg" }],
    },
    { sessionKey: "agent:main:whatsapp:direct:+49xxxxxxx" },
  );
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]!.delayMs, 7000, "retry delay from config");
  // Fire the retry with unreadable originals → quiet give-up, no crash.
  scheduled[0]!.fn();
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(records.some((r) => r.decision === "staging_pending_skip"));
  assert.ok(records.some((r) => r.reason === "retry_not_readable"));
});
