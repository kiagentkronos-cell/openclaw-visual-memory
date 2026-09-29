/**
 * openclaw-visual-memory — plugin entry.
 *
 * Hooks: message_received (typed api.on) AND before_prompt_build.
 *
 * Why two seams (root cause, 2026-09-29): the WhatsApp channel plugin does
 * NOT broadcast message_received to plugins unless the operator opts in via
 * channels.whatsapp.pluginHooks.messageReceived (docs/channels/whatsapp.md,
 * "Plugin hooks and privacy"). Webchat fires it; WhatsApp never did — the
 * handler was correct but unreachable there. before_prompt_build is the
 * channel-agnostic agent-turn hook that fires for every admitted turn on
 * every channel; inbound images appear there as `[media attached: ...]`
 * prompt notes (src/promptmedia.ts decodes them, including the host's
 * media://inbound alias). Image-path claims in the ledger make the seams
 * idempotent against each other, so one image is checked exactly once.
 *
 * Flow (docs/plugins/hooks.md + hooks/messages.md + prompt-and-session.md):
 * 1. Inbound message with typed media[] facts is observed (message_received),
 *    or its image paths appear as prompt notes (before_prompt_build).
 * 2. Locally readable image facts trigger the Visual Memory CLI
 *    (`vm.py check <image>`) in the tool repository — the plugin holds no
 *    register logic of its own.
 * 3. The check runs detached (fire-and-forget with completion injection):
 *    the handler returns immediately so GPU latency never blocks message
 *    flow. The result is delivered to the agent via
 *    api.session.workflow.enqueueNextTurnInjection (documented current seam;
 *    the top-level api.enqueueNextTurnInjection alias is deprecated).
 * 4. When mediaStagingPending is set, the handler schedules ONE delayed
 *    probe of the originalMedia paths (existence-guarded); a later staged
 *    event may or may not arrive, so waiting for it alone is not an option
 *    (message_received fires once per accepted turn in host dispatch).
 *    A messageId-keyed ledger makes the whole path idempotent (no double
 *    checks, no double injections).
 *
 * Result protocol: every processed image message injects exactly one line
 * (hits / "keine Treffer" / "Check nicht verfügbar (reason)") so the agent
 * never guesses or re-checks manually. Errors also go to the plugin log;
 * image contents are never logged; only internal paths and hit labels
 * appear anywhere.
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
