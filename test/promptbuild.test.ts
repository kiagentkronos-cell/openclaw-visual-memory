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
import { registerMessageHook, HOOK_GRACE_MS, type ApiLike } from "../src/entry.ts";

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
      transcriptDir: "/tmp/vm-hook-test-transcripts",
      transcriptMaxFiles: 200,
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

test("WhatsApp path: prompt media note delivers synchronously via prepend", async () => {
  const { dir, file: img } = await fakeMediaImage();
  const { spawn, calls } = okSpawn();
  const { deps, enqueued, diag } = makeDeps({ spawn, mediaDir: dir });
  const decision = await handlePromptBuild(
    {
      prompt: `[media attached: ${img} (image/jpeg)]\nWer ist auf dem Foto?`,
    },
    { sessionKey: "agent:main:whatsapp:direct:+49x", channel: "whatsapp", trigger: "user" },
    deps,
  );
  assert.equal(decision.action, "prepend");
  assert.match((decision as { text: string }).text, /Treffer: Alice/);
  assert.equal(calls.n, 1);
  // Synchronous delivery bypasses the enqueue API entirely (root cause 3).
  assert.equal(enqueued.length, 0);
  assert.ok(diag.some((r) => r.decision === "prompt_fire" && r.channel === "whatsapp"));
  assert.ok(diag.some((r) => r.decision === "injected" && r.reason === "same_turn"));
});

