/**
 * Wiring between the plugin entry and the framework-free handler core.
 *
 * Kept SDK-free (structural minimal api shape) so the registration wiring is
 * unit-testable with a fake api — no Gateway, no host, fully offline.
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { normalizeConfig, type VmCheckConfig } from "./config.ts";
import {
  handleMessageReceived,
  handlePromptBuild,
  MessageLedger,
  type HandlerDecision,
  type HandlerDeps,
} from "./handler.ts";
import type { SpawnFn } from "./checker.ts";
import { FileDiagSink, NULL_DIAG_SINK, type DiagSink } from "./diaglog.ts";
import { FileTranscriptSink, NULL_TRANSCRIPT_SINK, type TranscriptSink } from "./transcript.ts";

/** Minimal structural view of the parts of OpenClawPluginApi we touch. */
export interface ApiLike {
  pluginConfig?: Record<string, unknown>;
  logger: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  session: {
    workflow: {
      enqueueNextTurnInjection: (injection: {
        sessionKey: string;
        text: string;
        idempotencyKey?: string;
        ttlMs?: number;
        placement?: "prepend_context" | "append_context";
      }) => Promise<{ enqueued?: unknown } | void>;
    };
  };
  on: (
    hook: "message_received" | "before_prompt_build",
    handler: (event: any, ctx: any) => Promise<void | PromptPrepend> | void,
    opts?: { timeoutMs?: number },
  ) => void;
}

//** before_prompt_build modifier result (host: runModifyingHook). */
export interface PromptPrepend {
  prependContext?: string;
}

export interface EntryDeps {
  /** Spawner override (tests); production leaves this unset. */
  spawn?: SpawnFn;
  now?: () => number;
  /** Diagnostic sink override (tests); production writes the diag log file. */
  diag?: DiagSink;
  /** Transcript sink override (tests); production writes per-run JSONL files. */
  transcripts?: TranscriptSink;
  /** Scheduler override (fake timers in tests); production uses setTimeout. */
  schedule?: (fn: () => void, delayMs: number) => unknown;
  /** Existence probe override (tests); production uses fs.existsSync. */
  fileExists?: (p: string) => boolean;
}

/** Build handler deps from plugin config. */
export function buildDeps(api: ApiLike, config: VmCheckConfig, extras: EntryDeps = {}): HandlerDeps {
  return {
    config,
    pythonPath: path.resolve(config.workspaceDir, config.venvRelPath),
    scriptPath: path.resolve(config.workspaceDir, config.vmScriptRelPath),
    spawn: extras.spawn,
    now: extras.now,
    log: {
      info: (msg) => api.logger.info?.(msg),
      warn: (msg) => api.logger.warn?.(msg),
      error: (msg) => api.logger.error?.(msg),
    },
    processed: new MessageLedger(),
    // Production sink: size-capped metadata-only file. A sink failure is
    // silent by design; tests pass their own capture sink via extras.diag.
    diag:
      extras.diag ??
      new FileDiagSink(config.diagLogPath, 1_048_576, extras.now ?? Date.now),
    transcripts:
      extras.transcripts ??
      new FileTranscriptSink(config.transcriptDir, config.transcriptMaxFiles, extras.now ?? Date.now),
    schedule: extras.schedule ?? ((fn, delayMs) => setTimeout(fn, delayMs)),
    fileExists: extras.fileExists ?? ((p) => existsSync(p)),
    mediaDir: config.mediaDir,
    // Return the host result so the handler can see enqueued:false refusals
    // (the host does not throw when it drops an injection).
    enqueue: async ({ sessionKey, text, idempotencyKey, ttlMs }) =>
      api.session.workflow.enqueueNextTurnInjection({
        sessionKey,
        text,
        idempotencyKey,
        ttlMs,
        placement: "prepend_context",
      }),
  };
}

/** Extra await budget the host grants on top of checkTimeoutMs so the
 * synchronous check can finish its cleanup before the host's own timeout
 * fires (active-memory arms its deadline the same way: MAX + grace). */
export const HOOK_GRACE_MS = 5_000;

/**
 * Register the hooks on a plugin api:
 * - before_prompt_build (the delivery seam): awaits the vm.py check
 *   SYNCHRONOUSLY and returns { prependContext } for the SAME prompt —
 *   the Gateway waits, exactly like it waits for Active Memory (operator
 *   order 30.09). Registration carries { timeoutMs: checkTimeoutMs +
 *   grace } (docs/plugins/hooks/reference.md) so the host's await budget
 *   covers the full check window. Fires on every channel, including
 *   WhatsApp where message_received is privacy-suppressed (docs/channels/
 *   whatsapp.md).
 * - message_received: observation seam only (image_found logging + the
 *   single staging-pending retry). Checks are NOT run here; the prompt
 *   seam of the same turn owns every image.
 * Returns bound handlers for test observability.
 */
export function registerMessageHook(api: ApiLike, extras: EntryDeps = {}): {
  config: VmCheckConfig;
  handle: (event: unknown, ctx: unknown) => HandlerDecision;
  handlePrompt: (event: unknown, ctx: unknown) => Promise<HandlerDecision>;
  /** Registered hook handlers (tests drive these like the host would). */
  handlers: Partial<
    Record<"message_received" | "before_prompt_build", (event: any, ctx: any) => Promise<unknown>>
  >;
} {
  const config = normalizeConfig(api.pluginConfig);
  const deps = buildDeps(api, config, extras);
  const handle = (event: unknown, ctx: unknown): HandlerDecision =>
    handleMessageReceived(
      event as Parameters<typeof handleMessageReceived>[0],
      ctx as { sessionKey?: string; messageId?: string },
      deps,
    );
  const handlePrompt = (event: unknown, ctx: unknown): Promise<HandlerDecision> =>
    handlePromptBuild(
      event as Parameters<typeof handlePromptBuild>[0],
      ctx as Parameters<typeof handlePromptBuild>[1],
      deps,
    );
  const handlers: Record<string, (event: any, ctx: any) => Promise<unknown>> = {
    before_prompt_build: async (event, ctx) => {
      const decision = await handlePrompt(event, ctx);
      // Same-turn synchronous delivery (operator order 30.09 10:17).
      if (decision.action === "prepend") {
        return { prependContext: decision.text };
      }
      return undefined;
    },
    message_received: async (event, ctx) => {
      handle(event, ctx);
      return undefined;
    },
  };
  api.on("message_received", async (event, ctx) => {
    await handlers.message_received!(event, ctx);
  });
  api.on(
    "before_prompt_build",
    async (event, ctx) => {
      const r = await handlers.before_prompt_build!(event, ctx);
      return (r as PromptPrepend | undefined) ?? undefined;
    },
    // The Gateway must wait for the full synchronous check window
    // (active-memory analogue; operators may still override per plugin).
    { timeoutMs: config.checkTimeoutMs + HOOK_GRACE_MS },
  );
  return { config, handle, handlePrompt, handlers };
}

// Referenced so test overrides can disable the file sink explicitly.
export { NULL_DIAG_SINK };
