import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleMessageReceived, MessageLedger, type HandlerDeps } from "../src/handler.ts";
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

test("CLI failure → explicit unavailable injection (never silence)", async () => {
  const image = await fakeImage();
  const { spawn } = fakeSpawn({ stdout: "boom", code: 1 });
  const { deps, enqueued } = makeDeps({ spawn });
  const decision = handleMessageReceived(
    { messageId: "m-fail", media: [{ kind: "image", path: image }] },
    { sessionKey: "s1" },
    deps,
  );
  if (decision.action === "queued") await decision.check;
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]!.text, "[Visual Memory] Check nicht verfügbar (fehler: exit_code)");
});

test("staging-pending without media → skip now, retry probes originals, later staged event dedupes", async () => {
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
  scheduled[0]!();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.calls, 1);
  assert.equal(enqueued.length, 1);
  // A real staged event afterwards → deduped against the retry's claim.
  const d2 = handleMessageReceived(
    { messageId: "m-stage", media: [{ kind: "image", path: image }] },
    { sessionKey: "s1" },
    deps,
  );
  assert.equal(d2.action, "duplicate");
  assert.equal(calls.calls, 1);
  assert.equal(enqueued.length, 1);
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
  await new Promise((r) => setTimeout(r, 5));
  // Never readable → no check ever, no error-log flood, one quiet skip line.
  assert.equal(calls.calls, 0);
  assert.equal(logs.length, 0);
  const skipLines = diag.filter((r) => r.decision === "staging_pending_skip");
  assert.equal(skipLines.length, 2, "initial skip + one retry give-up");
  assert.equal(skipLines[1]?.reason, "retry_not_readable");
  // No further scheduling happened.
  assert.equal(scheduled.length, 1);
});

test("staging retry dedupes when a real staged event claimed first", async () => {
  const image = await fakeImage();
  const { spawn, calls } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const { deps, scheduled, diag } = makeDeps({ spawn, fileExists: () => true });
  handleMessageReceived(
    {
      messageId: "m-race",
      mediaStagingPending: true,
      originalMedia: [{ kind: "image", path: image }],
    },
    { sessionKey: "s1" },
    deps,
  );
  // Hypothetical real staged event arrives BEFORE the retry fires.
  const d2 = handleMessageReceived(
    { messageId: "m-race", media: [{ kind: "image", path: image }] },
    { sessionKey: "s1" },
    deps,
  );
  assert.equal(d2.action, "queued");
  if (d2.action === "queued") await d2.check;
  scheduled[0]!();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.calls, 1, "retry must not double-check");
  assert.ok(diag.some((r) => r.decision === "dedup_skip"));
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
      stagingRetryMs: 5000,
      mediaDir: "/ws/media",
      diagLogPath: "/tmp/vm-hook-test-diag.log",
      transcriptDir: "/tmp/vm-hook-test-transcripts",
      transcriptMaxFiles: 200,
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

test("image without session key → skipped, no injection, nothing claimed", async () => {
  const image = await fakeImage();
  const { spawn, calls } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const { deps, enqueued } = makeDeps({ spawn });
  const decision = handleMessageReceived(
    { messageId: "m-nosess", media: [{ kind: "image", path: image }] },
    {},
    deps,
  );
  assert.equal(decision.action, "no-image");
  assert.equal(enqueued.length, 0);
  // Hardening (Hyperion review 1c4c01d, Minor-2): without a sessionKey the
  // handler must claim NOTHING — neither the message key nor the image
  // path — so a later delivery that does resolve a session still gets
  // checked instead of silently deduping against an unchecked claim.
  assert.equal(deps.processed.has("id:m-nosess"), false, "message key must stay unclaimed");
  assert.equal(deps.processed.hasPath(image), false, "image path must stay unclaimed");
  // Same message again WITH a session → still checked (not deduped).
  const again = handleMessageReceived(
    { messageId: "m-nosess", media: [{ kind: "image", path: image }] },
    { sessionKey: "s1" },
    deps,
  );
  assert.equal(again.action, "queued");
  if (again.action === "queued") await again.check;
  assert.equal(calls.calls, 1);
  assert.equal(enqueued.length, 1);
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

test("host refusal (enqueued:false) surfaces as inject_failed, not injected", async () => {
  const image = await fakeImage();
  const { spawn } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const logs: string[] = [];
  const { deps, diag } = makeDeps({
    spawn,
    enqueue: async () => ({ enqueued: false }),
    log: { info() {}, warn() {}, error: (m) => logs.push(m) },
  });
  const decision = handleMessageReceived(
    { messageId: "m-refuse", media: [{ kind: "image", path: image }] },
    { sessionKey: "s1" },
    deps,
  );
  if (decision.action === "queued") await decision.check;
  const inject = diag.filter((r) => r.decision === "injected" || r.decision === "inject_failed");
  assert.equal(inject.length, 1);
  assert.equal(inject[0]!.decision, "inject_failed");
  assert.equal(inject[0]!.reason, "host_refused");
  assert.ok(logs.some((l) => l.includes("enqueue refused")));
});

test("decision path logs exactly one line per decision, metadata-only (no PII)", async () => {
  const image = await fakeImage();
  const { spawn } = fakeSpawn({
    stdout: '{"ok":true,"hits":[{"name":"Alice","kind":"person","score":0.9,"confidence":"certain"}]}',
  });
  const { deps, diag } = makeDeps({ spawn });
  handleMessageReceived(
    {
      messageId: "m-pii",
      content: "Geheimer Nachrichtentext mit privaten Details",
      media: [{ kind: "image", path: image }],
      metadata: { provider: "whatsapp" },
    },
    { sessionKey: "s1" },
    deps,
  );
  await new Promise((r) => setTimeout(r, 10));
  const decisions = diag.map((r) => r.decision);
  // One greppable trail for a successful image message.
  assert.deepEqual(decisions, ["image_found", "check_started", "check_hits", "injected"]);
  // No record may carry message content, paths, or hit names.
  const serialized = JSON.stringify(diag);
  assert.ok(!serialized.includes("Geheimer"));
  assert.ok(!serialized.includes(image), "image path must never be logged");
  assert.ok(!serialized.includes("Alice"), "hit names must never be logged");
  assert.equal(diag[0]!.channel, "whatsapp");
  assert.equal(diag[0]!.msgId, "m-pii");
});

test("failure path: check_error lands in the diag trail, unavailable marker injected", async () => {
  const image = await fakeImage();
  const { spawn } = fakeSpawn({ stdout: "boom", code: 3 });
  const { deps, diag, enqueued } = makeDeps({ spawn });
  const decision = handleMessageReceived(
    { messageId: "m-err", media: [{ kind: "image", path: image }] },
    { sessionKey: "s1" },
    deps,
  );
  if (decision.action === "queued") await decision.check;
  const err = diag.find((r) => r.decision === "check_error");
  assert.ok(err, "check_error recorded");
  assert.equal(err.reason, "exit_code");
  // Protocol: the agent is told the state is UNKNOWN (marker, hits=0).
  assert.equal(enqueued.length, 1);
  assert.match(enqueued[0]!.text, /Check nicht verfügbar \(fehler: exit_code\)/);
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
