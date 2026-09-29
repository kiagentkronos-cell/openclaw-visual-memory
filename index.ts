/**
 * openclaw-visual-memory — plugin entry.
 *
 * Hook: message_received (typed api.on).
 *
 * Flow (docs/plugins/hooks.md + hooks/messages.md):
 * 1. Inbound message with typed media[] facts is observed.
 * 2. Locally readable image facts trigger the Visual Memory CLI
 *    (`vm.py check <image>`) in the tool repository — the plugin holds no
 *    register logic of its own.
 * 3. The check runs detached (fire-and-forget with completion injection):
 *    the handler returns immediately so GPU latency never blocks message
 *    flow. The result is delivered to the agent via
 *    api.session.workflow.enqueueNextTurnInjection (documented current seam;
 *    the top-level api.enqueueNextTurnInjection alias is deprecated).
 * 4. mediaStagingPending events are skipped; the later staged event for the
 *    same messageId runs the check. A messageId-keyed ledger makes the whole
 *    path idempotent (no double checks, no double injections).
 *
 * Failure policy: any CLI error/timeout injects NOTHING (never invent a
 * result); errors go to the plugin log only. Image contents are never
 * logged; only file paths (internal) and hit labels appear anywhere.
 *
 * Note on `openclaw plugins validate`: that command checks tool/feature
 * authoring metadata (defineToolPlugin/defineFeaturePlugin entries). This is
 * a pure typed-hook plugin built with definePluginEntry — the documented
 * quick-start shape for hooks — so the equivalent proof of validity is the
 * real manifest loader plus a runtime inspect of the registered hooks
 * (see scripts/validate-offline.sh / README).
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerMessageHook } from "./src/entry.ts";

export default definePluginEntry({
  id: "visual-memory",
  name: "Visual Memory",
  description:
    "Checks inbound images against the local Visual Memory register and injects results into the next agent turn.",
  register(api) {
    registerMessageHook(api as never);
  },
});
