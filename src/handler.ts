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
 *
 * Second seam (WhatsApp root cause, 2026-09-29): the WhatsApp channel plugin
 * does NOT emit `message_received` for plugin hooks unless the operator
 * opts in via channels.whatsapp.pluginHooks.messageReceived (docs/channels/
 * whatsapp.md "Plugin hooks and privacy"; monitor: suppressMessageReceived
 * Hooks = true by default). Webchat proved the handler itself works; on
 * WhatsApp it was never invoked. The fix adds handlePromptBuild on
 * `before_prompt_build`, the channel-agnostic agent-turn hook that fires
 * for EVERY admitted turn. Inbound image paths arrive there as
 * `[media attached: ...]` prompt notes (src/promptmedia.ts). Because
 * history re-projects old notes into later prompts, the check claims each
 * IMAGE PATH in the ledger — a path seen once is never re-checked,
 * whichever seam saw it first.
 *
 * Root cause 2 (2026-09-30, silent WhatsApp path): the seam DID fire
 * (prompt_fire trigger_user + trigger_manual per image message) but never
 * reached image_found — real WhatsApp notes carry paths under
 * <workspaceDir>/media/inbound/ (e.g. openclaw-media-TIMESTAMP-RAND.jpg
 * DIRECTLY there, no openclaw-staged subfolder) while the note gate only
 * allowed the state media dir (<stateDir>/media). Every real note therefore
 * parsed to zero facts. The gate now accepts state media dir AND workspace
 * media dir (src/promptmedia.ts ParseContext.allowedDirs). The earlier
 * green tests passed because their fixtures used the state-dir/staged
 * shapes, never the workspace one.
 *
 * Always-inject (operator order 2026-09-30): whenever an image is detected
 * in the prompt, exactly one [Visual Memory] block is injected — hits,
 * "keine Treffer", or the explicit unavailable marker. A second
 * prompt_fire for the same turn (host re-resolve with trigger=manual)
 * dedupes on the claimed paths and never withdraws or overwrites the
 * queued injection; the queued check from the first fire owns the block.
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
 * (bounded). Path claims make the two seams (message_received /
 * before_prompt_build) idempotent against each other and stop prompt-note
 * re-projection from retriggering checks on old attachments.
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

  const sessionKey = resolveSessionKey(event, ctx);
  if (!sessionKey) {
    // Without a session there is no next turn to inject into. Hardening
    // (Hyperion review 1c4c01d, Minor-2): this check runs BEFORE any ledger
    // claim — claiming message key/paths without a session would mark the
    // images handled while nothing was ever checked, silently disarming the
    // prompt-build seam for the same files.
    deps.log.warn("visual-memory: image message without resolvable sessionKey; skipped");
    log("no_image", { reason: "no_session" });
    return { action: "no-image", reason: "no_session" };
  }

  if (!deps.processed.claim(key)) {
    log("dedup_skip");
    return { action: "duplicate" };
  }
  // Claim the paths too: the prompt-build seam must not re-check them.
  for (const image of images) deps.processed.claimPath(image);
  log("image_found", { images: images.length });

  log("check_started", { images: images.length });
  const check = runCheckAndInject(images, sessionKey, key, msgId, channel, deps);
  return { action: "queued", check };
}

/**
 * Handle one before_prompt_build event (the channel-agnostic seam that also
 * fires on WhatsApp, where message_received is privacy-suppressed by the
 * channel plugin). Images arrive there as `[media attached: ...]` notes in
 * the prompt. Decisions:
 * - always ONE `prompt_fire` diag line (fire+decision, even when no image —
 *   greppable trigger evidence on every channel),
 * - only user-trigger runs get checked (when the host provides the field):
 *   cron/heartbeat turns carry re-projected history notes, not fresh
 *   attachments,
 * - every candidate path is claimed in the ledger first; a path the
 *   message_received seam already checked (or a re-projected old note)
 *   dedupes to a duplicate decision, never a second vm.py run.
 * Never throws.
 */
export function handlePromptBuild(
  event: PromptBuildEventLike,
  ctx: PromptBuildContextLike,
  deps: HandlerDeps,
): HandlerDecision {
  const channel = ctx.channel ?? ctx.channelId;
  const msgId = "promptbuild";
  const log = (decision: DiagKind, extra?: { reason?: string; images?: number }) =>
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

  // Claim paths; keep only the ones this invocation newly claimed.
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
  const check = runCheckAndInject(fresh, sessionKey, key, msgId, channel, deps, {
    seam: "before_prompt_build",
    trigger: ctx.trigger,
  });
  return { action: "queued", check };
}

/**
 * Note-parsing context for prompt seams: media:// aliases resolve against
 * the state media dir; local note paths may live under EITHER the state
 * media dir or the workspace media dir (WhatsApp writes inbound images
 * into <workspaceDir>/media/inbound on this host — root cause 2).
 */
function noteParseContext(deps: HandlerDeps): ParseContext {
  const mediaDir = deps.mediaDir ?? deps.config.mediaDir;
  const allowedDirs = [mediaDir];
  if (typeof deps.config.workspaceDir === "string" && deps.config.workspaceDir.length > 0) {
    const workspaceMedia = path.join(deps.config.workspaceDir, "media");
    if (!allowedDirs.some((d) => path.resolve(d) === path.resolve(workspaceMedia))) {
      allowedDirs.push(workspaceMedia);
    }
  }
  return { mediaDir, allowedDirs };
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
  transcriptMeta?: Record<string, unknown>,
): Promise<void> {
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
    const result = await checkImage(image, {
      pythonPath: deps.pythonPath,
      scriptPath: deps.scriptPath,
      timeoutMs: deps.config.checkTimeoutMs,
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
  const idempotencyKey = `visual-memory:${sessionKey}:${messageKeyStr}`;
  run.record({ type: "inject", text, idempotencyKey, ttlMs: deps.config.injectionTtlMs });
  try {
    const result = await deps.enqueue({
      sessionKey,
      text,
      // One injection per message+session: covers re-delivery of the same
      // message and lets the host dedupe pending entries.
      idempotencyKey,
      ttlMs: deps.config.injectionTtlMs,
    });
    // The host refuses WITHOUT throwing ({ enqueued: false }) when the
    // session entry is missing or policy blocks it — surface that here or
    // the failure stays invisible (root cause of the silent 29.09 incident).
    if (result && typeof result === "object" && result.enqueued === false) {
      log("inject_failed", { reason: "host_refused" });
      deps.log.error("visual-memory: enqueue refused by host (enqueued=false)");
      run.done({ decision: "inject_failed", reason: "host_refused", durationMs: (deps.now ?? Date.now)() - startedAt });
      return;
    }
    log("injected", {
      hits: outcome.status === "ok" ? outcome.hits.length : 0,
    });
    run.done({
      decision: "injected",
      hitsTotal: outcome.status === "ok" ? outcome.hits.length : 0,
      durationMs: (deps.now ?? Date.now)() - startedAt,
    });
  } catch (err) {
    log("inject_failed", { reason: reasonToken(String(err)) });
    deps.log.error(`visual-memory: enqueue failed (${String(err)})`);
    run.done({ decision: "inject_failed", reason: reasonToken(String(err)), durationMs: (deps.now ?? Date.now)() - startedAt });
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
