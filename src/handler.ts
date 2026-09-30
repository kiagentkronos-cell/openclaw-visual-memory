/**
 * Handler logic for the visual-memory hook (framework-free core).
 *
 * Delivery contract (operator order 2026-09-30 10:17, binding):
 * the Gateway WAITS for this plugin during before_prompt_build, exactly
 * like it waits for Active Memory ("Active Memory darf bis zu 2 Minuten
 * dauern. Das Gateway wartet auf Fertigstellung."). The prompt seam
 * therefore AWAITS the vm.py check synchronously and returns the
 * [Visual Memory] block as prependContext IN THE SAME PROMPT. Total time
 * budget: config.checkTimeoutMs (default 120000 — active-memory's
 * MAX_TIMEOUT_MS is 120000 as well); each per-image run gets the REMAINING
 * budget and the whole chain is hard-capped, so the hook always returns a
 * block (hits / keine Treffer / explicit timeout marker) — never an
 * eternal wait. Registration passes { timeoutMs } with the same budget
 * (docs/plugins/hooks/reference.md: api.on opts timeoutMs; operators may
 * override per plugin up to 600000).
 *
 * Seam ownership:
 * - before_prompt_build is the ONLY seam that runs checks. It fires for
 *   every admitted user turn on every channel (WhatsApp privacy-suppresses
 *   message_received for plugins unless opted in — docs/channels/
 *   whatsapp.md — and history re-projects old `[media attached: ...]`
 *   notes, so every candidate path is claimed in the ledger before
 *   checking: a path seen once is never re-checked.
 * - message_received only OBSERVES (logs image_found) and handles the
 *   staging-pending edge: media withheld -> ONE delayed, existence-
 *   guarded retry over originalMedia (the host emits message_received
 *   exactly once per turn — waiting for a second event never fires;
 *   dispatch-from-config, verified 2026-09-29). That retry lands AFTER
 *   the current prompt was built, so it is the only user of the next-turn
 *   enqueue. If the host refuses that enqueue ({ enqueued: false } without
 *   throwing — root cause 3), the line logs inject_failed; this
 *   best-effort fallback may drop, the synchronous path may not.
 * - Every decision appends exactly one PII-free line to the diagnostic
 *   sink (see diaglog.ts) so silent failures are greppable after the fact.
 */

import path from "node:path";
import { localImagePaths, type MediaFactLike } from "./media.ts";
import { promptImageFacts, type ParseContext } from "./promptmedia.ts";
import { buildInjectionText, type VmCheckOutcome, type VmHit } from "./injection.ts";
import { checkImage, type CheckResult, type SpawnFn } from "./checker.ts";
import type { VmCheckConfig } from "./config.ts";
import { shortMessageId, type DiagKind, type DiagSink } from "./diaglog.ts";
import { NULL_TRANSCRIPT_SINK, type TranscriptRun, type TranscriptSink } from "./transcript.ts";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

export interface ReceivedEventLike {
  content?: string;
  messageId?: string;
  sessionKey?: string;
  media?: MediaFactLike[];
  originalMedia?: MediaFactLike[];
  mediaStagingPending?: boolean;
  metadata?: { provider?: string; surface?: string };
}

export interface ReceivedContextLike {
  sessionKey?: string;
  messageId?: string;
}

/** before_prompt_build event shape (docs/plugins/hooks/prompt-and-session). */
export interface PromptBuildEventLike {
  prompt?: string;
  currentUserMessage?: string;
  messages?: unknown[];
}

/** before_prompt_build context: agent hook ctx carries channel + trigger. */
export interface PromptBuildContextLike {
  sessionKey?: string;
  channel?: string;
  channelId?: string;
  trigger?: string;
}

/** Session key resolution: event first, then context (docs: both may carry it). */
export function resolveSessionKey(
  event: ReceivedEventLike,
  ctx: ReceivedContextLike,
): string | undefined {
  return event.sessionKey ?? ctx.sessionKey;
}

/** Idempotency key for one inbound message; falls back to a content-based key. */
export function messageKey(event: ReceivedEventLike, ctx: ReceivedContextLike): string {
  const id = event.messageId ?? ctx.messageId;
  if (typeof id === "string" && id.length > 0) {
    return `id:${id}`;
  }
  // No stable id: fall back to session + content identity.
  return `raw:${resolveSessionKey(event, ctx) ?? "?"}:${event.content ?? ""}`;
}

