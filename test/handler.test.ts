import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  handleMessageReceived,
  handlePromptBuild,
  MessageLedger,
  type HandlerDeps,
  type HandlerDecision,
} from "../src/handler.ts";
import type { SpawnFn } from "../src/checker.ts";
import type { DiagRecord } from "../src/diaglog.ts";

/** Capture sink for the decision-path diagnostics. */
export function captureDiag(): { records: DiagRecord[]; sink: import("../src/diaglog.ts").DiagSink } {
  const records: DiagRecord[] = [];
  return {
    records,
    sink: { record: (r) => records.push(r) },
  };
}

async function fakeImage(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "vmhook-h-"));
  const file = path.join(dir, "photo.jpg");
  await writeFile(file, Buffer.alloc(8, 9));
  return file;
}

/**
 * Image inside a fresh temp media dir — prompt-note gate (only paths under
 * the configured media dir survive note parsing), so prompt-seam fixtures
 * must live inside it. Mirrors the WhatsApp layout: <mediaDir>/inbound/.
 */
async function fakeMediaImage(name = "photo.jpg"): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "vmhook-hm-"));
  const inbound = path.join(dir, "inbound");
  await mkdir(inbound, { recursive: true });
  const file = path.join(inbound, name);
  await writeFile(file, Buffer.alloc(8, 9));
  return { dir, file };
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

/** Prompt-seam invocation: user turn carrying a media note for `file`. */
function promptWith(file: string): { event: { prompt: string }; ctx: { sessionKey: string; channel: string; trigger: string } } {
  return {
    event: { prompt: `[media attached: ${file} (image/jpeg)]\nWer ist das?` },
    ctx: { sessionKey: "agent:main:whatsapp:direct:+49x", channel: "whatsapp", trigger: "user" },
  };
}

const makeDeps = (
  overrides: Partial<HandlerDeps> & { spawn: SpawnFn },
): {
  deps: HandlerDeps;
  enqueued: Array<{ sessionKey: string; text: string; idempotencyKey: string }>;
  diag: DiagRecord[];
  scheduled: Array<() => void>;
} => {
  const enqueued: Array<{ sessionKey: string; text: string; idempotencyKey: string }> = [];
  const diagCap = captureDiag();
  const scheduled: Array<() => void> = [];
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
      mediaDir: "/ws/media",
      diagLogPath: "/tmp/vm-hook-test-diag.log",
      transcriptDir: "/tmp/vm-hook-test-transcripts",
      transcriptMaxFiles: 200,
    },
    pythonPath: "/fake/python",
    scriptPath: "/fake/vm.py",
    log: { info() {}, warn() {}, error() {} },
    processed: new MessageLedger(),
    diag: diagCap.sink,
    schedule: (fn) => {
      scheduled.push(fn);
      return null;
    },
    fileExists: () => false,
    enqueue: async (p) => {
      enqueued.push(p);
    },
    ...overrides,
  };
  return { deps, enqueued, diag: diagCap.records, scheduled };
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

test("message_received observes images but never checks (prompt seam owns delivery)", async () => {
  const image = await fakeImage();
  const { spawn, calls } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const { deps, enqueued, diag } = makeDeps({ spawn });
  const decision = handleMessageReceived(
    { content: "", messageId: "m-note", media: [{ kind: "image", path: image }] },
    { sessionKey: "s1" },
    deps,
  );
  assert.equal(decision.action, "image-noted");
  assert.equal(calls.calls, 0, "no GPU work in the message seam");
  assert.equal(enqueued.length, 0, "no enqueue from observation");
  assert.ok(diag.some((r) => r.decision === "image_found"));
  // Paths stay unclaimed: the prompt seam of the same turn must still check.
  assert.equal(deps.processed.hasPath(image), false);
});

test("prompt seam delivers synchronously: prependContext with hits (operator order 30.09)", async () => {
  const { dir, file } = await fakeMediaImage();
  const { spawn, calls } = fakeSpawn({
    stdout: '{"ok":true,"hits":[{"name":"Alice","kind":"person","score":0.93,"confidence":"certain","scope":"private"}]}',
  });
  const { deps, diag } = makeDeps({ spawn, mediaDir: dir });
  const p = promptWith(file);
  const decision: HandlerDecision = await handlePromptBuild(p.event, p.ctx, deps);
  assert.equal(decision.action, "prepend");
  assert.equal((decision as { text: string }).text, "[Visual Memory] Treffer: Alice (person, certain, 0.93)");
  assert.equal(calls.calls, 1);
  // Same-turn delivery never touches the enqueue API (root cause 3 immune).
  assert.ok(diag.some((r) => r.decision === "injected" && r.reason === "same_turn"));
});