test("prompt hook fires and logs a decision even without any image", async () => {
  const { spawn } = okSpawn();
  const { deps, enqueued, diag } = makeDeps({ spawn });
  const decision = await handlePromptBuild(
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

test("prompt path dedupes against a staging-retry check on the same path", async () => {
  const { dir, file: img } = await fakeMediaImage();
  const { spawn, calls } = okSpawn();
  const { deps, enqueued, diag } = makeDeps({ spawn, mediaDir: dir, fileExists: () => true });
  // Staging retry claims the path and enqueues (files missed the prompt).
  const first = handleMessageReceived(
    { messageId: "wc1", mediaStagingPending: true, originalMedia: [{ path: img, kind: "image" }] },
    { sessionKey: "agent:main:webchat:x", messageId: "wc1" },
    deps,
  );
  assert.equal(first.action, "staging-pending");
  // schedule runs the retry now; its check+enqueue resolve on the microtask
  // queue — let them settle before asserting.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(enqueued.length, 1, "retry delivered via next-turn enqueue");
  assert.equal(calls.n, 1);
  // Then a prompt build sees the same image in the prompt: no second check.
  const second = await handlePromptBuild(
    { prompt: `[media attached: ${img} (image/jpeg)]\nhi` },
    { sessionKey: "agent:main:webchat:x", channel: "webchat", trigger: "user" },
    deps,
  );
  assert.equal(second.action, "duplicate");
  assert.equal(calls.n, 1, "exactly one vm.py invocation");
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
  const decision = await handlePromptBuild(
    { prompt: "[media attached: media://inbound/uuid-1.jpg (image/jpeg)]" },
    { sessionKey: "agent:main:whatsapp:direct:+49x", channel: "whatsapp", trigger: "user" },
    deps,
  );
  assert.equal(decision.action, "prepend");
  assert.equal(calls.n, 1);
  assert.equal(enqueued.length, 0);
});

// Root cause 2 (2026-09-30): real WhatsApp notes point into the WORKSPACE
// media dir (openclaw-media-<ts>-<rand>.jpg directly in media/inbound).
// These fixtures prove the prompt seam now finds them via the config's
// workspaceDir (allow-list gate) instead of silently returning no-image.
test("real WhatsApp note in workspace media dir triggers synchronous check", async () => {
  // Fake image inside <workspaceDir>/media/inbound (host layout).
  const ws = await mkdtemp(path.join(tmpdir(), "vmhook-ws-"));
  const inbound = path.join(ws, "media", "inbound");
  await mkdir(inbound, { recursive: true });
  const img = path.join(inbound, "openclaw-media-1790721251603-v32ydr.jpg");
  await writeFile(img, Buffer.alloc(8, 9));
  const { spawn, calls } = okSpawn();
  // mediaDir = state store (NOT containing the file); workspaceDir = the
  // temp dir whose /media/inbound holds the image — exactly host reality.
  const { deps, enqueued, diag } = makeDeps({
    spawn,
    mediaDir: "/nonexistent-state/.openclaw/media",
    config: {
      enabled: true,
      workspaceDir: ws,
      vmScriptRelPath: "vm.py",
      venvRelPath: "venv/bin/python",
      checkTimeoutMs: 1000,
      maxImageSizeBytes: 0,
      maxImageAgeMs: 0,
      injectionTtlMs: 60000,
      stagingRetryMs: 5000,
      diagLogPath: "/tmp/vm-hook-test-diag.log",
      transcriptDir: "/tmp/vm-hook-test-transcripts",
      transcriptMaxFiles: 200,
      mediaDir: "/nonexistent-state/.openclaw/media",
    },
  });
  const decision = await handlePromptBuild(
    { prompt: `[media attached: ${img} (image/jpeg)]\nWas ist das?` },
    { sessionKey: "agent:main:whatsapp:direct:+49x", channel: "whatsapp", trigger: "user" },
    deps,
  );
  assert.equal(decision.action, "prepend");
  assert.match((decision as { text: string }).text, /Treffer: Alice/);
  assert.equal(calls.n, 1);
  assert.equal(enqueued.length, 0);
  assert.ok(diag.some((r) => r.decision === "image_found"));
});

test("always-inject: image with zero hits still delivers the keine-Treffer block", async () => {
  const { dir, file: img } = await fakeMediaImage();
  const { spawn } = okSpawn('{"ok":true,"hits":[]}');
  const { deps } = makeDeps({ spawn, mediaDir: dir });
  const decision = await handlePromptBuild(
    { prompt: `[media attached: ${img} (image/jpeg)]\nHallo` },
    { sessionKey: "agent:main:whatsapp:direct:+49x", channel: "whatsapp", trigger: "user" },
    deps,
  );
  assert.equal(decision.action, "prepend");
  assert.equal((decision as { text: string }).text, "[Visual Memory] keine Treffer");
});

test("always-inject: engine error delivers the unavailable block, never silence", async () => {
  const { dir, file: img } = await fakeMediaImage();
  const { spawn } = okSpawn("boom");
  // stdout boom + exit 0 → parse error → unavailable marker.
  const { deps } = makeDeps({ spawn, mediaDir: dir });
  const decision = await handlePromptBuild(
    { prompt: `[media attached: ${img} (image/jpeg)]` },
    { sessionKey: "agent:main:whatsapp:direct:+49x", channel: "whatsapp", trigger: "user" },
    deps,
  );
  assert.equal(decision.action, "prepend");
  assert.match((decision as { text: string }).text, /^\[Visual Memory\] Check nicht verfügbar/);
});

test("no image in message → no block delivered at all", async () => {
  const { spawn } = okSpawn();
  const { deps, enqueued } = makeDeps({ spawn });
  const decision = await handlePromptBuild(
    { prompt: "nur text" },
    { sessionKey: "agent:main:whatsapp:direct:+49x", channel: "whatsapp", trigger: "user" },
    deps,
  );
  assert.equal(decision.action, "no-image");
  assert.equal(enqueued.length, 0);
});

test("second prompt_fire same turn (trigger_manual) never double-checks or re-delivers", async () => {
  const { dir, file: img } = await fakeMediaImage();
  const { spawn, calls } = okSpawn();
  const { deps, diag } = makeDeps({ spawn, mediaDir: dir });
  const first = await handlePromptBuild(
    { prompt: `[media attached: ${img} (image/jpeg)]\nhi` },
    { sessionKey: "agent:main:whatsapp:direct:+49x", channel: "whatsapp", trigger: "user" },
    deps,
  );
  assert.equal(first.action, "prepend");
  // Host re-resolves the same turn ~300ms later with trigger=manual.
  const second = await handlePromptBuild(
    { prompt: `[media attached: ${img} (image/jpeg)]\nhi` },
    { sessionKey: "agent:main:whatsapp:direct:+49x", channel: "whatsapp", trigger: "manual" },
    deps,
  );
  // trigger_manual is a non-user trigger: no-image decision, nothing to
  // check again and no second block.
  assert.equal(second.action, "no-image");
  assert.equal(calls.n, 1, "exactly one vm.py run");
  assert.equal(diag.filter((r) => r.decision === "injected").length, 1, "exactly one delivery line");
  assert.ok(diag.some((r) => r.decision === "prompt_fire" && r.reason === "trigger_manual"));
});

test("registration wires message_received AND before_prompt_build with sync timeout budget", () => {
  const registered: Array<{ hook: string; opts?: { timeoutMs?: number } }> = [];
  const api: ApiLike = {
    pluginConfig: { checkTimeoutMs: 45000 },
    logger: {},
    session: { workflow: { enqueueNextTurnInjection: async () => {} } },
    on: ((hook: string, _h: unknown, opts?: { timeoutMs?: number }) => {
      registered.push({ hook, opts });
    }) as ApiLike["on"],
  };
  registerMessageHook(api, { diag: { record() {} } });
  assert.deepEqual(registered.map((r) => r.hook), ["message_received", "before_prompt_build"]);
  // The prompt hook registers the FULL synchronous window (Gateway waits,
  // operator order 30.09) plus grace — not a short fire-and-forget budget.
  assert.equal(registered[1]!.opts?.timeoutMs, 45000 + HOOK_GRACE_MS);
});

test("default registration grants the full 120s synchronous window (active-memory parity)", () => {
  const registered: Array<{ hook: string; opts?: { timeoutMs?: number } }> = [];
  const api: ApiLike = {
    logger: {},
    session: { workflow: { enqueueNextTurnInjection: async () => {} } },
    on: ((hook: string, _h: unknown, opts?: { timeoutMs?: number }) => {
      registered.push({ hook, opts });
    }) as ApiLike["on"],
  };
  registerMessageHook(api, { diag: { record() {} } });
  assert.equal(registered[1]!.opts?.timeoutMs, 120_000 + HOOK_GRACE_MS);
});

test("event.media[] observation never checks (prompt seam owns the turn)", async () => {
  const img = await fakeImage();
  const { spawn, calls } = okSpawn();
  const { deps, enqueued } = makeDeps({ spawn });
  const decision = handleMessageReceived(
    { messageId: "wa2", media: [{ path: img, kind: "image", contentType: "image/jpeg" }] },
    { sessionKey: "agent:main:whatsapp:direct:+49x", messageId: "wa2" },
    deps,
  );
  assert.equal(decision.action, "image-noted");
  assert.equal(calls.n, 0);
  assert.equal(enqueued.length, 0);
});
