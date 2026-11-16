#!/usr/bin/env bash
set -euo pipefail
: "${RUNNER_TEMP:?set RUNNER_TEMP to an isolated temporary directory}"
: "${DELIVERY_BASELINE_SHA:?set a frozen baseline SHA}"
git worktree add --detach "$RUNNER_TEMP/delivery-baseline" "$DELIVERY_BASELINE_SHA"
cd "$RUNNER_TEMP/delivery-baseline/openbot"
bun install --frozen-lockfile
