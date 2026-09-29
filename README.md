# openclaw-visual-memory

OpenClaw plugin that automates the Visual Memory image check: every inbound
message carrying image attachments triggers the local register check
(`vm.py check`) and the outcome is made available to the agent as
next-turn context — without the agent having to remember to run it.

This plugin contains **no register logic**. It is a thin hook wrapper around
the Visual Memory CLI repository (`vm.py`), which owns faces, embeddings,
thresholds, and the SQLite register. The plugin only: classifies typed media
facts, shells out to the CLI with a hard timeout, formats the result, and
queues it as a durable next-turn injection.

## Requirements

- OpenClaw host `>= 2026.9.6` (typed plugin hooks, `api.session.workflow`).
- Node 24+ (TypeScript sources are loaded directly via `openclaw.extensions`).
- A working Visual Memory tool repository with its Python venv, reachable
  under `workspaceDir` (default `~/.openclaw/workspace` of the Gateway host user,
  tool at `scripts/visual-memory/vm.py`).

## Install (local link)

```bash
openclaw plugins install --link /path/to/openclaw-visual-memory --force
openclaw plugins enable visual-memory
```

The plugin registers `message_received`, a conversation-visible message hook.
On hosts that gate conversation access for non-bundled plugins, grant it in
`openclaw.json` (merge, don't replace):

```json
{
  "plugins": {
    "entries": {
      "visual-memory": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

Note: durable next-turn injections require prompt injection to be allowed
for this plugin; if `plugins.entries.visual-memory.hooks.allowPromptInjection`
is ever set to `false`, results will silently stop appearing.

After code changes: `openclaw plugins reload visual-memory`.

## Config (`plugins.entries.visual-memory.config`)

All keys optional; unknown keys are rejected (`additionalProperties: false`).

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `workspaceDir` | `~/.openclaw/workspace` | Workspace holding the tool repo. |
| `vmScriptRelPath` | `scripts/visual-memory/vm.py` | CLI path relative to workspace. |
| `venvRelPath` | `scripts/visual-memory/venv/bin/python` | Interpreter relative to workspace. |
| `checkTimeoutMs` | `30000` | Hard per-check timeout; expiry kills the CLI and injects the "not available" marker. |
| `maxImageSizeBytes` | `20971520` | Oversized images are skipped (no spawn). |
| `maxImageAgeMs` | `900000` | Stale-mtime images are skipped (replay guard). |
| `injectionTtlMs` | `120000` | TTL of the queued injection; late results expire instead of landing in an unrelated turn. |
| `stagingRetryMs` | `5000` | Delay before the single staging-pending retry probes `originalMedia` (existence-guarded). |
| `diagLogPath` | `~/.openclaw/logs/visual-memory-hook.log` | Metadata-only decision log (1 MB cap, newest half kept). |

## How it works

1. `message_received` (typed `api.on`) inspects `event.media[]` facts
   (`kind === "image"` or `contentType: image/*` with a local `path`).
2. **Staging pending:** when `mediaStagingPending` is true, `media` is
   intentionally withheld. The host emits `message_received` only once per
   accepted turn, so waiting for a later staged event never fires. The
   handler instead schedules **one** guarded retry after `stagingRetryMs`:
   each `originalMedia.path` is existence-probed; locally readable images
   (e.g. WhatsApp `media/inbound`) are checked, true remote paths give up
   quietly after the single attempt.
3. Checked messages are recorded in a bounded messageId-keyed ledger, so the
   staging→staged pair (or any redelivery) triggers exactly **one** check and
   one injection.
4. The check runs detached (fire-and-forget). Message flow is never blocked
   by GPU latency; a per-run `setTimeout` guard SIGKILLs wedged CLI calls.
5. On completion the result is queued via
   `api.session.workflow.enqueueNextTurnInjection`
   (`placement: prepend_context`, `idempotencyKey` per message+session).
   **Every processed image message injects exactly one line** (protocol
   change 2026-09-29 — the agent must distinguish "checked, nothing
   found" from "not checked"):

   ```
   [Visual Memory] Treffer: <Name> (kind, confidence, score)[; …]
   [Visual Memory] keine Treffer
   [Visual Memory] Check nicht verfügbar (timeout)
   [Visual Memory] Check nicht verfügbar (fehler: <token>)
   ```

   "Nicht verfügbar" means the state is UNKNOWN: the agent must not re-run
   the check manually (that would double GPU work). Messages without images
   inject nothing at all.

6. **Diagnostics:** every decision (skip, dedupe, check, injection, host
   refusal) appends one metadata-only line to `diagLogPath` — never message
   content, image paths, or hit names. A refused enqueue
   (`{ enqueued: false }`, which the host does NOT signal by throwing) is
   logged as `inject_failed reason=host_refused`.

## Boundaries

- Read-only against the register: the plugin only ever calls `vm.py check`.
  Enroll/remove stay agent-driven.
- No network access; no image contents in logs (paths and hit labels only).
- Hits are the operator's own register entries — treat injection text as
  private session context.
- `before_prompt_build` (synchronous alternative) was rejected deliberately:
  it would put GPU latency inside the prompt path of every turn. The
  documented durable seam for exactly this "slow side work → visible on the
  next turn" case is the next-turn injection queue.

## Validation

`openclaw plugins validate` targets tool/feature plugins (it requires
`defineToolPlugin`/`defineFeaturePlugin` authoring metadata). This is a pure
typed-hook plugin built with `definePluginEntry`, so the equivalent offline
proof is:

```bash
./scripts/validate-offline.sh   # typecheck + tests + manifest load in an isolated profile
```

and, after installation against a Gateway:

```bash
openclaw plugins inspect visual-memory --runtime --json   # typedHooks: message_received
```

## Tests

```bash
node --test test/*.test.ts
```

Fully offline: the CLI is spawner-injected; fixtures cover hits, no-hits,
error/exit-code, timeout (hang), staging-pending, dedup, and guards. The
real GPU venv is never invoked from tests.

## Limits

- The ledger is in-process: a Gateway restart loses recent message keys
  (worst case: one repeated check after restart, still one injection thanks
  to the host-side `idempotencyKey`).
- Channels that never stage locally (URL-only media, no staged follow-up)
  are not checked — the plugin only reads files the Gateway staged.
- If the image message and its reply race, the injection applies to the
  next prompt build in that session; the TTL bounds misplacement.
