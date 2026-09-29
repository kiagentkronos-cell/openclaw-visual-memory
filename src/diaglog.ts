/**
 * Decision-path diagnostics log.
 *
 * One line per decision so a silent delivery failure becomes visible without
 * a debugger. Metadata ONLY — never image paths, never message content,
 * never hit names (only counts). Rotation: append until the size cap, then
 * keep the newest half (line-aligned) so the file never grows unbounded.
 *
 * Decision vocabulary (exact names the handler logs):
 *   disabled | no_image | prompt_fire | staging_pending_skip | dedup_skip
 *   image_found | check_started | check_hits <N> | check_miss
 *   check_error <REASON> | check_timeout | injected | inject_failed
 *
 * `prompt_fire` is one line per before_prompt_build hook fire (the
 * channel-agnostic seam that also covers WhatsApp), whatever it decided. <REASON>
 *
 * Line format (single line, key=value, machine-greppable):
 *   2026-09-29T08:40:12.345Z msg=3EB0ABCD1234 channel=whatsapp decision=check_hits hits=1
 */

import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export type DiagKind =
  | "disabled"
  | "no_image"
  | "prompt_fire"
  | "staging_pending_skip"
  | "dedup_skip"
  | "image_found"
  | "check_started"
  | "check_hits"
  | "check_miss"
  | "check_error"
  | "check_timeout"
  | "injected"
  | "inject_failed";

/** One structured decision record; formatted into exactly one line. */
export interface DiagRecord {
  /** Shortened, PII-free message identity (see shortMessageId). */
  msgId: string;
  /** Channel id from the hook metadata (provider/surface), when present. */
  channel?: string;
  decision: DiagKind;
  /** Machine-readable reason (sanitized; never message content). */
  reason?: string;
  images?: number;
  hits?: number;
}

/** Sink interface so the handler never touches the filesystem directly. */
export interface DiagSink {
  record(rec: DiagRecord): void;
}

/**
 * PII-free short message identity: first 12 chars of the provider messageId;
 * when absent, a sha256 prefix of the content-derived fallback key (that key
 * contains message content and must never reach the log verbatim).
 */
export function shortMessageId(messageId: string | undefined, fallbackKey: string): string {
  const trimmed = typeof messageId === "string" ? messageId.trim() : "";
  if (trimmed.length > 0) {
    return trimmed.slice(0, 12);
  }
  return createHash("sha256").update(fallbackKey).digest("hex").slice(0, 12);
}

/** Keep one record to one line: only a safe character alphabet survives. */
function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 60);
}

/** Format one record into a single newline-terminated log line. */
export function formatDiagLine(now: Date, rec: DiagRecord): string {
  const parts = [now.toISOString(), `msg=${sanitize(rec.msgId)}`];
  if (rec.channel) {
    parts.push(`channel=${sanitize(rec.channel)}`);
  }
  parts.push(`decision=${rec.decision}`);
  if (typeof rec.images === "number") {
    parts.push(`images=${Math.trunc(rec.images)}`);
  }
  if (typeof rec.hits === "number") {
    parts.push(`hits=${Math.trunc(rec.hits)}`);
  }
  if (rec.reason) {
    parts.push(`reason=${sanitize(rec.reason)}`);
  }
  return `${parts.join(" ")}\n`;
}

/** No-op sink (unit tests that do not assert on the diagnostic log). */
export const NULL_DIAG_SINK: DiagSink = { record: () => {} };

/**
 * Append-only file sink with a size cap. When the file exceeds maxBytes, the
 * oldest half (rounded to a line boundary) is dropped, newest kept. All file
 * operations are serialized on an internal promise chain and every failure
 * is swallowed — diagnostics must never break or slow the message path.
 */
export class FileDiagSink implements DiagSink {
  private queue: Promise<void> = Promise.resolve();
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly now: () => number;
  constructor(filePath: string, maxBytes: number, now: () => number = Date.now) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    this.now = now;
  }

  record(rec: DiagRecord): void {
    const line = formatDiagLine(new Date(this.now()), rec);
    this.queue = this.queue.then(() => this.writeLine(line)).catch(() => {
      /* diagnostics failures are intentionally silent */
    });
  }

  /** Test seam: resolves once all queued writes have settled. */
  flush(): Promise<void> {
    return this.queue;
  }

  private async writeLine(line: string): Promise<void> {
    try {
      let size = 0;
      try {
        size = (await stat(this.filePath)).size;
      } catch {
        size = 0;
      }
      if (size > this.maxBytes) {
        await this.rotate();
      }
      await appendFile(this.filePath, line, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Log directory missing (fresh host, cleaned logs dir): create once
        // and retry the append.
        await mkdir(path.dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, line, "utf8");
        return;
      }
      throw err;
    }
  }

  private async rotate(): Promise<void> {
    const buf = await readFile(this.filePath);
    const tail = buf.subarray(Math.max(0, buf.length - Math.floor(this.maxBytes / 2)));
    // Drop a partial leading line so the file stays line-aligned.
    const firstNewline = tail.indexOf(0x0a);
    const keep = firstNewline >= 0 ? tail.subarray(firstNewline + 1) : tail;
    await writeFile(this.filePath, keep);
  }
}