test("prompt seam: empty hits → synchronous keine Treffer", async () => {
  const { dir, file } = await fakeMediaImage();
  const { spawn } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const { deps } = makeDeps({ spawn, mediaDir: dir });
  const p = promptWith(file);
  const decision = await handlePromptBuild(p.event, p.ctx, deps);
  assert.equal(decision.action, "prepend");
  assert.equal((decision as { text: string }).text, "[Visual Memory] keine Treffer");
});

test("prompt seam: CLI failure → synchronous unavailable marker (never silence)", async () => {
  const { dir, file } = await fakeMediaImage();
  const { spawn } = fakeSpawn({ stdout: "boom", code: 1 });
  const { deps } = makeDeps({ spawn, mediaDir: dir });
  const p = promptWith(file);
  const decision = await handlePromptBuild(p.event, p.ctx, deps);
  assert.equal(decision.action, "prepend");
  assert.equal((decision as { text: string }).text, "[Visual Memory] Check nicht verfügbar (fehler: exit_code)");
});

test("prompt seam: check past deadline → timeout marker, bounded wait (hard cap)", async () => {
  const { dir, file } = await fakeMediaImage();
  // vm.py answers after 200ms but the whole budget is 60ms.
  const { spawn } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}', delayMs: 200 });
  const { deps, diag } = makeDeps({
    spawn,
    mediaDir: dir,
    config: {
      ...makeDeps({ spawn }).deps.config,
      checkTimeoutMs: 60,
    },
  });
  const p = promptWith(file);
  const started = Date.now();
  const decision = await handlePromptBuild(p.event, p.ctx, deps);
  const elapsed = Date.now() - started;
  assert.equal(decision.action, "prepend");
  assert.equal((decision as { text: string }).text, "[Visual Memory] Check nicht verfügbar (timeout)");
  assert.ok(elapsed < 150, `bounded by the 60ms budget (+slack), took ${elapsed}ms`);
  assert.ok(diag.some((r) => r.decision === "check_timeout"));
});

test("staging-pending without media → skip now, retry probes originals, result enqueues next turn", async () => {
  const image = await fakeImage();
  const { spawn, calls } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const { deps, enqueued, scheduled } = makeDeps({ spawn, fileExists: () => true });
  // First event: staging pending, only originalMedia (docs: NOT locally readable).
  const d1 = handleMessageReceived(
    {
      messageId: "m-stage",
      mediaStagingPending: true,
      originalMedia: [{ kind: "image", path: image }],
    },
    { sessionKey: "s1" },
    deps,
  );
  assert.equal(d1.action, "staging-pending");
  assert.equal(calls.calls, 0);
  assert.equal(scheduled.length, 1, "exactly one retry scheduled");
  // Run the scheduled retry: the existence probe passes (fake true) → check.
  // This is the ONLY remaining next-turn-enqueue path (files missed the prompt).
  scheduled[0]!();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.calls, 1);
  assert.equal(enqueued.length, 1);
  assert.match(enqueued[0]!.text, /keine Treffer/);
});

test("staging-pending with unreadable originals → exactly one retry, then quiet", async () => {
  const { spawn, calls } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const logs: string[] = [];
  const { deps, scheduled, diag } = makeDeps({
    spawn,
    fileExists: () => false,
    log: { info() {}, warn() {}, error: (m) => logs.push(m) },
  });
  const d1 = handleMessageReceived(
    {
      messageId: "m-remote",
      mediaStagingPending: true,
      originalMedia: [{ kind: "image", url: "https://wa.example/x.jpg", path: "\\\\nas\\share\\x.jpg" }],
    },
    { sessionKey: "s1" },
    deps,
  );
  assert.equal(d1.action, "staging-pending");
  assert.equal(scheduled.length, 1);
  scheduled[0]!();
  await new Promise((r) => setTimeout(r, 10));
  // Never readable → no check ever, no error-log flood, one quiet skip line.
  assert.equal(calls.calls, 0);
  assert.equal(logs.length, 0);
  const skipLines = diag.filter((r) => r.decision === "staging_pending_skip");
  assert.equal(skipLines.length, 2, "initial skip + one retry give-up");
  assert.equal(skipLines[1]?.reason, "retry_not_readable");
  // No further scheduling happened.
  assert.equal(scheduled.length, 1);
});

