import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handlePromptBuild, MessageLedger, type HandlerDeps } from "../src/handler.ts";
import {
  FileTranscriptSink,
  TRANSCRIPT_PREFIX,
  transcriptFileName,
  type TranscriptLine,
  type TranscriptSink,
} from "../src/transcript.ts";
import type { SpawnFn } from "../src/checker.ts";

/** Capture sink mirroring the file sink's line protocol for assertions. */
function captureTranscripts(): {
  runs: Array<{ meta: TranscriptLine; lines: TranscriptLine[] }>;
  sink: TranscriptSink;
} {
  const runs: Array<{ meta: TranscriptLine; lines: TranscriptLine[] }> = [];
  return {
    runs,
    sink: {
      begin(meta) {
        const run = { meta, lines: [] as TranscriptLine[] };
        runs.push(run);
        return {
          record: (line) => run.lines.push(line),
          done: (line) => run.lines.push({ type: "done", ...line }),
        };
      },
    },
  };
}

async function fakeMediaImage(name = "photo.jpg"): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "vmhook-t-"));
  const inbound = path.join(dir, "inbound");
  await mkdir(inbound, { recursive: true });
  const file = path.join(inbound, name);
  await writeFile(file, Buffer.alloc(8, 9));
  return { dir, file };
}

function spawnWith(stdout: string): SpawnFn {
  return () =>
    ({
      stdout: { on(_e: string, cb: (c: string) => void) { setImmediate(() => cb(stdout)); } },
      stderr: { on() {} },
      on(ev: string, cb: any) {
        if (ev === "close") setImmediate(() => cb(0));
      },
      kill() {},
    }) as never;
}

function makeDeps(overrides: Partial<HandlerDeps> & { spawn: SpawnFn }): HandlerDeps {
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
      transcriptDir: "/tmp/vm-hook-test-transcripts",
      transcriptMaxFiles: 200,
    },
    pythonPath: "/fake/python",
    scriptPath: "/fake/vm.py",
    log: { info() {}, warn() {}, error() {} },
    processed: new MessageLedger(),
    diag: { record() {} },
    schedule: (fn) => { fn(); return null; },
    fileExists: () => false,
    mediaDir: "/ws/media",
    enqueue: async () => {},
    ...overrides,
  };
  return deps;
}

test("transcript written per image run with hits (full reconstruction)", async () => {
  const { dir, file: img } = await fakeMediaImage();
  const cap = captureTranscripts();
  const deps = makeDeps({
    spawn: spawnWith('{"ok":true,"hits":[{"name":"Alice","kind":"person","score":0.72,"confidence":"certain"}]}'),
    transcripts: cap.sink,
    mediaDir: dir,
  });
  const decision = await handlePromptBuild(
    { prompt: `[media attached: ${img} (image/jpeg)]\nWer?` },
    { sessionKey: "agent:main:whatsapp:direct:+49x", channel: "whatsapp", trigger: "user" },
    deps,
  );
  assert.equal(decision.action, "prepend");
  assert.equal(cap.runs.length, 1);
  const { meta, lines } = cap.runs[0]!;
  assert.equal(meta.seam, "before_prompt_build");
  assert.equal(meta.trigger, "user");
  assert.equal(meta.channel, "whatsapp");
  assert.equal(meta.sessionKey, "agent:main:whatsapp:direct:+49x");
  const image = lines.find((l) => l.type === "image");
  assert.ok(image && typeof image.path === "string" && image.path === img);
  assert.ok(typeof image.pathhash === "string" && (image.pathhash as string).length === 16);
  const check = lines.find((l) => l.type === "check");
  assert.ok(check && check.status === "ok");
  const hits = check.hits as Array<Record<string, unknown>>;
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.name, "Alice");
  assert.equal(hits[0]!.kind, "person");
  assert.equal(hits[0]!.score, 0.72);
  assert.equal(hits[0]!.confidence, "certain");
  const inject = lines.find((l) => l.type === "inject");
  assert.ok(inject && String(inject.text).startsWith("[Visual Memory] Treffer: Alice"));
  const done = lines.find((l) => l.type === "done");
  // Synchronous same-turn delivery (operator order 30.09): the done line
  // is written by the prompt seam itself as injected_sync.
  assert.ok(done && done.decision === "injected_sync" && done.hitsTotal === 1);
  assert.equal(inject!.mode, "same_turn");
});

