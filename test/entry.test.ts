import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerMessageHook, HOOK_GRACE_MS, type ApiLike } from "../src/entry.ts";
import type { SpawnFn } from "../src/checker.ts";
import { NULL_DIAG_SINK, type DiagRecord } from "../src/diaglog.ts";

function fakeApi(pluginConfig?: Record<string, unknown>): {
  api: ApiLike;
  registered: string[];
  handlers: Record<string, (event: any, ctx: any) => Promise<any>>;
  injected: Array<Record<string, unknown>>;
  logs: string[];
} {
  const registered: string[] = [];
  const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
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
    on: (hook, handler) => {
      registered.push(hook);
      handlers[hook] = async (event, ctx) => (handler as any)(event, ctx);
    },
  };
  return { api, registered, handlers, injected, logs };
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

/** Image under <workspaceDir>/media/inbound (prompt-note gate layout). */
async function workspaceImage(): Promise<{ ws: string; file: string }> {
  const ws = await mkdtemp(path.join(tmpdir(), "vmhook-ew-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(ws, "media", "inbound"), { recursive: true });
  const file = path.join(ws, "media", "inbound", "openclaw-media-1-abc.jpg");
  await writeFile(file, Buffer.alloc(6, 1));
  return { ws, file };
}

test("registration wires message_received and before_prompt_build", () => {
  const { api, registered } = fakeApi({ workspaceDir: "/ws" });
  registerMessageHook(api);
  assert.deepEqual(registered, ["message_received", "before_prompt_build"]);
});

test("config defaults resolve under the host user home (2-min sync window)", () => {
  const { api } = fakeApi();
  const { config } = registerMessageHook(api);
  const home = process.env.HOME ?? "~";
  assert.equal(
    config.workspaceDir,
    `${home.replace(/\/+$/, "")}/.openclaw/workspace`,
  );
  // Operator order 30.09: the Gateway waits up to 2 minutes (parity with
  // active-memory MAX_TIMEOUT_MS = 120000).
  assert.equal(config.checkTimeoutMs, 120000);
});

test("image event is observed only — no enqueue, no GPU work in the message seam", async () => {
  const file = await image();
  const { api, injected } = fakeApi({ workspaceDir: "/ws" });
  const { spawn, calls } = okSpawn('{"ok":true,"hits":[]}');
  const { handle } = registerMessageHook(api, { spawn, diag: NULL_DIAG_SINK });
  handle(
    { messageId: "e1", media: [{ kind: "image", path: file }] },
    { sessionKey: "agent:main:whatsapp:direct:+49xxxxxxx" },
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(injected.length, 0, "synchronous prompt seam owns delivery");
  assert.equal(calls.n, 0, "no double check next to the prompt seam");
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

// Root cause 3 (2026-09-30) fix, synchronous edition (operator order 10:17):
// the prompt hook awaits the check and returns prependContext in the SAME
// turn — the enqueue API is never touched, so a host that refuses enqueue
// cannot lose the block any more.
test("prompt hook delivers synchronously via prependContext; enqueue untouched", async () => {
  const { ws, file } = await workspaceImage();
  const { api, injected } = fakeApi({ workspaceDir: ws });
  // Host refuses every enqueue — must be irrelevant now.
  api.session.workflow.enqueueNextTurnInjection = async () => ({ enqueued: false });
  const { spawn } = okSpawn('{"ok":true,"hits":[{"name":"Anna","kind":"person","score":0.9,"confidence":"certain"}]}');
  const { handlers } = registerMessageHook(api, { spawn, diag: NULL_DIAG_SINK });
  const result = await handlers.before_prompt_build!(
    { prompt: `[media attached: ${file} (image/jpeg)]\nWer?` },
    { sessionKey: "agent:main:whatsapp:direct:+49x", channel: "whatsapp", trigger: "user" },
  );
  assert.deepEqual(result, {
    prependContext: "[Visual Memory] Treffer: Anna (person, certain, 0.90)",
  });
  assert.equal(injected.length, 0, "enqueue path never used for prompt images");
});

test("registration passes the full synchronous timeout budget to the host", () => {
  const opts: Array<Record<string, unknown> | undefined> = [];
  const { api } = fakeApi({ workspaceDir: "/ws", checkTimeoutMs: 45000 });
  const origOn = api.on;
  api.on = ((hook: "message_received" | "before_prompt_build", h: any, o?: { timeoutMs?: number }) => {
    opts.push(o);
    origOn(hook, h);
  }) as typeof api.on;
  registerMessageHook(api, { diag: NULL_DIAG_SINK });
  // message_received: no special budget; prompt hook: 45s + grace.
  assert.equal(opts[1]?.timeoutMs, 45000 + HOOK_GRACE_MS);
});

test("staging retry (missed the prompt) still uses the next-turn enqueue", async () => {
  const { ws, file } = await workspaceImage();
  const { api, injected } = fakeApi({ workspaceDir: ws });
  const { spawn } = okSpawn('{"ok":true,"hits":[]}');
  const scheduled: Array<() => void> = [];
  const { handle } = registerMessageHook(api, {
    spawn,
    diag: NULL_DIAG_SINK,
    schedule: (fn) => { scheduled.push(fn); return null; },
    fileExists: () => true,
  });
  handle(
    { messageId: "s1", mediaStagingPending: true, originalMedia: [{ kind: "image", path: file }] },
    { sessionKey: "agent:main:whatsapp:direct:+49x" },
  );
  assert.equal(scheduled.length, 1);
  scheduled[0]!();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(injected.length, 1, "staging fallback enqueues for the next turn");
  assert.equal(injected[0]!.placement, "prepend_context");
});
