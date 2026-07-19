#!/usr/bin/env bash
#
# Manual launch of the Proofly dev Chrome — SAME browser, profile and flags as
# the MCP dev loop (README → "The MCP dev loop"), so everything set up there
# (built-in-AI flags, the ~8 GB on-device model) is already in place.
#
#   Browser:  Chrome Beta            (Canary removed the on-device-model flag)
#   Profile:  ~/.proofly-chrome-beta-dev   (persistent, isolated)
#
# Loading the extension: --load-extension no longer works in branded Chrome
# (the DisableLoadExtensionCommandLineSwitch override was removed), and the
# MCP server installs Proofly via CDP, which does NOT persist across restarts.
# So on first manual run, load it once by hand — it then persists in this
# profile:
#
#   chrome://extensions -> Developer mode ON -> "Load unpacked" -> this repo
#
# The two required flags are seeded into the profile's Local State below:
#
#   proofreader-api@1                      Proofreader API: Enabled
#   optimization-guide-on-device-model@2   Enabled BypassPerfRequirement
#
# IMPORTANT: don't run this while an MCP-launched Chrome is open on the
# same profile — two Chrome processes can't share one --user-data-dir. The
# script aborts if it spots one.

set -euo pipefail

BETA="/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"
PROFILE="$HOME/.proofly-chrome-beta-dev"
EXT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[ -x "$BETA" ] || { echo "Chrome Beta not found at: $BETA" >&2; exit 1; }

# Refuse to fight the MCP server (or a previous run) over the profile lock.
if pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null 2>&1; then
  echo "A Chrome is already running on $PROFILE (probably the MCP server's)." >&2
  echo "Close it first, e.g.:  pkill -TERM -f -- '--user-data-dir=$PROFILE'" >&2
  exit 1
fi

# Seed the built-in-AI flags into Local State (idempotent; only takes effect
# on launch, which is exactly what we're about to do).
LOCAL_STATE="$PROFILE/Local State"
mkdir -p "$PROFILE"
[ -f "$LOCAL_STATE" ] || echo '{}' > "$LOCAL_STATE"
jq '.browser.enabled_labs_experiments =
      ((.browser.enabled_labs_experiments // [])
       + ["proofreader-api@1", "optimization-guide-on-device-model@2"]
       | unique)' "$LOCAL_STATE" > "$LOCAL_STATE.tmp"
mv "$LOCAL_STATE.tmp" "$LOCAL_STATE"

echo "Profile:   $PROFILE"
echo "Extension: $EXT  (load once via chrome://extensions -> Load unpacked)"

# No automation flags here on purpose: a plain launch keeps background
# networking (component updater -> model download) and OptimizationHints
# (model execution service) enabled — the two things the MCP config has to
# fight Puppeteer's defaults to preserve.
exec "$BETA" \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port=9222 \
  --no-first-run \
  --no-default-browser-check
