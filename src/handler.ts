/**
 * message_received handler logic (framework-free core).
 *
 * Behaviour contract (docs/plugins/hooks/messages.md):
 * - Image facts arrive typed via event.media[] (path/kind/contentType).
 * - When mediaStagingPending is true, event.media is intentionally absent and
 *   only originalMedia (provider-side, NOT locally readable) is present. The
 *   handler must not block or wait; it returns and lets the later staged
 *   event trigger the check. Idempotency across the two events is keyed on
 *   messageId so a message is never checked twice.
 * - The GPU check may take seconds: the handler itself must never await it
 *   into the message flow beyond the hook budget. The caller decides how to
 *   run it (fire-and-forget with completion -> next-turn injection).
 */

import { localImagePaths, type MediaFactLike } from "./media.ts";
import { buildInjectionText, type VmCheckOutcome, type VmHit } from "./injection.ts";
import { checkImage, type CheckResult, type SpawnFn } from "./checker.ts";
import type { VmCheckConfig } from "./config.ts";

export interface ReceivedEventLike {
  content?: string;
  messageId?: string;
  sessionKey?: string;
  media?: MediaFactLike[];
  originalMedia?: MediaFactLike[];
  mediaStagingPending?: boolean;
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

export interface HandlerDeps {
  config: VmCheckConfig;
  /** Resolved absolute python + script paths. */
  pythonPath: string;
  scriptPath: string;
  spawn?: SpawnFn;
  now?: () => number;
  /** Enqueue text for the next turn of this session (host API in production). */
  enqueue: (params: { sessionKey: string; text: string; idempotencyKey: string; ttlMs: number }) => Promise<unknown>;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  /** In-memory processed-message store; injected so tests control it. */
  processed: MessageLedger;
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
  | { action: "no-image" }
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
  if (!deps.config.enabled) {
    return { action: "disabled" };
  }

  // Staging not finished: media[] is withheld by design. Skip now; the later
  // staged event for the same messageId performs the check.
  if (event.mediaStagingPending === true && !Array.isArray(event.media)) {
    return { action: "staging-pending" };
  }

  const images = localImagePaths(event.media);
  if (images.length === 0) {
    return { action: "no-image" };
  }

  const key = messageKey(event, ctx);
  if (!deps.processed.claim(key)) {
    return { action: "duplicate" };
  }

  const sessionKey = resolveSessionKey(event, ctx);
  if (!sessionKey) {
    // Without a session there is no next turn to inject into.
    deps.log.warn("visual-memory: image message without resolvable sessionKey; skipped");
    return { action: "no-image" };
  }

  const check = runCheckAndInject(images, sessionKey, key, deps);
  return { action: "queued", check };
}

/** Run every image check (sequentially - GPU friendly) and inject once. */
async function runCheckAndInject(
  images: string[],
  sessionKey: string,
  messageKeyStr: string,
  deps: HandlerDeps,
): Promise<void> {
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

  const ok = outcomes.filter((o): o is { status: "ok"; hits: VmHit[] } => o.status === "ok");
  if (ok.length === 0) {
    // Every check failed or was skipped -> inject NOTHING (fail-silent policy).
    for (const o of outcomes) {
      if (o.status === "error") {
        deps.log.error(`visual-memory: check failed (${o.reason}); nothing injected`);
      } else if (o.status === "skipped") {
        deps.log.info(`visual-memory: check skipped (${o.reason})`);
      }
    }
    return;
  }

  // Merge hits across images, dedupe by name+kind, keep best score.
  const best = new Map<string, VmHit>();
  for (const outcome of ok) {
    for (const hit of outcome.hits) {
      const id = `${hit.name} ${hit.kind}`;
      const prev = best.get(id);
      if (!prev || (hit.score ?? -1) > (prev.score ?? -1)) {
        best.set(id, hit);
      }
    }
  }
  const text = buildInjectionText({ status: "ok", hits: [...best.values()] });
  if (text === undefined) {
    return;
  }
  try {
    await deps.enqueue({
      sessionKey,
      text,
      // One injection per message+session: covers re-delivery of the same
      // message and lets the host dedupe pending entries.
      idempotencyKey: `visual-memory:${sessionKey}:${messageKeyStr}`,
      ttlMs: deps.config.injectionTtlMs,
    });
  } catch (err) {
    deps.log.error(`visual-memory: enqueue failed (${String(err)})`);
  }
}
