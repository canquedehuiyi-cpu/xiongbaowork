#!/usr/bin/env bash
# The superuser name a server tree's migration history needs, or nothing for a tree on the baseline.
#
#   bash scripts/ci/history-owner.sh <server directory of a checkout>
#
# Until R4 Task 26 squashed the migrations into one baseline, migration 0054 granted default privileges
# FOR ROLE the superuser every database was migrated by before v0.2.16 renamed it, so a tree from before
# the baseline can only be migrated by a role of that name. CI's frozen baseline is such a tree for as
# long as its pin predates Task 26: this prints the name, read from that tree's own 0054, so the name is
# written down nowhere else. A tree whose drizzle/ has no 0054 prints nothing.
set -euo pipefail
[ "$#" -eq 1 ] || { echo 'usage: bash scripts/ci/history-owner.sh <server directory>' >&2; exit 2; }
migration="$1/drizzle/0054_app_role.sql"
[ -f "$migration" ] || exit 0
name="$(sed -n 's/^ALTER DEFAULT PRIVILEGES FOR ROLE \([a-z_]*\) .*/\1/p' "$migration" | head -n 1)"
[ -n "$name" ] || { echo "history-owner: $migration names no role" >&2; exit 1; }
printf '%s\n' "$name"
