#!/usr/bin/env bash
# Offline proof bundle for the visual-memory hook plugin (no Gateway needed).
# 1) TypeScript typecheck  2) offline test suite  3) manifest loads via the
# real plugin CLI in an isolated profile (no production config touched).
#
# NOTE: `openclaw plugins validate` is tool/feature-plugin specific (it
# requires defineToolPlugin/defineFeaturePlugin authoring metadata). This
# plugin is a pure typed-hook plugin (definePluginEntry, per the documented
# hook quick-start) — its validity proof is the manifest load + hook
# registration in the isolated profile below and `plugins inspect
# visual-memory --runtime` after installation (see README).
set -euo pipefail
cd "$(dirname "$0")/.."
TSC="${TSC:-${HOME:-/home/$(id -un)}/.npm-global/lib/node_modules/openclaw/node_modules/typescript/bin/tsc}"
node "$TSC"
node --test test/*.test.ts
PROBE_DIR="$(mktemp -d)"
trap 'rm -rf "$PROBE_DIR"' EXIT
cat > "$PROBE_DIR/openclaw.json" <<JSON
{ "plugins": { "load": { "paths": ["$(pwd)"] }, "entries": { "visual-memory": { "enabled": true } } } }
JSON
OPENCLAW_STATE_DIR="$PROBE_DIR/state" OPENCLAW_CONFIG_PATH="$PROBE_DIR/openclaw.json" \
  openclaw plugins inspect visual-memory --json \
  | grep -q visual-memory
echo "validate-offline: OK (typecheck + tests + manifest load)"
