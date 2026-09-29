/**
 * vm.py check runner.
 *
 * The plugin never duplicates register logic: it shells out to the Visual
 * Memory CLI (`vm.py check <image>`) in the tool repository and parses its
 * single-line JSON output. Everything here is dependency-injected so tests
 * run fully offline with a fake spawner — the real GPU venv is never
 * invoked from tests.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { parseCheckOutput, type VmCheckOutcome } from "./injection.ts";

/** Minimal spawn surface so tests can inject a fake process. */
export interface SpawnHandle {
  stdout: AsyncIterable<string> | { on(event: "data", cb: (chunk: string) => void): void };
  stderr: { on(event: "data", cb: (chunk: string) => void): void };
  on(event: "close", cb: (code: number | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals | number): unknown;
}

export type SpawnFn = (command: string, args: string[]) => SpawnHandle;

export interface CheckerOptions {
  /** Absolute path to the python interpreter (venv). */
  pythonPath: string;
  /** Absolute path to vm.py. */
  scriptPath: string;
  /** Hard timeout per run; on expiry the process is killed and result is error. */
  timeoutMs: number;
  /** Skip images larger than this many bytes (0 disables). */
  maxSizeBytes: number;
  /** Skip images with mtime older than this many ms (0 disables). */
  maxAgeMs: number;
  /** Injected spawner (tests use a fake; production uses node:child_process). */
  spawn?: SpawnFn;
  /** Injected clock for age guard tests. */
  now?: () => number;
}

export type CheckResult =
  | VmCheckOutcome
  | { status: "skipped"; reason: string };

/** Real spawner: converts stdout to string chunks. */
export const defaultSpawn: SpawnFn = (command, args) => {
  const child = nodeSpawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    // Never open a shell — arguments go straight to execve.
    shell: false,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return child as unknown as SpawnHandle;
};

/**
 * Run `vm.py check <imagePath>` and map every failure mode (missing file,
 * oversized, stale, spawn error, timeout, non-zero exit, bad JSON) to an
 * outcome that injects nothing.
 */
export async function checkImage(
  imagePath: string,
  options: CheckerOptions,
): Promise<CheckResult> {
  // Guard: file must exist and be a sane size/age.
  let stats;
  try {
    stats = await stat(imagePath);
  } catch {
    return { status: "skipped", reason: "image file not readable" };
  }
  if (options.maxSizeBytes > 0 && stats.size > options.maxSizeBytes) {
    return { status: "skipped", reason: "image exceeds size guard" };
  }
  if (options.maxAgeMs > 0) {
    const now = (options.now ?? Date.now)();
    if (now - stats.mtimeMs > options.maxAgeMs) {
      return { status: "skipped", reason: "image older than age guard" };
    }
  }

  const spawn = options.spawn ?? defaultSpawn;
  return new Promise<CheckResult>((resolve) => {
    let settled = false;
    const finish = (result: CheckResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    let handle: SpawnHandle;
    try {
      handle = spawn(options.pythonPath, [options.scriptPath, "check", imagePath]);
    } catch (err) {
      finish({ status: "error", reason: `spawn failed: ${String(err)}` });
      return;
    }

    let stdout = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try {
        handle.kill("SIGKILL");
      } catch {
        /* kill failure is irrelevant: we already resolved as timeout. */
      }
      finish({ status: "error", reason: "check timed out" });
    }, options.timeoutMs);

    const onData = (chunk: string | Buffer) => {
      // Cap retained stdout to avoid unbounded memory from a chatty CLI.
      if (stdout.length < 64 * 1024) {
        stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      }
    };
    const out: any = handle.stdout;
    if (typeof out?.on === "function") {
      out.on("data", onData);
    }

    handle.on("error", (err: Error) => {
      clearTimeout(timer);
      finish({ status: "error", reason: `spawn error: ${err.message}` });
    });

    handle.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (killed) {
        return; // timeout already resolved
      }
      if (code !== 0) {
        finish({ status: "error", reason: `vm.py exited with code ${code}` });
        return;
      }
      finish(parseCheckOutput(stdout));
    });
  });
}
