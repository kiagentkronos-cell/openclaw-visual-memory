import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  handlePromptBuild,
  handleMessageReceived,
  MessageLedger,
  type HandlerDeps,
} from "../src/handler.ts";
import type { SpawnFn } from "../src/checker.ts";
import type { DiagRecord } from "../src/diaglog.ts";
import { registerMessageHook, type ApiLike } from "../src/entry.ts";

async function fakeImage(name = "photo.jpg"): Promise<string> {
  const dir = await fakeMediaImage(name);
  return dir.file;
}

/**
 * Image inside a fresh temp media dir (prompt-note gate, Hyperion review
 * 1c4c01d Minor-1: only paths under mediaDir survive note parsing, so
 * prompt-build fixtures must live inside the media dir they configure).
 */
async function fakeMediaImage(name = "photo.jpg"): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "vmhook-p-"));
  const inbound = path.join(dir, "inbound");
  await mkdir(inbound, { recursive: true });
  const file = path.join(inbound, name);
  await writeFile(file, Buffer.alloc(8, 9));
  return { dir, file };
}

function okSpawn(stdout = '{"ok":true,"hits":[{"name":"Alice","kind":"person","score":0.72,"confidence":"certain"}]}'): {
  spawn: SpawnFn;
  calls: { n: number };
} {
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

function makeDeps(overrides: Partial<HandlerDeps> & { spawn: SpawnFn }): {
  deps: HandlerDeps;
  enqueued: Array<{ sessionKey: string; text: string }>;
  diag: DiagRecord[];
} {
  const enqueued: Array<{ sessionKey: string; text: string }> = [];
  const records: DiagRecord[] = [];
  const deps: HandlerDeps = {
    config: {
      enabled: true,
      workspaceDir: "/ws",
      vmScriptRelPath: "vm.py",
      venvRelPath: "venv/bin/python",
      checkTimeoutMs: 1000,
      maxImageSizeBytes: 0,
      maxImageAgeMs: 0,
      injectionTtlMs: 60000,
      stagingRetryMs: 5000,
      diagLogPath: "/tmp/vm-hook-test-diag.log",
      mediaDir: "/ws/media",
    },
    pythonPath: "/fake/python",
    scriptPath: "/fake/vm.py",
    log: { info() {}, warn() {}, error() {} },
    processed: new MessageLedger(),
    diag: { record: (r) => records.push(r) },
    schedule: (fn) => { fn(); return null; },
    fileExists: () => false,
    mediaDir: "/ws/media",
    enqueue: async (p) => { enqueued.push(p); },
    ...overrides,
  };
  return { deps, enqueued, diag: records };
}

test("WhatsApp path: prompt media note triggers check + injection", async () => {
  const { dir, file: img } = await fakeMediaImage();
  const { spawn, calls } = okSpawn();
  const { deps, enqueued, diag } = makeDeps({ spawn, mediaDir: dir });
  const decision = handlePromptBuild(
    {
      prompt: `[media attached: ${img} (image/jpeg)]\nWer ist auf dem Foto?`,
    },
    { sessionKey: "agent:main:whatsapp:direct:+49x", channel: "whatsapp", trigger: "user" },
    deps,
  );
  assert.equal(decision.action, "queued");
  await (decision as { check: Promise<void> }).check;
  assert.equal(calls.n, 1);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]!.sessionKey, "agent:main:whatsapp:direct:+49x");
  assert.match(enqueued[0]!.text, /Treffer: Alice/);
  assert.ok(diag.some((r) => r.decision === "prompt_fire" && r.channel === "whatsapp"));
  assert.ok(diag.some((r) => r.decision === "injected"));
});

test("prompt hook fires and logs a decision even without any image", async () => {
  const { spawn } = okSpawn();
  const { deps, enqueued, diag } = makeDeps({ spawn });
  const decision = handlePromptBuild(
    { prompt: "nur text ohne medien" },
    { sessionKey: "agent:main:whatsapp:direct:+49x", channel: "whatsapp" },
    deps,
  );
  assert.equal(decision.action, "no-image");
  assert.equal(enqueued.length, 0);
  assert.equal(diag.length, 1);
  assert.equal(diag[0]!.decision, "prompt_fire");
  assert.equal(diag[0]!.channel, "whatsapp");
});

test("prompt path dedupes against the message_received check on the same path", async () => {
  const { dir, file: img } = await fakeMediaImage();
  const { spawn, calls } = okSpawn();
  const { deps, enqueued, diag } = makeDeps({ spawn, mediaDir: dir });
  // webchat: message_received fires first and claims the path.
  const first = handleMessageReceived(
    { messageId: "wc1", sessionKey: "agent:main:webchat:x", media: [{ path: img, kind: "image" }] },
    { sessionKey: "agent:main:webchat:x", messageId: "wc1" },
    deps,
  );
  assert.equal(first.action, "queued");
  await first.check;
  // Then the prompt hook sees the same image in the prompt: no second check.
  const second = handlePromptBuild(
    { prompt: `[media attached: ${img} (image/jpeg)]\nhi` },
    { sessionKey: "agent:main:webchat:x", channel: "webchat" },
    deps,
  );
  assert.equal(second.action, "duplicate");
  assert.equal(calls.n, 1, "exactly one vm.py invocation");
  assert.equal(enqueued.length, 1);
  assert.ok(diag.some((r) => r.decision === "prompt_fire"));
  assert.ok(diag.some((r) => r.decision === "dedup_skip"));
});

test("prompt media note with media://inbound alias resolves under mediaDir", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vmhook-pm-"));
  await mkdir(path.join(dir, "inbound"), { recursive: true });
  const img = path.join(dir, "inbound", "uuid-1.jpg");
  await writeFile(img, Buffer.alloc(8, 9));
  const { spawn, calls } = okSpawn();
  const { deps, enqueued } = makeDeps({ spawn, mediaDir: dir });
  const decision = handlePromptBuild(
    { prompt: "[media attached: media://inbound/uuid-1.jpg (image/jpeg)]" },
    { sessionKey: "agent:main:whatsapp:direct:+49x", channel: "whatsapp" },
    deps,
  );
  assert.equal(decision.action, "queued");
  await (decision as { check: Promise<void> }).check;
  assert.equal(calls.n, 1);
  assert.equal(enqueued.length, 1);
});

test("registration wires message_received AND before_prompt_build", () => {
  const registered: string[] = [];
  const api: ApiLike = {
    logger: {},
    session: { workflow: { enqueueNextTurnInjection: async () => {} } },
    on: (hook: string) => { registered.push(hook); },
  };
  registerMessageHook(api, { diag: { record() {} } });
  assert.deepEqual(registered, ["message_received", "before_prompt_build"]);
});

test("event.media[] with kind=image still triggers (channel without prompt note)", async () => {
  const img = await fakeImage();
  const { spawn, calls } = okSpawn();
  const { deps, enqueued } = makeDeps({ spawn });
  const decision = handleMessageReceived(
    { messageId: "wa2", media: [{ path: img, kind: "image", contentType: "image/jpeg" }] },
    { sessionKey: "agent:main:whatsapp:direct:+49x", messageId: "wa2" },
    deps,
  );
  assert.equal(decision.action, "queued");
  await (decision as { check: Promise<void> }).check;
  assert.equal(calls.n, 1);
  assert.equal(enqueued.length, 1);
});
