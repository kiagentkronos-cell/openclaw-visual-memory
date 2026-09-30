/**
 * Per-run transcripts (operator order 2026-09-30: "Visual Memory muss
 * genauso nachvollziehbar loggen wie Active Memory").
 *
 * Active Memory writes one JSONL transcript per run
 * (~/.openclaw/plugins/active-memory/transcripts/...); this is the VM
 * analogue: one file per PROCESSED image run under
 * ~/.openclaw/plugins/visual-memory/transcripts/, one JSON object per
 * line:
 *
 *   {"type":"run", id, ts, seam, channel, sessionKey, trigger, images}
 *   {"type":"fire", ...}          — extra context the seam learned later
 *   {"type":"image", path, pathhash, sizeBytes, mtimeMs} (path+hash only, NEVER image bytes;
 *                                                          pathhash = sha256 over the PATH string, not file content)
 *   {"type":"check", path, status, hits|reason, durationMs}  (vm.py stdout as parsed hits JSON incl. scores)
 *   {"type":"inject", text, idempotencyKey, ttlMs}      (verbatim injected block; the enqueue verdict lands in done.decision)
 *   {"type":"done", decision, hitsTotal, durationMs}
 *
 * The decision-path diaglog (diaglog.ts) stays the fast grep-able one-liner
 * log covering EVERY fire including no-image turns; transcripts are the
 * deep per-run reconstruction and are only opened when a check actually
 * runs.
 *
 * Retention: after each run starts, the sink prunes the directory to the
 * newest `maxFiles` transcript files (filename order = UTC timestamp order,
 * oldest first deleted). Active Memory's 26k-file pile is the cautionary
 * example — VM keeps a small, self-trimming window.
 *
 * Failures: every filesystem error is swallowed (same contract as
 * FileDiagSink) — transcripts must never break or slow the message path.
 */

import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** One transcript line; `ts` is stamped by the sink. */
export type TranscriptLine = Record<string, unknown>;

/** Handle for one run; record() appends, done() closes with a summary. */
export interface TranscriptRun {
  record(line: TranscriptLine): void;
  done(line: TranscriptLine): void;
}

/** Sink interface so the handler never touches the filesystem directly. */
export interface TranscriptSink {
  /** Opens (or lazily prepares) the transcript file for one run. */
  begin(meta: TranscriptLine): TranscriptRun;
}

/** No-op sink (unit tests that inject their own capture sink). */
export const NULL_TRANSCRIPT_SINK: TranscriptSink = {
  begin: () => ({ record() {}, done() {} }),
};

/** File name prefix; also the prune filter. */
export const TRANSCRIPT_PREFIX = "visual-memory-";

/** UTC-sortable file stem: visual-memory-20260930T071245Z-1a2b3c4d.jsonl */
export function transcriptFileName(nowMs: number): string {
  const iso = new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return `${TRANSCRIPT_PREFIX}${iso}-${randomUUID().slice(0, 8)}.jsonl`;
}

/**
 * File sink: one JSONL per run + newest-N pruning. All writes are
 * serialized on an internal promise chain (same pattern as FileDiagSink);
 * every failure is swallowed.
 */
export class FileTranscriptSink implements TranscriptSink {
  private queue: Promise<void> = Promise.resolve();
  private readonly dir: string;
  private readonly maxFiles: number;
  private readonly now: () => number;

  constructor(dir: string, maxFiles: number, now: () => number = Date.now) {
    this.dir = dir;
    this.maxFiles = Math.max(1, Math.trunc(maxFiles));
    this.now = now;
  }

  /** Test seam: resolves once all queued writes have settled. */
  flush(): Promise<void> {
    return this.queue;
  }

  begin(meta: TranscriptLine): TranscriptRun {
    const fileName = transcriptFileName(this.now());
    const filePath = path.join(this.dir, fileName);
    let closed = false;
    const writeLine = (obj: Record<string, unknown>): void => {
      const stamped = JSON.stringify(obj);
      this.queue = this.queue
        .then(async () => {
          try {
            await appendFile(filePath, stamped + "\n", "utf8");
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              await mkdir(this.dir, { recursive: true });
              await appendFile(filePath, stamped + "\n", "utf8");
            }
          }
        })
        .catch(() => {
          /* transcript failures are intentionally silent */
        });
    };
    const append = (line: TranscriptLine): void => {
      if (closed) return;
      writeLine({ ts: new Date(this.now()).toISOString(), ...line });
    };
    // Header goes through the queue; pruning happens at done() so a
    // finished file is never truncated mid-run.
    this.queue = this.queue
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        await appendFile(filePath, JSON.stringify({ type: "run", ts: new Date(this.now()).toISOString(), ...meta }) + "\n", "utf8");
      })
      .catch(() => {
        /* silent */
      });
    return {
      record: append,
      done: (line) => {
        if (closed) return;
        closed = true;
        writeLine({ ts: new Date(this.now()).toISOString(), type: "done", ...line });
        // Prune only after the run is complete: the current file must be
        // fully written before it participates in the newest-N selection.
        this.queue = this.queue.then(() => this.prune()).catch(() => undefined);
      },
    };
  }

  /** Keep the newest maxFiles transcripts (lexicographic order = time order). */
  private async prune(): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((n) => n.startsWith(TRANSCRIPT_PREFIX) && n.endsWith(".jsonl"));
    } catch {
      return;
    }
    if (names.length <= this.maxFiles) return;
    names.sort();
    const doomed = names.slice(0, names.length - this.maxFiles);
    await Promise.all(
      doomed.map((n) => unlink(path.join(this.dir, n)).catch(() => undefined)),
    );
  }
}