/** Channel label for diagnostics: metadata.provider, then metadata.surface. */
function channelLabel(event: ReceivedEventLike): string | undefined {
  const provider = event.metadata?.provider;
  if (typeof provider === "string" && provider.length > 0) {
    return provider;
  }
  const surface = event.metadata?.surface;
  return typeof surface === "string" && surface.length > 0 ? surface : undefined;
}

/** Enqueue result surface: the host returns { enqueued: boolean }; a false
 * result means the injection was refused WITHOUT throwing. Only the
 * staging-retry fallback still uses enqueue (best effort). */
export interface EnqueueResultLike {
  enqueued?: unknown;
}

/** Where a finished block went (staging-retry fallback only). */
export type DeliveryOutcome = "enqueued" | "dropped";

export interface HandlerDeps {
  config: VmCheckConfig;
  /** Resolved absolute python + script paths. */
  pythonPath: string;
  scriptPath: string;
  spawn?: SpawnFn;
  now?: () => number;
  /** Next-turn enqueue — ONLY the staging-retry fallback uses this now;
   * the prompt seam delivers synchronously via prependContext. */
  enqueue: (params: {
    sessionKey: string;
    text: string;
    idempotencyKey: string;
    ttlMs: number;
  }) => Promise<EnqueueResultLike | void>;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  /** In-memory processed-message store; injected so tests control it. */
  processed: MessageLedger;
  /** Decision-path diagnostics (metadata only). */
  diag: DiagSink;
  /** Per-run JSONL transcripts (Active-Memory analogue; deep reconstruction). */
  transcripts?: TranscriptSink;
  /**
   * Scheduler for the staging-pending retry. Production uses setTimeout;
   * tests inject a fake clock. Returns a cancellable handle we do not use
   * (dup-ledger covers cancellation).
   */
  schedule: (fn: () => void, delayMs: number) => unknown;
  /** Existence probe for staged-original guard (fs.existsSync in production). */
  fileExists: (p: string) => boolean;
  /** Media store root for media://inbound prompt-note aliases. */
  mediaDir?: string;
}

/**
 * Short-lived ledger of message keys AND image paths already handled
 * (bounded). Path claims stop prompt-note re-projection (and the host's
 * same-turn re-resolve with trigger=manual) from retriggering checks on
 * attachments already seen.
 */
export class MessageLedger {
  private readonly seen = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  constructor(opts?: { maxEntries?: number; now?: () => number }) {
    this.maxEntries = opts?.maxEntries ?? 500;
    this.now = opts?.now ?? Date.now;
  }

  /** True (and records) when the key has NOT been seen before. */
  claim(key: string): boolean {
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.set(key, this.now());
    if (this.seen.size > this.maxEntries) {
      // Drop oldest insertion (Map preserves insertion order).
      const oldest = this.seen.keys().next();
      if (!oldest.done) {
        this.seen.delete(oldest.value);
      }
    }
    return true;
  }

