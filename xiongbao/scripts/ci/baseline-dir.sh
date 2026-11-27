#!/usr/bin/env bash
# Prints the product directory inside the frozen baseline worktree (prepare-baseline.sh). A pin from
# before the directory got its current name is not supported: the current pin (e63acdfb, 2026-11-18) is
# past that rename.
set -euo pipefail
: "${RUNNER_TEMP:?set RUNNER_TEMP to an isolated temporary directory}"
base="$RUNNER_TEMP/delivery-baseline"
for name in xiongbao; do
  if [ -f "$base/$name/package.json" ]; then
    printf '%s\n' "$base/$name"
    exit 0
  fi
done
echo "no product directory (xiongbao/) in $base" >&2
exit 1
