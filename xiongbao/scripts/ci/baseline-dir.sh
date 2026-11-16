#!/usr/bin/env bash
# Prints the product directory inside the frozen baseline worktree (prepare-baseline.sh). The
# baseline is an older commit, so the directory may still carry its former name: it was renamed
# from openbot/ to xiongbao/, and a baseline from before that has only openbot/.
set -euo pipefail
: "${RUNNER_TEMP:?set RUNNER_TEMP to an isolated temporary directory}"
base="$RUNNER_TEMP/delivery-baseline"
for name in xiongbao openbot; do
  if [ -f "$base/$name/package.json" ]; then
    printf '%s\n' "$base/$name"
    exit 0
  fi
done
echo "no product directory (xiongbao/ or openbot/) in $base" >&2
exit 1
