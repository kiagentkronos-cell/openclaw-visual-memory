# openclaw-visual-memory

OpenClaw plugin that automates the Visual Memory image check: every inbound
message carrying an image triggers a local register check (`vm.py check`) and
the result is injected **synchronously into the same prompt turn** — the
Gateway waits for the check to finish (active-memory parity), without the
agent having to remember to run it.

This plugin contains **no register logic**. It is a thin hook wrapper around
the Visual Memory CLI (`vm.py`), which owns faces, embeddings, thresholds, and
the SQLite register. The plugin only: classifies typed media facts, shells out
to the CLI with a hard timeout, formats the result, and returns it as
same-turn prompt context.

**All processing stays local.** No cloud calls, no telemetry. The register may
contain face embeddings and reference crops of real people — treat it as
sensitive data and keep it on trusted hardware.

## Requirements

- OpenClaw host `>= 2026.9.6` (typed plugin hooks, `api.session.workflow`).
- Node 24+ (TypeScript sources are loaded directly via `openclaw.extensions`).
- A working Visual Memory tool repository (`vm.py` + Python venv, InsightFace
  and CLIP installed) reachable under `workspaceDir` (default
  `~/.openclaw/workspace` of the Gateway host user, tool at
  `scripts/visual-memory/vm.py`).

## Install (local link)

```bash
openclaw plugins install --link /path/to/openclaw-visual-memory --force
openclaw plugins enable visual-memory
```

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

After code changes: `openclaw plugins reload visual-memory`. The reload needs
an idle window (no active turns holding the plugin); while work is running it
reports `active retained work` and should simply be retried shortly after.

## Hooks (two seams)

1. `message_received` — typed inbound media facts (`event.media[]`,
   `kind === "image"` / `contentType: image/*` with a local `path`). Note:
   the WhatsApp channel plugin privacy-suppresses `message_received` unless
   the operator opts in via `channels.whatsapp.pluginHooks.messageReceived`.
2. `before_prompt_build` — channel-agnostic agent-turn hook that fires for
   every admitted turn. Image paths arrive as
   `[media attached: <path|media://inbound/…> (<mime>)]` prompt notes and are
   decoded back into media facts. This is the reliable primary seam on every
   channel. Candidate paths are gated to known media roots (workspace
   `media/inbound`, `mediaDir`, staging directories) so arbitrary paths from
   prompt text can never reach the CLI.

A `messageId`+path ledger makes the whole pipeline idempotent: the same image
is never checked or injected twice in a turn, even when both seams or both
trigger variants (`trigger_user` / `trigger_manual`) catch the same message.

## Delivery: synchronous, same turn

The `before_prompt_build` handler **awaits** the CLI check and returns the
result block as prompt context of the *same* turn (active-memory parity).
The hard ceiling is `checkTimeoutMs` (default 120 s); on expiry the check is
SIGKILLed and the block `Check nicht verfügbar (timeout)` is injected instead
of hanging.

Every processed image message injects exactly one line — so the agent can
always distinguish "checked, nothing found" from "not checked":

```
[Visual Memory] Treffer: <Name> (kind, confidence, score)[; …]
[Visual Memory] keine Treffer
[Visual Memory] Check nicht verfügbar (timeout)
[Visual Memory] Check nicht verfügbar (fehler: <token>)
```

Messages without images inject nothing at all. "Nicht verfügbar" means the
state is UNKNOWN: the agent must not re-run the check manually (that would
double GPU/CPU work).

## Config (`plugins.entries.visual-memory.config`)

All keys optional; unknown keys are rejected (`additionalProperties: false`).

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `workspaceDir` | `~/.openclaw/workspace` | Workspace holding the tool repo. |
| `vmScriptRelPath` | `scripts/visual-memory/vm.py` | CLI path relative to workspace. |
| `venvRelPath` | `scripts/visual-memory/venv/bin/python` | Interpreter relative to workspace. |
| `checkTimeoutMs` | `120000` | Hard per-check timeout (synchronous wait budget, active-memory parity); expiry kills the CLI and injects the "not available" marker. |
| `maxImageSizeBytes` | `20971520` | Oversized images are skipped (no spawn). |
| `maxImageAgeMs` | `900000` | Stale-mtime images are skipped (replay guard). |
| `injectionTtlMs` | `120000` | TTL for result bookkeeping entries. |
| `stagingRetryMs` | `5000` | Delay before the single staging-pending retry probes `originalMedia` (existence-guarded). |
| `mediaDir` | `~/.openclaw/media` | Media store root; `media://inbound/...` prompt-note aliases resolve under `<mediaDir>/inbound`. |
| `diagLogPath` | `~/.openclaw/logs/visual-memory-hook.log` | Metadata-only decision log (1 MB cap, newest half kept). |
| `transcriptDir` | `~/.openclaw/plugins/visual-memory/transcripts` | Per-run JSONL transcripts (active-memory parity logging). |
| `transcriptMaxFiles` | `200` | Transcript rotation cap. |

## Observability

Every decision is greppable, and PII-free (path hashes, no message content):

- **Diag log** — one line per decision
  (`decision=prompt_fire|injected_sync|check_miss|no_image|… reason=…`).
- **JSONL transcript per image run** under `transcriptDir`:

```json
{"type":"run","seam":"before_prompt_build","channel":"whatsapp","images":1,"trigger":"user"}
{"type":"image","pathhash":"8bd1a5c7…","sizeBytes":126473}
{"type":"check","status":"ok","durationMs":9543,"hits":[]}
{"type":"inject","text":"[Visual Memory] keine Treffer"}
{"type":"done","decision":"injected_sync","durationMs":9554}
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No block at all | channel seam not firing / stale plugin generation | Check diag log for `prompt_fire`; reload during an idle window. |
| `check_miss` despite an image | path outside the media roots (gate) | Verify `mediaDir`/workspace roots; see transcript gate decisions. |
| Known subject not hit | below threshold (e.g. profile view) | Enroll an additional reference from a matching angle. |
| `Check nicht verfügbar (timeout)` | CLI slower than `checkTimeoutMs` | Raise the budget or check resource contention. |
| Image silently skipped | `maxImageAgeMs` replay guard on re-delivered media | Raise the age limit if legitimate. |

## Development

```bash
bash scripts/validate-offline.sh   # typecheck + tests + manifest load
```

Tests need no GPU; they run against fixture media in a Node test runner
(93 tests as of 2026-09-30).

## Documentation

Full (German) documentation with architecture rationale, thresholds, commit
history, and release conditions: [`docs/DOKUMENTATION.md`](docs/DOKUMENTATION.md).

## License

MIT