test("staging retry dedupes when the prompt seam claimed the path first", async () => {
  const { dir, file } = await fakeMediaImage();
  const { spawn, calls } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const { deps, enqueued, scheduled, diag } = makeDeps({
    spawn,
    fileExists: () => true,
    mediaDir: dir,
  });
  handleMessageReceived(
    {
      messageId: "m-race",
      mediaStagingPending: true,
      originalMedia: [{ kind: "image", path: file }],
    },
    { sessionKey: "agent:main:whatsapp:direct:+49x" },
    deps,
  );
  // The prompt note of the SAME turn arrives BEFORE the retry fires.
  const p = promptWith(file);
  const d2 = await handlePromptBuild(p.event, p.ctx, deps);
  assert.equal(d2.action, "prepend");
  assert.equal(calls.calls, 1);
  // Retry fires afterwards: paths already claimed → dedup, no second check.
  scheduled[0]!();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.calls, 1, "retry must not double-check");
  assert.equal(enqueued.length, 0, "prompt seam delivered; retry drops silently");
  assert.ok(diag.some((r) => r.decision === "dedup_skip"));
});

test("prompt path claimed once → second fire dedupes (no re-check, no re-delivery)", async () => {
  const { dir, file } = await fakeMediaImage();
  const { spawn, calls } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const { deps } = makeDeps({ spawn, mediaDir: dir });
  const p = promptWith(file);
  const d1 = await handlePromptBuild(p.event, p.ctx, deps);
  assert.equal(d1.action, "prepend");
  const d2 = await handlePromptBuild(p.event, p.ctx, deps);
  assert.equal(d2.action, "duplicate");
  assert.equal(calls.calls, 1);
});

test("non-user triggers (cron/heartbeat/manual) never check", async () => {
  const { dir, file } = await fakeMediaImage();
  const { spawn, calls } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const { deps } = makeDeps({ spawn, mediaDir: dir });
  for (const trigger of ["cron", "heartbeat", "manual"]) {
    const d = await handlePromptBuild(
      { prompt: `[media attached: ${file} (image/jpeg)]` },
      { sessionKey: "s1", channel: "whatsapp", trigger },
      deps,
    );
    assert.equal(d.action, "no-image", `trigger=${trigger}`);
  }
  assert.equal(calls.calls, 0);
  // The path is still unclaimed → a later USER turn still gets checked.
  const p = promptWith(file);
  const d = await handlePromptBuild(p.event, p.ctx, deps);
  assert.equal(d.action, "prepend");
  assert.equal(calls.calls, 1);
});

test("disabled config → nothing happens", async () => {
  const { dir, file } = await fakeMediaImage();
  const { spawn, calls } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const { deps } = makeDeps({
    spawn,
    mediaDir: dir,
    config: {
      ...makeDeps({ spawn }).deps.config,
      enabled: false,
    },
  });
  const p = promptWith(file);
  let decision = await handlePromptBuild(p.event, p.ctx, deps);
  assert.equal(decision.action, "disabled");
  const d2 = handleMessageReceived(
    { messageId: "m-off", media: [{ kind: "image", path: file }] },
    { sessionKey: "s1" },
    deps,
  );
  assert.equal(d2.action, "disabled");
  assert.equal(calls.calls, 0);
});

test("prompt image without session key → skipped, nothing claimed", async () => {
  const { dir, file } = await fakeMediaImage();
  const { spawn, calls } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const { deps } = makeDeps({ spawn, mediaDir: dir });
  const decision = await handlePromptBuild(
    { prompt: `[media attached: ${file} (image/jpeg)]` },
    { channel: "whatsapp", trigger: "user" },
    deps,
  );
  assert.equal(decision.action, "no-image");
  assert.equal(calls.calls, 0);
  assert.equal(deps.processed.hasPath(file), false, "path must stay unclaimed");
  // Same file on a turn WITH a session → still checked (not deduped).
  const p = promptWith(file);
  const again = await handlePromptBuild(p.event, p.ctx, deps);
  assert.equal(again.action, "prepend");
  assert.equal(calls.calls, 1);
});

