#!/usr/bin/env bash
# Print the parts of a test or container log that explain a failure into the
# job log itself, so the cause is readable without downloading artifacts.
# This repository is public: connection-string passwords, bearer tokens and
# base64 keys are masked before anything is printed.
set -uo pipefail
log=${1:?log file required}
if [ ! -f "$log" ]; then
  echo "::notice::no log at $log"
  exit 0
fi
mask() {
  sed -E \
    -e 's#(postgres(ql)?://[^:/@[:space:]]+:)[^@[:space:]]+@#\1***@#g' \
    -e 's#([Bb]earer )[A-Za-z0-9._~+/=-]+#\1***#g' \
    -e 's#((KEY|SECRET|PASSWORD|TOKEN)[A-Z_]*=)[^[:space:]]+#\1***#g'
}
strip() { sed -E 's/\x1b\[[0-9;]*m//g'; }
echo "::group::$(basename "$log"): $(wc -l < "$log") lines"
echo "--- failures, errors and import problems (first 150) ---"
strip < "$log" | grep -nE '^\(fail\)|error:|Error:|\(unnamed\)|preload|remaining connection slots|too many clients|^ *[0-9]+ errors?$|does not exist|Refusing|exited|panic' | head -150 | mask
echo "--- last 60 lines ---"
strip < "$log" | tail -60 | mask
echo "::endgroup::"
