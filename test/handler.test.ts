import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleMessageReceived, MessageLedger, type HandlerDeps } from "../src/handler.ts";
import type { SpawnFn } from "../src/checker.ts";

async function fakeImage(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "vmhook-h-"));
  const file = path.join(dir, "photo.jpg");
  await writeFile(file, Buffer.alloc(8, 9));
  return file;
}

function fakeSpawn(opts: { stdout: string; code?: number; delayMs?: number }): { spawn: SpawnFn; calls: { calls: number } } {
  const state = { calls: 0 };
  const spawn: SpawnFn = () => {
    state.calls += 1;
    const outHandlers: Array<(c: string) => void> = [];
    const closeHandlers: Array<(c: number | null) => void> = [];
    return {
      stdout: {
        on(_ev: string, cb: (c: string) => void) {
          outHandlers.push(cb);
          setTimeout(() => cb(opts.stdout), opts.delayMs ?? 0);
        },
      },
      stderr: { on() {} },
      on(ev: string, cb: any) {
        if (ev === "close") {
          closeHandlers.push(cb);
          setTimeout(() => cb(opts.code ?? 0), (opts.delayMs ?? 0) + 1);
        }
      },
      kill() {},
    } as unknown as import("../src/checker.ts").SpawnHandle;
  };
  return { spawn, calls: state };
}

const makeDeps = (
  overrides: Partial<HandlerDeps> & { spawn: SpawnFn },
): { deps: HandlerDeps; enqueued: Array<{ sessionKey: string; text: string; idempotencyKey: string }> } => {
  const enqueued: Array<{ sessionKey: string; text: string; idempotencyKey: string }> = [];
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
    },
    pythonPath: "/fake/python",
    scriptPath: "/fake/vm.py",
    log: { info() {}, warn() {}, error() {} },
    processed: new MessageLedger(),
    enqueue: async (p) => {
      enqueued.push(p);
    },
    ...overrides,
  };
  return { deps, enqueued };
};

test("no media → no CLI call, no injection", async () => {
  const { spawn, calls } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const { deps, enqueued } = makeDeps({ spawn });
  const decision = handleMessageReceived({ content: "hi", messageId: "m1" }, { sessionKey: "s1" }, deps);
  assert.equal(decision.action, "no-image");
  assert.equal(calls.calls, 0);
  assert.equal(enqueued.length, 0);
});

test("text file only → treated as no-image", async () => {
  const { spawn, calls } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const { deps } = makeDeps({ spawn });
  const decision = handleMessageReceived(
    { content: "doc", messageId: "m1", media: [{ kind: "document", path: "/tmp/x.pdf" }] },
    { sessionKey: "s1" },
    deps,
  );
  assert.equal(decision.action, "no-image");
  assert.equal(calls.calls, 0);
});

test("image → CLI runs and hit result is enqueued for the session", async () => {
  const image = await fakeImage();
  const { spawn, calls } = fakeSpawn({
    stdout: '{"ok":true,"hits":[{"name":"Alice","kind":"person","score":0.93,"confidence":"certain","scope":"private"}]}',
  });
  const { deps, enqueued } = makeDeps({ spawn });
  const decision = handleMessageReceived(
    { content: "", messageId: "m-hit", media: [{ kind: "image", path: image }] },
    { sessionKey: "s1" },
    deps,
  );
  assert.equal(decision.action, "queued");
  if (decision.action === "queued") await decision.check;
  assert.equal(calls.calls, 1);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]!.sessionKey, "s1");
  assert.equal(enqueued[0]!.text, "[Visual Memory] Treffer: Alice (person, certain, 0.93)");
  assert.match(enqueued[0]!.idempotencyKey, /m-hit/);
});

test("empty hits → explicit no-match injection", async () => {
  const image = await fakeImage();
  const { spawn } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const { deps, enqueued } = makeDeps({ spawn });
  const decision = handleMessageReceived(
    { messageId: "m-empty", media: [{ kind: "image", path: image }] },
    { sessionKey: "s1" },
    deps,
  );
  if (decision.action === "queued") await decision.check;
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]!.text, "[Visual Memory] keine Treffer");
});

test("CLI failure → nothing injected", async () => {
  const image = await fakeImage();
  const { spawn } = fakeSpawn({ stdout: "boom", code: 1 });
  const { deps, enqueued } = makeDeps({ spawn });
  const decision = handleMessageReceived(
    { messageId: "m-fail", media: [{ kind: "image", path: image }] },
    { sessionKey: "s1" },
    deps,
  );
  if (decision.action === "queued") await decision.check;
  assert.equal(enqueued.length, 0);
});

test("staging-pending without media → skip now, later staged event checks", async () => {
  const image = await fakeImage();
  const { spawn, calls } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const { deps, enqueued } = makeDeps({ spawn });
  // First event: staging pending, only originalMedia (NOT locally readable).
  const d1 = handleMessageReceived(
    {
      messageId: "m-stage",
      mediaStagingPending: true,
      originalMedia: [{ kind: "image", url: "https://wa.example/x.jpg" }],
    },
    { sessionKey: "s1" },
    deps,
  );
  assert.equal(d1.action, "staging-pending");
  assert.equal(calls.calls, 0);
  // Later staged event for the SAME messageId → check runs once.
  const d2 = handleMessageReceived(
    { messageId: "m-stage", media: [{ kind: "image", path: image }] },
    { sessionKey: "s1" },
    deps,
  );
  assert.equal(d2.action, "queued");
  if (d2.action === "queued") await d2.check;
  assert.equal(calls.calls, 1);
  assert.equal(enqueued.length, 1);
});

