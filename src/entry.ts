/**
 * Wiring between the plugin entry and the framework-free handler core.
 *
 * Kept SDK-free (structural minimal api shape) so the registration wiring is
 * unit-testable with a fake api — no Gateway, no host, fully offline.
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { normalizeConfig, type VmCheckConfig } from "./config.ts";
import { handleMessageReceived, MessageLedger, type HandlerDeps } from "./handler.ts";
import type { SpawnFn } from "./checker.ts";
import { FileDiagSink, NULL_DIAG_SINK, type DiagSink } from "./diaglog.ts";

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
    hook: "message_received",
    handler: (event: any, ctx: any) => Promise<void> | void,
  ) => void;
}

export interface EntryDeps {
  /** Spawner override (tests); production leaves this unset. */
  spawn?: SpawnFn;
  now?: () => number;
  /** Diagnostic sink override (tests); production writes the diag log file. */
  diag?: DiagSink;
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
    schedule: extras.schedule ?? ((fn, delayMs) => setTimeout(fn, delayMs)),
    fileExists: extras.fileExists ?? ((p) => existsSync(p)),
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

/**
 * Register the message_received hook on a plugin api.
 * Returns a handler function bound to deps for test observability.
 */
export function registerMessageHook(api: ApiLike, extras: EntryDeps = {}): {
  config: VmCheckConfig;
  handle: (event: unknown, ctx: unknown) => void;
} {
  const config = normalizeConfig(api.pluginConfig);
  const deps = buildDeps(api, config, extras);
  const handle = (event: unknown, ctx: unknown) => {
    const decision = handleMessageReceived(
      event as Parameters<typeof handleMessageReceived>[0],
      ctx as { sessionKey?: string; messageId?: string },
      deps,
    );
    if (decision.action === "queued") {
      // Fire-and-forget: completion injects; failures are logged inside.
      void decision.check.catch((err: unknown) => {
        api.logger.error?.(`visual-memory: detached check crashed (${String(err)})`);
      });
    }
  };
  api.on("message_received", async (event, ctx) => {
    handle(event, ctx);
  });
  return { config, handle };
}

// Referenced so test overrides can disable the file sink explicitly.
export { NULL_DIAG_SINK };
