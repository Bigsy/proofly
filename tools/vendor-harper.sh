#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$root/node_modules/harper.js"
vendor_dir="$root/vendor/harper"
mode="${1:-copy}"

files=(
  "dist/index.js"
  "dist/BinaryModule-DTTQwokQ.js"
  "dist/binary.js"
  "dist/harper_wasm_bg.wasm"
  "LICENSE"
)
hashes=(
  "720072fa23b7ae233eb5244a64ecc4e98149687565cfdca545e078bbbdf13578"
  "e0fa7d5eebd5f5459b356dfcfb54e09472da8a292f304a632a0647f960c481ac"
  "41a06f20e05802ea29b9fecd79c7f32fc24d3ed256e3d794ad5f9a67afbd7237"
  "7ff4b501da808b9d196b0d216113e463ff4b0d2b7338ecd44df0aa77a37485a8"
  "516659b5ebca507444fa0fc6ed97a01863ce081c2a04771c6f0cd7befcef1008"
)

if [[ "$mode" != "copy" && "$mode" != "--check" ]]; then
  echo "usage: tools/vendor-harper.sh [--check]" >&2
  exit 2
fi

actual_version="$(node -p "require('$source_dir/package.json').version" 2>/dev/null || true)"
if [[ "$actual_version" != "2.4.0" ]]; then
  echo "harper.js 2.4.0 must be installed (found: ${actual_version:-missing})" >&2
  exit 1
fi

for i in "${!files[@]}"; do
  source="$source_dir/${files[$i]}"
  [[ -f "$source" ]] || { echo "missing Harper source asset: ${files[$i]}" >&2; exit 1; }
  actual="$(shasum -a 256 "$source" | awk '{print $1}')"
  [[ "$actual" == "${hashes[$i]}" ]] || {
    echo "unexpected hash for Harper ${files[$i]}: $actual" >&2
    exit 1
  }
done

if [[ "$mode" == "copy" ]]; then
  mkdir -p "$vendor_dir"
  for file in "${files[@]}"; do
    cp "$source_dir/$file" "$vendor_dir/$(basename "$file")"
  done
fi

for i in "${!files[@]}"; do
  vendored="$vendor_dir/$(basename "${files[$i]}")"
  [[ -f "$vendored" ]] || { echo "missing vendored Harper asset: $vendored" >&2; exit 1; }
  actual="$(shasum -a 256 "$vendored" | awk '{print $1}')"
  [[ "$actual" == "${hashes[$i]}" ]] || {
    echo "stale vendored Harper asset: $vendored" >&2
    exit 1
  }
done

mapfile_command="$(command -v mapfile || true)"
if [[ -n "$mapfile_command" ]]; then
  mapfile -t extras < <(find "$vendor_dir" -maxdepth 1 -type f -print | sort)
else
  extras=()
  while IFS= read -r file; do extras+=("$file"); done < <(find "$vendor_dir" -maxdepth 1 -type f -print | sort)
fi
if [[ "${#extras[@]}" -ne "${#files[@]}" ]]; then
  echo "vendor/harper contains unexpected files; rerun npm run vendor:harper" >&2
  exit 1
fi

echo "Harper 2.4.0 vendor assets verified"