test("duplicate messageId → checked exactly once", async () => {
  const image = await fakeImage();
  const { spawn, calls } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const { deps } = makeDeps({ spawn });
  const event = { messageId: "m-dup", media: [{ kind: "image", path: image }] };
  const d1 = handleMessageReceived(event, { sessionKey: "s1" }, deps);
  if (d1.action === "queued") await d1.check;
  const d2 = handleMessageReceived(event, { sessionKey: "s1" }, deps);
  assert.equal(d2.action, "duplicate");
  assert.equal(calls.calls, 1);
});

test("disabled config → nothing happens", async () => {
  const image = await fakeImage();
  const { spawn, calls } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const { deps } = makeDeps({
    spawn,
    config: {
      enabled: false,
      workspaceDir: "/ws",
      vmScriptRelPath: "vm.py",
      venvRelPath: "venv/bin/python",
      checkTimeoutMs: 1000,
      maxImageSizeBytes: 0,
      maxImageAgeMs: 0,
      injectionTtlMs: 60000,
    },
  });
  const decision = handleMessageReceived(
    { messageId: "m-off", media: [{ kind: "image", path: image }] },
    { sessionKey: "s1" },
    deps,
  );
  assert.equal(decision.action, "disabled");
  assert.equal(calls.calls, 0);
});

test("session key falls back from event to ctx", async () => {
  const image = await fakeImage();
  const { spawn } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const { deps, enqueued } = makeDeps({ spawn });
  const decision = handleMessageReceived(
    { messageId: "m-ctx", media: [{ kind: "image", path: image }] },
    { sessionKey: "ctx-session" },
    deps,
  );
  if (decision.action === "queued") await decision.check;
  assert.equal(enqueued[0]?.sessionKey, "ctx-session");
});

test("image without session key → skipped, no injection", async () => {
  const image = await fakeImage();
  const { spawn } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const { deps, enqueued } = makeDeps({ spawn });
  const decision = handleMessageReceived(
    { messageId: "m-nosess", media: [{ kind: "image", path: image }] },
    {},
    deps,
  );
  assert.equal(decision.action, "no-image");
  assert.equal(enqueued.length, 0);
});

test("multiple images in one message → one merged injection", async () => {
  const img1 = await fakeImage();
  const img2 = await fakeImage();
  const outputs = [
    '{"ok":true,"hits":[{"name":"Anna","kind":"person","score":0.9,"confidence":"certain"}]}',
    '{"ok":true,"hits":[{"name":"Bello","kind":"animal","score":0.86,"confidence":"possible"}]}',
  ];
  let i = 0;
  const spawn: SpawnFn = () => {
    const stdout = outputs[Math.min(i++, outputs.length - 1)]!;
    const handle: any = {
      stdout: { on(_e: string, cb: (c: string) => void) { setImmediate(() => cb(stdout)); } },
      stderr: { on() {} },
      on(ev: string, cb: any) {
        if (ev === "close") setImmediate(() => cb(0));
      },
      kill() {},
    };
    return handle;
  };
  const { deps, enqueued } = makeDeps({ spawn });
  const decision = handleMessageReceived(
    { messageId: "m-multi", media: [{ kind: "image", path: img1 }, { kind: "image", path: img2 }] },
    { sessionKey: "s1" },
    deps,
  );
  if (decision.action === "queued") await decision.check;
  assert.equal(enqueued.length, 1);
  assert.equal(
    enqueued[0]!.text,
    "[Visual Memory] Treffer: Anna (person, certain, 0.90); Bello (animal, possible, 0.86)",
  );
});

test("enqueue failure is logged, never thrown", async () => {
  const image = await fakeImage();
  const { spawn } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const logs: string[] = [];
  const { deps } = makeDeps({
    spawn,
    enqueue: async () => {
      throw new Error("session gone");
    },
    log: { info() {}, warn() {}, error: (m) => logs.push(m) },
  });
  const decision = handleMessageReceived(
    { messageId: "m-enq", media: [{ kind: "image", path: image }] },
    { sessionKey: "s1" },
    deps,
  );
  assert.equal(decision.action, "queued");
  if (decision.action === "queued") await decision.check; // must not throw
  assert.ok(logs.some((l) => l.includes("enqueue failed")));
});

test("MessageLedger bounds memory", () => {
  const ledger = new MessageLedger({ maxEntries: 3 });
  ledger.claim("a");
  ledger.claim("b");
  ledger.claim("c");
  ledger.claim("d");
  assert.equal(ledger.has("a"), false, "oldest evicted");
  assert.equal(ledger.has("d"), true);
  assert.equal(ledger.has("b"), true, "b survives eviction of a");
  assert.equal(ledger.claim("b"), false, "still-known key cannot be claimed again");
  assert.equal(ledger.claim("a"), true, "evicted key can be claimed again");
});
