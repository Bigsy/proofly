#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$root/node_modules/harper.js"
vendor_dir="$root/vendor/harper"
mode="${1:-copy}"

files=(
  "dist/index.js"
  "dist/BinaryModule-S5UABkWQ.js"
  "dist/binary.js"
  "dist/harper_wasm_bg.wasm"
  "LICENSE"
)
hashes=(
  "889c87eaeec733f9508f619f72537839a53ec7c999132583552c5d3046af360f"
  "289295aebe0757eec195c3e2a2007b8faa2fd4678be4574380cf4489d833bc6c"
  "7c8080342a87b2ce71f971d403854650ed56f1d9e39d2bfacabe48a7c090c43c"
  "e2d2998448e29acbf80cc2da768198a4ead4bf0dd838feb16f09373b5fca1e16"
  "fbc8f1bffe04ab962340fabb1324d57d8b875070f67759d606516144ee53ac19"
)

if [[ "$mode" != "copy" && "$mode" != "--check" ]]; then
  echo "usage: tools/vendor-harper.sh [--check]" >&2
  exit 2
fi

actual_version="$(node -p "require('$source_dir/package.json').version" 2>/dev/null || true)"
if [[ "$actual_version" != "2.13.0" ]]; then
  echo "harper.js 2.13.0 must be installed (found: ${actual_version:-missing})" >&2
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

echo "Harper 2.13.0 vendor assets verified"