test("transcript written for hits=[] run — keine-Treffer block recorded verbatim", async () => {
  const { dir, file: img } = await fakeMediaImage();
  const cap = captureTranscripts();
  const deps = makeDeps({
    spawn: spawnWith('{"ok":true,"hits":[]}'),
    transcripts: cap.sink,
    mediaDir: dir,
  });
  await handlePromptBuild(
    { prompt: `[media attached: ${img} (image/jpeg)]` },
    { sessionKey: "agent:main:whatsapp:direct:+49x", channel: "whatsapp", trigger: "user" },
    deps,
  );
  assert.equal(cap.runs.length, 1);
  const check = cap.runs[0]!.lines.find((l) => l.type === "check");
  assert.deepEqual(check!.hits, []);
  const inject = cap.runs[0]!.lines.find((l) => l.type === "inject");
  assert.equal(inject!.text, "[Visual Memory] keine Treffer");
});

test("no image → no transcript opened", async () => {
  const cap = captureTranscripts();
  const deps = makeDeps({ spawn: spawnWith('{"ok":true,"hits":[]}'), transcripts: cap.sink });
  await handlePromptBuild(
    { prompt: "nur text" },
    { sessionKey: "s", channel: "whatsapp", trigger: "user" },
    deps,
  );
  assert.equal(cap.runs.length, 0);
});

test("engine error run records check error + unavailable inject line", async () => {
  const { dir, file: img } = await fakeMediaImage();
  const cap = captureTranscripts();
  const deps = makeDeps({ spawn: spawnWith("boom"), transcripts: cap.sink, mediaDir: dir });
  await handlePromptBuild(
    { prompt: `[media attached: ${img} (image/jpeg)]` },
    { sessionKey: "s", channel: "whatsapp", trigger: "user" },
    deps,
  );
  const check = cap.runs[0]!.lines.find((l) => l.type === "check");
  assert.equal(check!.status, "error");
  const inject = cap.runs[0]!.lines.find((l) => l.type === "inject");
  assert.match(String(inject!.text), /Check nicht verfügbar/);
});

test("file sink writes one JSONL per run and prunes to maxFiles", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vmhook-ts-"));
  let clock = Date.UTC(2026, 8, 30, 7, 0, 0);
  const sink = new FileTranscriptSink(dir, 3, () => {
    clock += 1000; // strictly increasing so filenames differ
    return clock;
  });
  for (let i = 0; i < 6; i += 1) {
    const run = sink.begin({ id: `r${i}`, images: 1 });
    run.record({ type: "check", status: "ok", hits: [] });
    run.done({ decision: "injected", hitsTotal: 0 });
    await sink.flush();
  }
  await sink.flush();
  const names = (await readdir(dir)).filter((n) => n.startsWith(TRANSCRIPT_PREFIX));
  assert.equal(names.length, 3, "pruned to newest 3");
  // Oldest gone, newest present:
  names.sort();
  const lines = (await readFileLines(path.join(dir, names[names.length - 1]!)));
  assert.equal(lines[0]!.type, "run");
  assert.ok(lines.some((l) => l.type === "check"));
  assert.equal(lines[lines.length - 1]!.type, "done");
});

async function readFileLines(p: string): Promise<TranscriptLine[]> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(p, "utf8");
  return text.trim().split("\n").map((l) => JSON.parse(l) as TranscriptLine);
}

test("transcript file names sort chronologically (prune order = time order)", () => {
  const a = transcriptFileName(Date.UTC(2026, 8, 30, 7, 0, 0));
  const b = transcriptFileName(Date.UTC(2026, 8, 30, 7, 0, 1));
  assert.ok(a < b, `${a} < ${b}`);
  assert.match(a, /^visual-memory-20260930T070000Z-[0-9a-f-]{8}\.jsonl$/);
});