  /** Claim an absolute image path (path-keyed namespace `path:`). */
  claimPath(imagePath: string): boolean {
    return this.claim(`path:${imagePath}`);
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  hasPath(imagePath: string): boolean {
    return this.seen.has(`path:${imagePath}`);
  }
}

/** Result once the vm.py checks are done, ready for same-turn delivery. */
export interface CheckDone {
  text: string;
  hitsTotal: number;
  run: TranscriptRun;
  startedAt: number;
}

/** What the handler decided, for observability and tests. */
export type HandlerDecision =
  | { action: "disabled" }
  | { action: "no-image"; reason?: "no_session" }
  | { action: "staging-pending" }
  | { action: "duplicate" }
  /** message_received saw image facts; the prompt seam owns the check. */
  | { action: "image-noted" }
  /** Synchronous same-turn delivery: prepend text to THIS prompt. */
  | { action: "prepend"; text: string };

/**
 * Handle one message_received event. Observes image facts (the check runs
 * in the prompt seam of the same turn) and schedules the single guarded
 * staging retry when media was withheld. Never throws, never awaits I/O.
 */
export function handleMessageReceived(
  event: ReceivedEventLike,
  ctx: ReceivedContextLike,
  deps: HandlerDeps,
): HandlerDecision {
  const key = messageKey(event, ctx);
  const msgId = shortMessageId(event.messageId ?? ctx.messageId, key);
  const channel = channelLabel(event);
  const log = (decision: DiagKind, extra?: { reason?: string; images?: number; hits?: number }) =>
    deps.diag.record({ msgId, channel, decision, ...extra });

  if (!deps.config.enabled) {
    log("disabled");
    return { action: "disabled" };
  }

  // Staging not finished: media[] is withheld by design. The host emits
  // message_received only once per accepted turn (emitMessageReceivedHooks;
  // no second emission exists for the staged revision) — so waiting for a
  // "later staged event" never fires. Schedule ONE guarded retry instead;
  // its files land after the current prompt was built, so that retry is
  // the sole remaining user of the next-turn enqueue.
  if (event.mediaStagingPending === true && !Array.isArray(event.media)) {
    log("staging_pending_skip", {
      images: Array.isArray(event.originalMedia) ? event.originalMedia.length : 0,
    });
    const sessionKey = resolveSessionKey(event, ctx);
    const originals = Array.isArray(event.originalMedia) ? event.originalMedia : [];
    if (sessionKey) {
      deps.schedule(() => {
        retryStagedOriginals(originals, sessionKey, key, msgId, channel, deps);
      }, deps.config.stagingRetryMs);
    }
    return { action: "staging-pending" };
  }

  const images = localImagePaths(event.media);
  if (images.length === 0) {
    log("no_image");
    return { action: "no-image" };
  }

  // Observation only: the before_prompt_build seam of the SAME turn claims
  // these paths and delivers synchronously. Checking here as well would
  // double GPU work or race the synchronous delivery.
  log("image_found", { images: images.length });
  return { action: "image-noted" };
}

/**
 * Handle one before_prompt_build event SYNCHRONOUSLY (the operator's
 * 30.09. order: the Gateway waits for the check like it waits for Active
 * Memory). Images arrive as `[media attached: ...]` notes in the prompt.
 * Decisions:
 * - always ONE `prompt_fire` diag line (fire+decision, even when no image —
 *   greppable trigger evidence on every channel),
 * - only user-trigger runs get checked (when the host provides the field):
 *   cron/heartbeat turns carry re-projected history notes, not fresh
 *   attachments,
 * - every candidate path is claimed in the ledger first; a path already
 *   checked (re-projected old note, same-turn re-fire) dedupes to
 *   `duplicate`, never a second vm.py run,
 * - the check chain is hard-capped at config.checkTimeoutMs (remaining
 *   budget per image); on expiry the block says Check nicht verfügbar
 *   (timeout) instead of waiting further.
 * Resolves with { action: "prepend"; text } when this turn owns a check.
 * Never rejects.
 */
export async function handlePromptBuild(
  event: PromptBuildEventLike,
  ctx: PromptBuildContextLike,
  deps: HandlerDeps,
): Promise<HandlerDecision> {
  const channel = ctx.channel ?? ctx.channelId;
  const msgId = "promptbuild";
  const log = (decision: DiagKind, extra?: { reason?: string; images?: number; hits?: number }) =>
    deps.diag.record({ msgId, channel, decision, ...extra });

  if (!deps.config.enabled) {
    log("disabled");
    return { action: "disabled" };
  }

  // Fire+decision on EVERY prompt hook invocation, image or not.
  log("prompt_fire", ctx.trigger ? { reason: `trigger_${ctx.trigger}` } : undefined);

  // Non-user triggers never introduce fresh inbound attachments; their
  // prompt may still contain old media notes from history projection.
  if (ctx.trigger !== undefined && ctx.trigger !== "user") {
    return { action: "no-image" };
  }

  const promptText =
    typeof event.currentUserMessage === "string" && event.currentUserMessage.length > 0
      ? event.currentUserMessage
      : event.prompt ?? "";
  const facts = promptImageFacts(promptText, noteParseContext(deps));
  const images = facts
    .map((fact) => fact.path)
    .filter((p): p is string => typeof p === "string" && p.length > 0);
  if (images.length === 0) {
    return { action: "no-image" };
  }

  const sessionKey = ctx.sessionKey;
  if (!sessionKey) {
    deps.log.warn("visual-memory: prompt image without resolvable sessionKey; skipped");
    log("no_image", { reason: "no_session", images: images.length });
    return { action: "no-image", reason: "no_session" };
  }

  // Claim paths; deliver only when this invocation newly claimed them.
  const fresh = images.filter((p) => deps.processed.claimPath(p));
  if (fresh.length === 0) {
    log("dedup_skip", { images: images.length });
    return { action: "duplicate" };
  }

  // Idempotency key from the newly-claimed paths: stable per image set even
  // if the prompt note reappears later.
  const key = `path:${fresh.join(",")}`;
  log("image_found", { images: fresh.length });
  log("check_started", { images: fresh.length });

  const result = await runChecks(fresh, sessionKey, key, msgId, channel, deps, {
    seam: "before_prompt_build",
    trigger: ctx.trigger,
  });
  const { text, hitsTotal, run, startedAt } = result;

  // Same-turn delivery: the caller returns `text` as prependContext. The
  // transcript records the injection exactly once, here.
  run.record({
    type: "inject",
    text,
    idempotencyKey: `visual-memory:${sessionKey}:${key}`,
    mode: "same_turn",
  });
  run.done({
    decision: "injected_sync",
    hitsTotal,
    durationMs: (deps.now ?? Date.now)() - startedAt,
  });
  log("injected", { hits: hitsTotal, reason: "same_turn" });
  return { action: "prepend", text };
}

/**
 * Note-parsing context for prompt seams: media:// aliases resolve against
 * the state media dir; local note paths may live under EITHER the state
 * media dir or the workspace media dir (WhatsApp writes inbound images
 * into <workspaceDir>/media/inbound on this host — root cause 2).
 */
function noteParseContext(deps: HandlerDeps): ParseContext {
  const mediaDir = deps.mediaDir ?? deps.config.mediaDir;
  allowedMediaDirs(deps).length; // keep helper usage explicit for readers
  const allowedDirs = allowedMediaDirs(deps);
  return { mediaDir, allowedDirs };
}

function allowedMediaDirs(deps: HandlerDeps): string[] {
  const mediaDir = deps.mediaDir ?? deps.config.mediaDir;
  const allowedDirs = [mediaDir];
  if (typeof deps.config.workspaceDir === "string" && deps.config.workspaceDir.length > 0) {
    const workspaceMedia = path.join(deps.config.workspaceDir, "media");
    if (!allowedDirs.some((d) => path.resolve(d) === path.resolve(workspaceMedia))) {
      allowedDirs.push(workspaceMedia);
    }
  }
  return allowedDirs;
}

/**
 * Staging-pending fallback (runs once via deps.schedule). Docs: do NOT treat
 * originalMedia.path as locally readable — so probe existence first. If the
 * channel already wrote the file locally (WhatsApp media/inbound), the path
 * is readable at retry time and the check proceeds; if it is a true remote
 * path, the probe fails and we give up after exactly one attempt (documented
 * impossibility, no second event exists). This is the ONLY remaining user
 * of the next-turn enqueue (the files missed the current prompt); a host
 * refusal there logs inject_failed and drops (best effort).
 * Never logs the path itself.
 */
function retryStagedOriginals(
  originals: MediaFactLike[],
  sessionKey: string,
  key: string,
  msgId: string,
  channel: string | undefined,
  deps: HandlerDeps,
): void {
  const log = (decision: DiagKind, extra?: { reason?: string; images?: number }) =>
    deps.diag.record({ msgId, channel, decision, ...extra });
  const images: string[] = [];
  for (const fact of originals) {
    if (
      typeof fact.path === "string" &&
      fact.path.length > 0 &&
      deps.fileExists(fact.path) &&
      (fact.kind === undefined || fact.kind === "image")
    ) {
      images.push(fact.path);
    }
  }
  if (images.length === 0) {
    // Exactly one attempt, then quiet (documented host limitation — there
    // is no second event to wait for; nothing further to log).
    log("staging_pending_skip", { reason: "retry_not_readable" });
    return;
  }
  // A prompt-seam run may have claimed the paths in the meantime (staged
  // note already in the prompt): then the synchronous delivery owns it.
  const fresh = images.filter((p) => deps.processed.claimPath(p));
  if (fresh.length === 0) {
    log("dedup_skip");
    return;
  }
  log("check_started", { images: fresh.length });
  void deliverViaNextTurn(fresh, sessionKey, key, msgId, channel, deps, {
    seam: "staging_retry",
  }).catch(() => {
    /* logged inside */
  });
}

/**
 * Staging-retry only: run the checks, then enqueue for the NEXT turn
 * (this seam cannot modify any prompt). Enqueue refusals (host_refused)
 * and throws log inject_failed and drop the block — this fallback is best
 * effort by design; the synchronous prompt path never uses enqueue.
 */
async function deliverViaNextTurn(
  images: string[],
  sessionKey: string,
  key: string,
  msgId: string,
  channel: string | undefined,
  deps: HandlerDeps,
  transcriptMeta?: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  const log = (decision: DiagKind, extra?: { reason?: string; hits?: number }) =>
    deps.diag.record({ msgId, channel, decision, ...extra });
  const result = await runChecks(images, sessionKey, key, msgId, channel, deps, transcriptMeta);
  const { text, hitsTotal, run, startedAt } = result;
  const elapsed = () => (deps.now ?? Date.now)() - startedAt;
  const idempotencyKey = `visual-memory:${sessionKey}:${key}`;
  run.record({ type: "inject", text, idempotencyKey, mode: "next_turn", ttlMs: deps.config.injectionTtlMs });
  try {
    const res = await deps.enqueue({
      sessionKey,
      text,
      // One injection per message+session: covers re-delivery of the same
      // message and lets the host dedupe pending entries.
      idempotencyKey,
      ttlMs: deps.config.injectionTtlMs,
    });
    // The host refuses WITHOUT throwing ({ enqueued: false }): policy
    // grant, lifecycle authority, bad params, unresolvable session entry,
    // duplicate key, 32/session cap (dist host map, 30.09). Best effort ->
    // log and drop.
    if (res && typeof res === "object" && res.enqueued === false) {
      log("inject_failed", { reason: "host_refused" });
      deps.log.error("visual-memory: staging-retry enqueue refused by host (enqueued=false)");
      run.done({ decision: "inject_failed", reason: "host_refused", hitsTotal, durationMs: elapsed() });
      return "dropped";
    }
    log("injected", { hits: hitsTotal, reason: "next_turn" });
    run.done({ decision: "injected", hitsTotal, durationMs: elapsed() });
    return "enqueued";
  } catch (err) {
    log("inject_failed", { reason: reasonToken(String(err)) });
    deps.log.error(`visual-memory: staging-retry enqueue failed (${String(err)})`);
    run.done({ decision: "inject_failed", reason: reasonToken(String(err)), hitsTotal, durationMs: elapsed() });
    return "dropped";
  }
}

/** Run every image check (sequentially - GPU friendly) under a HARD total
 * deadline: the whole chain must resolve within config.checkTimeoutMs so
 * the synchronous hook always returns a block. Each run gets the REMAINING
 * budget; once the deadline passes, the rest resolve as timeout errors
 * without spawning. Delivery is the caller's job (same-turn prepend or,
 * for the staging retry, next-turn enqueue). */
async function runChecks(
  images: string[],
  sessionKey: string,
  messageKeyStr: string,
  msgId: string,
  channel: string | undefined,
  deps: HandlerDeps,
  transcriptMeta?: Record<string, unknown>,
): Promise<CheckDone> {
  const log = (decision: DiagKind, extra?: { reason?: string; hits?: number }) =>
    deps.diag.record({ msgId, channel, decision, ...extra });

  // Deep per-run transcript (Active-Memory analogue, operator order 30.09).
  const run: TranscriptRun = (deps.transcripts ?? NULL_TRANSCRIPT_SINK).begin({
    id: `vmrun-${shortMessageId(messageKeyStr, messageKeyStr)}`,
    seam: "check",
    channel,
    sessionKey,
    images: images.length,
    ...transcriptMeta,
  });
  const startedAt = (deps.now ?? Date.now)();
  const deadlineAt = startedAt + deps.config.checkTimeoutMs;

  // Image identity lines: path + content-free hash + stat only, never bytes.
  for (const image of images) {
    const info: Record<string, unknown> = {
      type: "image",
      path: image,
      // pathhash, NOT a content hash: identity of the note path for dedupe
      // forensics; the image bytes are never read into the transcript.
      pathhash: createHash("sha256").update(image).digest("hex").slice(0, 16),
    };
    try {
      const st = await stat(image);
      info.sizeBytes = st.size;
      info.mtimeMs = st.mtimeMs;
    } catch {
      info.exists = false;
    }
    run.record(info);
  }

  const outcomes: CheckResult[] = [];
  for (const image of images) {
    const checkStarted = (deps.now ?? Date.now)();
    const remaining = deadlineAt - checkStarted;
    if (remaining <= 0) {
      // Total budget exhausted before this image: honest timeout, no spawn.
      outcomes.push({ status: "error", reason: "check timed out" });
      run.record({ type: "check", path: image, status: "error", reason: "deadline exhausted", durationMs: 0 });
      continue;
    }
    const result = await checkImage(image, {
      pythonPath: deps.pythonPath,
      scriptPath: deps.scriptPath,
      timeoutMs: remaining,
      maxSizeBytes: deps.config.maxImageSizeBytes,
      maxAgeMs: deps.config.maxImageAgeMs,
      spawn: deps.spawn,
      now: deps.now,
    });
    outcomes.push(result);
    const checkLine: Record<string, unknown> = {
      type: "check",
      path: image,
      status: result.status,
      durationMs: (deps.now ?? Date.now)() - checkStarted,
    };
    if (result.status === "ok") checkLine.hits = result.hits;
    else checkLine.reason = result.reason;
    run.record(checkLine);
  }

  // One line per check outcome so every image's fate is greppable.
  let unavailableReason: string | undefined;
  for (const o of outcomes) {
    if (o.status === "ok") {
      if (o.hits.length > 0) {
        log("check_hits", { hits: o.hits.length });
      } else {
        log("check_miss");
      }
    } else if (o.status === "error") {
      unavailableReason ??= o.reason;
      if (o.reason === "check timed out") {
        log("check_timeout");
      } else {
        log("check_error", { reason: reasonToken(o.reason) });
      }
      // Keep the human-readable detail in the plugin logger (dev/null risk
      // aside, it is the only place the raw reason may appear).
      deps.log.error(`visual-memory: check failed (${o.reason})`);
    } else {
      unavailableReason ??= o.reason;
      log("check_error", { reason: reasonToken(o.reason) });
      deps.log.info(`visual-memory: check skipped (${o.reason})`);
    }
  }

  // Protocol (operator protocol 2026-09-29): every processed image message injects
  // exactly one line. A failed check must NOT look like "keine Treffer" —
  // it injects the explicit "Check nicht verfügbar" marker so the agent
  // knows the state is UNKNOWN and must not re-check manually (double GPU
  // work). If ANY image check could not run, the merged result is only
  // partially known -> report the failure marker (truth over optimism).
  const failed = outcomes.filter((o) => o.status !== "ok");
  let outcome: VmCheckOutcome;
  if (failed.length > 0) {
    // First failure wins the token; skipped outcomes carry their own reason.
    outcome = { status: "error", reason: unavailableReason ?? "check unavailable" };
  } else {
    // Merge hits across images, dedupe by name+kind, keep best score.
    const best = new Map<string, VmHit>();
    for (const o of outcomes) {
      if (o.status !== "ok") continue;
      for (const hit of o.hits) {
        const id = `${hit.name} ${hit.kind}`;
        const prev = best.get(id);
        if (!prev || (hit.score ?? -1) > (prev.score ?? -1)) {
          best.set(id, hit);
        }
      }
    }
    outcome = { status: "ok", hits: [...best.values()] };
  }
  const text = buildInjectionText(outcome);
  const hitsTotal = outcome.status === "ok" ? outcome.hits.length : 0;
  return { text, hitsTotal, run, startedAt };
}

/** Map a free-form error reason to a compact greppable token. */
function reasonToken(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("timed out") || r.includes("timeout")) return "timeout";
  if (r.includes("not readable")) return "file_not_readable";
  if (r.includes("size guard")) return "too_large";
  if (r.includes("age guard")) return "too_old";
  if (r.includes("spawn error") || r.includes("spawn failed")) return "spawn_error";
  if (r.includes("exited")) return "exit_code";
  if (r.includes("json") || r.includes("empty output")) return "bad_output";
  if (r.includes("reported failure")) return "vm_failure";
  return "error";
}