test("multiple images in one prompt → one merged synchronous block", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vmhook-hm2-"));
  const inbound = path.join(dir, "inbound");
  await mkdir(inbound, { recursive: true });
  const aFile = path.join(inbound, "a.jpg");
  const bFile = path.join(inbound, "b.jpg");
  await writeFile(aFile, Buffer.alloc(8, 9));
  await writeFile(bFile, Buffer.alloc(8, 9));
  const outputs = [
    '{"ok":true,"hits":[{"name":"Anna","kind":"person","score":0.9,"confidence":"certain"}]}',
    '{"ok":true,"hits":[{"name":"Bello","kind":"animal","score":0.86,"confidence":"possible"}]}',
  ];
  let i = 0;
  const spawn: SpawnFn = () => {
    const stdout = outputs[Math.min(i++, outputs.length - 1)]!;
    return {
      stdout: { on(_e: string, cb: (c: string) => void) { setImmediate(() => cb(stdout)); } },
      stderr: { on() {} },
      on(ev: string, cb: any) {
        if (ev === "close") setImmediate(() => cb(0));
      },
      kill() {},
    } as never;
  };
  const { deps } = makeDeps({ spawn, mediaDir: dir });
  const decision = await handlePromptBuild(
    { prompt: `[media attached: ${aFile} (image/jpeg)]\n[media attached: ${bFile} (image/jpeg)]` },
    { sessionKey: "s1", channel: "whatsapp", trigger: "user" },
    deps,
  );
  assert.equal(decision.action, "prepend");
  assert.equal(
    (decision as { text: string }).text,
    "[Visual Memory] Treffer: Anna (person, certain, 0.90); Bello (animal, possible, 0.86)",
  );
});

test("staging retry: enqueue failure is logged, never thrown", async () => {
  const image = await fakeImage();
  const { spawn } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const logs: string[] = [];
  const { deps, scheduled } = makeDeps({
    spawn,
    fileExists: () => true,
    enqueue: async () => {
      throw new Error("session gone");
    },
    log: { info() {}, warn() {}, error: (m) => logs.push(m) },
  });
  handleMessageReceived(
    { messageId: "m-enq", mediaStagingPending: true, originalMedia: [{ kind: "image", path: image }] },
    { sessionKey: "s1" },
    deps,
  );
  scheduled[0]!(); // must not throw
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(logs.some((l) => l.includes("enqueue failed")));
});

test("staging retry: host refusal (enqueued:false) logs inject_failed (root cause 3 visible)", async () => {
  const image = await fakeImage();
  const { spawn } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const logs: string[] = [];
  const { deps, scheduled, diag } = makeDeps({
    spawn,
    fileExists: () => true,
    enqueue: async () => ({ enqueued: false }),
    log: { info() {}, warn() {}, error: (m) => logs.push(m) },
  });
  handleMessageReceived(
    { messageId: "m-refuse", mediaStagingPending: true, originalMedia: [{ kind: "image", path: image }] },
    { sessionKey: "s1" },
    deps,
  );
  scheduled[0]!();
  await new Promise((r) => setTimeout(r, 10));
  const inject = diag.filter((r) => r.decision === "injected" || r.decision === "inject_failed");
  assert.equal(inject.length, 1);
  assert.equal(inject[0]!.decision, "inject_failed");
  assert.equal(inject[0]!.reason, "host_refused");
  assert.ok(logs.some((l) => l.includes("enqueue refused")));
});

test("synchronous path logs exactly one decision trail, metadata-only (no PII)", async () => {
  const { dir, file } = await fakeMediaImage();
  const { spawn } = fakeSpawn({
    stdout: '{"ok":true,"hits":[{"name":"Alice","kind":"person","score":0.9,"confidence":"certain"}]}',
  });
  const { deps, diag } = makeDeps({ spawn, mediaDir: dir });
  const p = promptWith(file);
  await handlePromptBuild(p.event, { ...p.ctx, channel: "whatsapp" }, deps);
  const decisions = diag.map((r) => r.decision);
  // One greppable trail for a successful synchronous image turn.
  assert.deepEqual(decisions, [
    "prompt_fire",
    "image_found",
    "check_started",
    "check_hits",
    "injected",
  ]);
  // No record may carry message content, paths, or hit names.
  const serialized = JSON.stringify(diag);
  assert.ok(!serialized.includes("Wer ist das"));
  assert.ok(!serialized.includes(file), "image path must never be logged");
  assert.ok(!serialized.includes("Alice"), "hit names must never be logged");
  assert.equal(diag[0]!.channel, "whatsapp");
});

test("failure path: check_error lands in the diag trail, unavailable marker delivered", async () => {
  const { dir, file } = await fakeMediaImage();
  const { spawn } = fakeSpawn({ stdout: "boom", code: 3 });
  const { deps, diag } = makeDeps({ spawn, mediaDir: dir });
  const p = promptWith(file);
  const decision = await handlePromptBuild(p.event, p.ctx, deps);
  const err = diag.find((r) => r.decision === "check_error");
  assert.ok(err, "check_error recorded");
  assert.equal(err.reason, "exit_code");
  // Protocol: the agent is told the state is UNKNOWN (marker, hits=0).
  assert.equal(decision.action, "prepend");
  assert.match((decision as { text: string }).text, /Check nicht verfügbar \(fehler: exit_code\)/);
  assert.equal(diag.find((r) => r.decision === "injected")?.hits, 0);
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
