#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# Keep stdout machine-readable: the release workflow captures this script's
# output as the archive path. Verification detail still belongs in the logs.
bash tools/vendor-harper.sh --check >&2

version="$(node -p "require('./manifest.json').version")"
stamp="$(date +%Y%m%d-%H%M%S)"
out_dir="dist"
out="$out_dir/proofly-${version}-${stamp}.zip"

mkdir -p "$out_dir"

zip -qr "$out" \
  manifest.json \
  background.js \
  offscreen.html \
  offscreen.js \
  sidepanel.html \
  sidepanel.css \
  sidepanel.js \
  rewrite.js \
  LICENSE \
  THIRD_PARTY_NOTICES.md \
  PRIVACY.md \
  icons \
  lib \
  ui \
  page \
  popup \
  options \
  vendor \
  -x "**/.DS_Store"

echo "$out"
