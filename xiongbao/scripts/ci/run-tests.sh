#!/usr/bin/env bash
# Capture raw status too, but the report gates on Bun's actual summary, not exit 0.
#
# Both suites run one shard per call, from the same committed file list (app-shards.mjs,
# server-shards.mjs), so a baseline run and a head run cover the same files. The list always comes
# from the head tree: a test that only exists in head has no baseline counterpart and is skipped
# there.
set -euo pipefail
root=$1 suite=$2 log=$3
mkdir -p "$(dirname "$log")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
shard=${4:?shard 1..6 required} list_root=${5:?head file list root required}
[[ "$shard" =~ ^[1-6]$ ]] || exit 2
if [ "$suite" = app ]; then
  bun "$list_root/scripts/ci/app-shards.mjs" "$shard" "$list_root" > "$tmp/files"
  cd "$root/app"
  files=()
  while IFS= read -r file; do
    [ ! -f "$file" ] || files+=("./$file")
  done < "$tmp/files"
  [ "${#files[@]}" -gt 0 ] || { echo 'empty shard' > "$log"; exit 2; }
  printf '%s\n' "${files[@]}" > "$log.files.txt"
  { bun run --cwd .. generate:app-config && bun test "${files[@]}"; } > "$log" 2>&1
else
  bun "$list_root/scripts/ci/server-shards.mjs" "$shard" "$list_root" > "$tmp/files"
  cd "$root/server"
  files=()
  while IFS= read -r file; do
    # Newly introduced tests have no baseline counterpart.
    [ ! -f "$file" ] || files+=("./$file")
  done < "$tmp/files"
  [ "${#files[@]}" -gt 0 ] || { echo 'empty shard' > "$log"; exit 2; }
  printf '%s\n' "${files[@]}" > "$log.files.txt"
  bun test "${files[@]}" > "$log" 2>&1
fi
