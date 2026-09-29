import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, utimes, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkImage, type SpawnFn, type SpawnHandle } from "../src/checker.ts";

/** Build a fake image file (content irrelevant — vm.py is mocked). */
async function fakeImage(sizeHint = 10): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "vmhook-"));
  const file = path.join(dir, "img.jpg");
  await writeFile(file, Buffer.alloc(sizeHint, 7));
  return file;
}

/** Fake spawner that replays canned stdout/exit codes without any process. */
function fakeSpawn(opts: {
  stdout?: string;
  code?: number;
  spawnError?: Error;
  hang?: boolean;
  onSpawn?: (args: string[]) => void;
}): { spawn: SpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: SpawnFn = (_command, args) => {
    calls.push([_command, ...args]);
    opts.onSpawn?.(args);
    const handlers = {
      data: [] as Array<(c: string) => void>,
      close: [] as Array<(c: number | null) => void>,
      error: [] as Array<(e: Error) => void>,
    };
    const handle: SpawnHandle = {
      stdout: {
        on(_ev, cb) {
          handlers.data.push(cb);
          if (!opts.hang && opts.stdout !== undefined) {
            setImmediate(() => cb(opts.stdout!));
          }
        },
      },
      stderr: { on() {} },
      on(ev, cb: any) {
        if (ev === "close") handlers.close.push(cb);
        if (ev === "error") handlers.error.push(cb);
        if (ev === "error" && opts.spawnError) setImmediate(() => cb(opts.spawnError!));
        if (ev === "close" && !opts.hang && !opts.spawnError) {
          setImmediate(() => cb(opts.code ?? 0));
        }
      },
      kill() {
        // hang simulation: kill does nothing, the timeout must resolve.
      },
    };
    return handle;
  };
  return { spawn, calls };
}

const base = (spawn: SpawnFn) => ({
  pythonPath: "/fake/venv/bin/python",
  scriptPath: "/fake/vm.py",
  timeoutMs: 250,
  maxSizeBytes: 0,
  maxAgeMs: 0,
  spawn,
});

test("check calls vm.py check with the image path as argv", async () => {
  const file = await fakeImage();
  const { spawn, calls } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const result = await checkImage(file, base(spawn));
  assert.deepEqual(result, { status: "ok", hits: [] });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["/fake/venv/bin/python", "/fake/vm.py", "check", file]);
});

test("hit JSON is parsed to ok outcome", async () => {
  const file = await fakeImage();
  const { spawn } = fakeSpawn({
    stdout: '{"ok":true,"hits":[{"name":"Alice","kind":"person","score":0.9,"confidence":"certain"}]}',
  });
  const result = await checkImage(file, base(spawn));
  assert.equal(result.status, "ok");
});

test("non-zero exit maps to error (no injection downstream)", async () => {
  const file = await fakeImage();
  const { spawn } = fakeSpawn({ stdout: "", code: 2 });
  const result = await checkImage(file, base(spawn));
  assert.equal(result.status, "error");
});

test("spawn error maps to error", async () => {
  const file = await fakeImage();
  const { spawn } = fakeSpawn({ spawnError: new Error("ENOENT") });
  const result = await checkImage(file, base(spawn));
  assert.equal(result.status, "error");
});

test("timeout resolves as error even when process never closes", async () => {
  const file = await fakeImage();
  const { spawn } = fakeSpawn({ hang: true });
  const result = await checkImage(file, { ...base(spawn), timeoutMs: 60 });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.match(result.reason, /timed out/);
  }
});

test("missing image file is skipped without spawning", async () => {
  const { spawn, calls } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const result = await checkImage("/nonexistent/img.jpg", base(spawn));
  assert.equal(result.status, "skipped");
  assert.equal(calls.length, 0);
});

test("oversized image is skipped without spawning", async () => {
  const file = await fakeImage(50);
  const { spawn, calls } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const result = await checkImage(file, { ...base(spawn), maxSizeBytes: 10 });
  assert.equal(result.status, "skipped");
  assert.equal(calls.length, 0);
});

test("stale image is skipped without spawning", async () => {
  const file = await fakeImage();
  const past = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(file, past, past);
  const { spawn, calls } = fakeSpawn({ stdout: '{"ok":true,"hits":[]}' });
  const result = await checkImage(file, { ...base(spawn), maxAgeMs: 60_000 });
  assert.equal(result.status, "skipped");
  assert.equal(calls.length, 0);
});

test("unreadable script path still resolves as error not hang", async () => {
  const file = await fakeImage();
  // Simulate a spawner that throws synchronously (bad interpreter path).
  const spawn: SpawnFn = () => {
    throw new Error("bad interpreter");
  };
  const result = await checkImage(file, base(spawn));
  assert.equal(result.status, "error");
});

// Keep the unused-import lint honest: chmod referenced for future fixtures.
void chmod;
