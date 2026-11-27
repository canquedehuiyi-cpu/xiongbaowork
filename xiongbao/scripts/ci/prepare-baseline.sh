#!/usr/bin/env bash
# Checks out the frozen baseline next to the tree under test and installs it from its own lockfiles.
#
# Three properties are asserted before the worktree exists, because each of them has silently cost a
# comparison section in the past:
#   - the pin is a full commit, not a branch (a moving baseline compares this change against nothing);
#   - the pin exists in this clone (03df9efa…, an earlier value, did not: it failed inside
#     `git worktree add` with "invalid reference", which reads like a checkout bug);
#   - the pin is an ancestor of HEAD (a baseline from another lineage makes every head failure "new").
#
# `--with-bots` also installs the bot packages, with the same commands ci.yml uses for the head tree.
# They are not root workspaces and each keeps its own lockfile, and the server suites need them for the
# same reason the head does: restored upstream suites spawn agent-bot, import agent-mastra's receiver and
# start agent-langgraph's server. Skip it and a modern baseline dies with
# "Cannot find module '@mastra/core/agent'" — a baseline failure that is only about the checkout.
set -euo pipefail
: "${RUNNER_TEMP:?set RUNNER_TEMP to an isolated temporary directory}"
: "${DELIVERY_BASELINE_SHA:?set a frozen baseline SHA}"

if [[ ! "$DELIVERY_BASELINE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "DELIVERY_BASELINE_SHA must be a full 40-hex commit, got '$DELIVERY_BASELINE_SHA'" >&2
  exit 1
fi
if ! git cat-file -e "$DELIVERY_BASELINE_SHA^{commit}" 2>/dev/null; then
  echo "the pinned baseline $DELIVERY_BASELINE_SHA is not in this clone; the checkout needs fetch-depth: 0" >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$DELIVERY_BASELINE_SHA" HEAD; then
  echo "the pinned baseline $DELIVERY_BASELINE_SHA is not an ancestor of HEAD; its failures are not this change's baseline" >&2
  exit 1
fi
echo "frozen baseline: $(git log -1 --format='%h %cs %s' "$DELIVERY_BASELINE_SHA")"

git worktree add --detach "$RUNNER_TEMP/delivery-baseline" "$DELIVERY_BASELINE_SHA"

if [ "${1:-}" = "--with-bots" ]; then
  # Ask baseline-dir.sh rather than assuming the product directory: a pin without it has no bot packages
  # to install here anyway.
  bots="$(bash "$(dirname "${BASH_SOURCE[0]}")/baseline-dir.sh" 2>/dev/null || true)"
  # Same four commands, same order, same flags as the job that installs the head tree.
  if [ -n "$bots" ] && [ -f "$bots/agent-computer/package.json" ]; then
    ( cd "$bots/agent-computer" && bun install --frozen-lockfile --ignore-scripts )
  fi
  if [ -n "$bots" ] && [ -f "$bots/agent-bot/package.json" ]; then
    ( cd "$bots/agent-bot" && bun install --frozen-lockfile )
  fi
  if [ -n "$bots" ] && [ -f "$bots/agent-langgraph/package.json" ]; then
    ( cd "$bots/agent-langgraph" && bun install --frozen-lockfile )
  fi
  if [ -n "$bots" ] && [ -f "$bots/agent-mastra/package.json" ]; then
    ( cd "$bots/agent-mastra" && bun install )
  fi
fi

cd "$(bash "$(dirname "${BASH_SOURCE[0]}")/baseline-dir.sh")"
bun install --frozen-lockfile
