import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FileDiagSink,
  formatDiagLine,
  shortMessageId,
  type DiagRecord,
} from "../src/diaglog.ts";

test("shortMessageId truncates provider ids", () => {
  assert.equal(shortMessageId("3EB01234567890ABCDEF", "raw:x"), "3EB012345678");
});

test("shortMessageId hashes content-derived fallback keys (no content leak)", () => {
  const id = shortMessageId(undefined, "raw:session:mein geheimer Nachrichtentext");
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.ok(!id.includes("geheim"));
});

test("formatDiagLine: one line, key=value, PII-safe", () => {
  const line = formatDiagLine(new Date(0), {
    msgId: "3EB0abc",
    channel: "whatsapp",
    decision: "check_error",
    reason: "vm.py exited with code 2",
    images: 2,
    hits: 0,
  });
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.split("\n").length, 2, "exactly one line");
  assert.match(line, /^1970-01-01T00:00:00\.000Z msg=3EB0abc channel=whatsapp decision=check_error images=2 hits=0 reason=vm.py_exited_with_code_2\n$/);
});

test("formatDiagLine strips newlines and unsafe characters (one record = one line)", () => {
  const line = formatDiagLine(new Date(0), {
    msgId: "3EB0\nINJECTED fake line",
    channel: "wa\nats",
    decision: "inject_failed",
    reason: "Error: session\n gone",
  });
  const parts = line.trim().split("\n");
  assert.equal(parts.length, 1);
  // Newlines must be gone (no forged extra lines), replaced by safe chars.
  assert.ok(!line.includes("\nINJECTED"));
  assert.ok(!line.includes("wa\n"));
  assert.ok(!line.includes("session\n"));
  // Still exactly two spaces separating the five fields (no raw whitespace).
  assert.equal(parts[0]?.split(" ").length, 5);
});

test("formatDiagLine omits absent optional fields", () => {
  const line = formatDiagLine(new Date(0), { msgId: "m1", decision: "no_image" });
  assert.equal(line.trim(), "1970-01-01T00:00:00.000Z msg=m1 decision=no_image");
});

async function tmpLog(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "vmhook-diag-"));
  return path.join(dir, "sub", "hook.log");
}

test("FileDiagSink creates missing directories and appends lines", async () => {
  const file = await tmpLog();
  const sink = new FileDiagSink(file, 1_048_576, () => 12345);
  sink.record({ msgId: "a", decision: "no_image" });
  sink.record({ msgId: "b", decision: "injected", hits: 1 });
  await sink.flush();
  const text = await readFile(file, "utf8");
  const lines = text.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /msg=a decision=no_image/);
  assert.match(lines[1]!, /msg=b decision=injected hits=1/);
});

test("FileDiagSink rotation keeps the newest half, line-aligned", async () => {
  const file = await tmpLog();
  // Cap small enough that writes trigger rotation deterministically.
  const sink = new FileDiagSink(file, 400, () => 5);
  // Pre-fill beyond the cap with a known pattern (old_001 ... old_999 lines).
  await sink.flush(); // no-op, establishes the queue chain
  const dir = path.dirname(file);
  await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
  let filler = "";
  for (let i = 0; i < 20; i++) {
    filler += `OLD_LINE_${String(i).padStart(3, "0")} padding padding padding padding\n`;
  }
  await writeFile(file, filler);
  sink.record({ msgId: "new", decision: "injected" });
  await sink.flush();
  const st = await stat(file);
  assert.ok(st.size <= 400 + 120, `size after rotation ${st.size}`);
  const text = await readFile(file, "utf8");
  assert.match(text, /decision=injected/);
  // Every line in the file is complete (starts with a timestamp or OLD_LINE_).
  for (const line of text.trim().split("\n")) {
    assert.match(line, /^(1970-|OLD_LINE_)/);
  }
});

test("FileDiagSink never throws on unwritable paths (fire-and-forget)", async () => {
  // A path whose parent is a regular FILE: every fs call fails immediately
  // (ENOTDIR) without touching weird virtual paths. Must resolve regardless.
  const dir = await mkdtemp(path.join(tmpdir(), "vmhook-diag-bad-"));
  const blocker = path.join(dir, "blocker");
  await writeFile(blocker, "x");
  const sink = new FileDiagSink(path.join(blocker, "sub", "hook.log"), 1024, () => 1);
  sink.record({ msgId: "x", decision: "no_image" });
  await sink.flush(); // must resolve, not reject
});

test("record type stays metadata-only (compile guard)", () => {
  const rec: DiagRecord = { msgId: "m", channel: "whatsapp", decision: "check_hits", hits: 2 };
  // DiagRecord has no content/path/name fields by construction; assert the
  // formatted output contains nothing but the metadata we passed in.
  const line = formatDiagLine(new Date(0), rec);
  assert.equal(
    line.trim(),
    "1970-01-01T00:00:00.000Z msg=m channel=whatsapp decision=check_hits hits=2",
  );
});
