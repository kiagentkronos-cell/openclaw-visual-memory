/**
 * message_received handler logic (framework-free core).
 *
 * Behaviour contract (docs/plugins/hooks/messages.md) + host reality check
 * (dispatch-from-config, verified 2026-09-29):
 * - Image facts arrive typed via event.media[] (path/kind/contentType).
 * - The docs say that when mediaStagingPending is true, event.media is
 *   withheld and "a later staged event" delivers the readable paths. Host
 *   reality: message_received is emitted EXACTLY ONCE per accepted inbound
 *   turn (emitMessageReceivedHooks in dispatch-from-config) — waiting for a
 *   second event therefore never fires. The flag is also gated on
 *   ctx.MediaRemoteHost, so locally-saved channel media (WhatsApp
 *   media/inbound) never even sets it. Both shapes are handled here:
 *   media[] present -> normal path; media withheld for any reason -> ONE
 *   delayed, existence-guarded retry over originalMedia (a path that is
 *   already readable locally proceeds to the check; a true remote path
 *   gives up quietly after exactly one attempt). Whatever runs the check
 *   claims the messageId in the ledger, so a hypothetical real staged
 *   event still dedupes against it.
 * - The GPU check may take seconds: the handler itself must never await it
 *   into the message flow beyond the hook budget. The caller decides how to
 *   run it (fire-and-forget with completion -> next-turn injection).
 * - Every decision appends exactly one PII-free line to the diagnostic sink
 *   (see diaglog.ts) so silent failures (host-side enqueue refusals,
 *   missing events) are greppable after the fact.
 */

import { localImagePaths, type MediaFactLike } from "./media.ts";
import { buildInjectionText, type VmCheckOutcome, type VmHit } from "./injection.ts";
import { checkImage, type CheckResult, type SpawnFn } from "./checker.ts";
import type { VmCheckConfig } from "./config.ts";
import { shortMessageId, type DiagKind, type DiagSink } from "./diaglog.ts";

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
 * result means the injection was refused WITHOUT throwing (e.g. session
 * entry not found). Treat it as a visible inject_failed, never as success. */
export interface EnqueueResultLike {
  enqueued?: unknown;
}

export interface HandlerDeps {
  config: VmCheckConfig;
  /** Resolved absolute python + script paths. */
  pythonPath: string;
  scriptPath: string;
  spawn?: SpawnFn;
  now?: () => number;
  /** Enqueue text for the next turn of this session (host API in production). */
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
  /**
   * Scheduler for the staging-pending retry. Production uses setTimeout;
   * tests inject a fake clock. Returns a cancellable handle we do not use
   * (dup-ledger covers cancellation).
   */
  schedule: (fn: () => void, delayMs: number) => unknown;
  /** Existence probe for staged-original guard (fs.existsSync in production). */
  fileExists: (p: string) => boolean;
}

/** Short-lived ledger of message keys already handled (bounded). */
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

  has(key: string): boolean {
    return this.seen.has(key);
  }
}

/** What the handler decided, for observability and tests. */
export type HandlerDecision =
  | { action: "disabled" }
  | { action: "no-image"; reason?: "no_session" }
  | { action: "staging-pending" }
  | { action: "duplicate" }
  | { action: "queued"; check: Promise<void> };

/**
 * Handle one message_received event. Returns synchronously with a decision;
 * the (slow) check runs detached in `check` and injects its result through
 * deps.enqueue when it completes. Never throws.
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

  // Staging not finished: media[] is withheld by design. The docs promise a
  // later staged event, but the host emits message_received only once per
  // accepted turn (emitMessageReceivedHooks; no second emission exists for
  // the staged revision) — so waiting never fires. Schedule ONE guarded
  // retry instead. The retry claims the key only after its existence probe
  // finds readable files, so a genuine staged event (should the host ever
  // emit one) still owns the check and the retry dedupes against it.
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

  if (!deps.processed.claim(key)) {
    log("dedup_skip");
    return { action: "duplicate" };
  }
  log("image_found", { images: images.length });

  const sessionKey = resolveSessionKey(event, ctx);
  if (!sessionKey) {
    // Without a session there is no next turn to inject into.
    deps.log.warn("visual-memory: image message without resolvable sessionKey; skipped");
    log("no_image", { reason: "no_session" });
    return { action: "no-image", reason: "no_session" };
  }

  log("check_started", { images: images.length });
  const check = runCheckAndInject(images, sessionKey, key, msgId, channel, deps);
  return { action: "queued", check };
}

/**
 * Staging-pending fallback (runs once via deps.schedule). Docs: do NOT treat
 * originalMedia.path as locally readable — so probe existence first. If the
 * channel already wrote the file locally (WhatsApp media/inbound), the path
 * is readable at retry time and the check proceeds; if it is a true remote
 * path, the probe fails and we give up after exactly one attempt (documented
 * impossibility, no second event exists). Never logs the path itself.
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
  // A real staged event may have claimed the key in the meantime.
  if (!deps.processed.claim(key)) {
    log("dedup_skip");
    return;
  }
  log("check_started", { images: images.length });
  void runCheckAndInject(images, sessionKey, key, msgId, channel, deps).catch(() => {
    /* logged inside */
  });
}

/** Run every image check (sequentially - GPU friendly) and inject once. */
async function runCheckAndInject(
  images: string[],
  sessionKey: string,
  messageKeyStr: string,
  msgId: string,
  channel: string | undefined,
  deps: HandlerDeps,
): Promise<void> {
  const log = (decision: DiagKind, extra?: { reason?: string; hits?: number }) =>
    deps.diag.record({ msgId, channel, decision, ...extra });

  const outcomes: CheckResult[] = [];
  for (const image of images) {
    outcomes.push(
      await checkImage(image, {
        pythonPath: deps.pythonPath,
        scriptPath: deps.scriptPath,
        timeoutMs: deps.config.checkTimeoutMs,
        maxSizeBytes: deps.config.maxImageSizeBytes,
        maxAgeMs: deps.config.maxImageAgeMs,
        spawn: deps.spawn,
        now: deps.now,
      }),
    );
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
  try {
    const result = await deps.enqueue({
      sessionKey,
      text,
      // One injection per message+session: covers re-delivery of the same
      // message and lets the host dedupe pending entries.
      idempotencyKey: `visual-memory:${sessionKey}:${messageKeyStr}`,
      ttlMs: deps.config.injectionTtlMs,
    });
    // The host refuses WITHOUT throwing ({ enqueued: false }) when the
    // session entry is missing or policy blocks it — surface that here or
    // the failure stays invisible (root cause of the silent 29.09 incident).
    if (result && typeof result === "object" && result.enqueued === false) {
      log("inject_failed", { reason: "host_refused" });
      deps.log.error("visual-memory: enqueue refused by host (enqueued=false)");
      return;
    }
    log("injected", {
      hits: outcome.status === "ok" ? outcome.hits.length : 0,
    });
  } catch (err) {
    log("inject_failed", { reason: reasonToken(String(err)) });
    deps.log.error(`visual-memory: enqueue failed (${String(err)})`);
  }
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
