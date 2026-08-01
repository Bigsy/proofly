#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$root/node_modules/harper.js"
vendor_dir="$root/vendor/harper"
mode="${1:-copy}"

files=(
  "dist/index.js"
  "dist/BinaryModule-Aj1vLnwf.js"
  "dist/binary.js"
  "dist/harper_wasm_bg.wasm"
  "LICENSE"
)
hashes=(
  "8332e02000e07fa6625765c3f3de6d75787181586fd6d4a607b1d263af42e926"
  "e7d39bb29884349a0f629813f9b317d631edb7963fda2d9c9ac5b9c8a2e8829c"
  "6c408881cf9d54a32bf7a732b63e0b190132d32b250c34dc8128d50f5174dda0"
  "116210e8c7ceaa8c7834145179ed09885c9d3a3cad83c1f6174c00d5da7970f2"
  "516659b5ebca507444fa0fc6ed97a01863ce081c2a04771c6f0cd7befcef1008"
)

if [[ "$mode" != "copy" && "$mode" != "--check" ]]; then
  echo "usage: tools/vendor-harper.sh [--check]" >&2
  exit 2
fi

actual_version="$(node -p "require('$source_dir/package.json').version" 2>/dev/null || true)"
if [[ "$actual_version" != "2.7.0" ]]; then
  echo "harper.js 2.7.0 must be installed (found: ${actual_version:-missing})" >&2
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

echo "Harper 2.7.0 vendor assets verified"
