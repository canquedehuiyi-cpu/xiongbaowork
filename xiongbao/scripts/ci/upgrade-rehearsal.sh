#!/usr/bin/env bash
# The upgrade from v0.2.16 to this tree, rehearsed on a throwaway machine with v0.2.16's real image and a
# volume it built, the way the JD Cloud server will take it.
#
#   bash scripts/ci/upgrade-rehearsal.sh <v0.2.16 image> <image under test> <evidence dir>
#
# Run from xiongbao/, with Docker and bun. It removes the containers and volumes it names (all prefixed
# xb-rehearsal-) before it starts and when it ends: never on a machine that runs anything under those names.
#
# The story:
#   1. v0.2.16 on a new volume (its first boot migrates the history 0000–0241 and renames the superuser and
#      the database), and a row written the way the service writes one.
#   2. This tree's image on the same volume: the migrator finds the history in the ledger, checks the
#      database has been through v0.2.16 and has the baseline's structure, and rewrites the ledger to the
#      baseline's row, keeping the replaced rows beside it, then runs every migration after the baseline
#      (0001 adds the memory correction columns). It serves, and the row is there.
#   3. A second start: nothing is adopted again, the ledger is as the first start left it.
#   4. The way back: the migrations after the baseline undone (scripts/rollback-after-baseline.ts), the kept
#      rows put back, v0.2.16's image starts on the same volume again, and this tree's adopts it again.
#   5. A v0.2.16 volume whose structure was changed by hand (one more index): this tree's image refuses to
#      start, prints the difference, and changes nothing, so v0.2.16 still starts on it.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: bash scripts/ci/upgrade-rehearsal.sh <v0.2.16 image> <image under test> <evidence dir>" >&2
  exit 2
fi
OLD_IMAGE=$1
NEW_IMAGE=$2
EVIDENCE=$3
NAME=xb-rehearsal
CONTAINERS=("$NAME" "$NAME-mismatch")
VOLUMES=("$NAME-db" "$NAME-db-mismatch")
KEY=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
mkdir -p "$EVIDENCE"
: >"$EVIDENCE/result.txt"
FAILS=0
RUN=0

pass() { echo "ok - $1" | tee -a "$EVIDENCE/result.txt"; }
fail() {
  echo "FAIL: $1" | tee -a "$EVIDENCE/result.txt" >&2
  FAILS=$((FAILS + 1))
}
expect() { # what expected actual
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1: expected '$2', got '$3'"; fi
}
die() {
  echo "FAIL: $1" | tee -a "$EVIDENCE/result.txt" >&2
  exit 1
}

remove_all() {
  docker rm -f "${CONTAINERS[@]}" >/dev/null 2>&1 || true
  docker volume rm -f "${VOLUMES[@]}" >/dev/null 2>&1 || true
}
keep_log() { # container label
  docker logs "$1" >"$EVIDENCE/$(printf '%02d' "$RUN")-$2.log" 2>&1 || true
}
trap remove_all EXIT
remove_all

# start <container> <volume> <image>: a container as the delivery runs one, embedded database on.
start() {
  RUN=$((RUN + 1))
  docker run -d --name "$1" -p 127.0.0.1:3772:3001 \
    -v "$2:/var/lib/postgresql" \
    -e EMBEDDED_POSTGRES=on -e EMBEDDED_COMPUTER=off -e DO_NOT_TRACK=1 \
    -e XIONGBAO_SINGLE_USER=true -e XIONGBAO_PUBLIC_URL=http://localhost:3772 \
    -e KEY_ENCRYPTION_KEY="$KEY" "$3" >/dev/null
}
healthy() { curl -fsS --max-time 3 http://127.0.0.1:3772/health >/dev/null 2>&1; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }
wait_healthy() { # container what
  local deadline=$((SECONDS + 300))
  until healthy; do
    [ "$SECONDS" -lt "$deadline" ] || { keep_log "$1" unhealthy; die "$2: not healthy within 300 seconds"; }
    sleep 3
  done
  pass "$2"
}
stop() { # container label
  keep_log "$1" "$2"
  docker rm -f "$1" >/dev/null
}
# SQL through the container's own owner connection string; statements on stdin.
owner_sql() { # container
  docker exec -i "$1" sh -c 'u=$(cat /run/s6/container_environment/MIGRATION_DATABASE_URL); exec /usr/lib/postgresql/16/bin/psql "$u" -X -q -A -t -v ON_ERROR_STOP=1'
}
app_sql() { # container
  docker exec -i "$1" sh -c 'u=$(cat /run/s6/container_environment/DATABASE_URL); exec /usr/lib/postgresql/16/bin/psql "$u" -X -q -A -t -v ON_ERROR_STOP=1'
}
ledger() { echo "SELECT count(*) || ' ' || coalesce(string_agg(hash, ',' ORDER BY id), '') FROM drizzle.__drizzle_migrations;" | owner_sql "$1"; }

BASELINE_HASH=$(sha256sum server/drizzle/0000_baseline.sql | cut -d' ' -f1)
BASELINE_WHEN=$(bun -e 'console.log(JSON.parse(require("fs").readFileSync("server/drizzle/meta/_journal.json", "utf8")).entries[0].when)')
# The ledger this tree's folder leaves: the baseline's row, then one per migration after it, as ledger() prints it.
FOLDER_LEDGER=$(bun -e '
  const { readFileSync } = require("fs");
  const { createHash } = require("crypto");
  const entries = JSON.parse(readFileSync("server/drizzle/meta/_journal.json", "utf8")).entries;
  const hashes = entries.map((e) => createHash("sha256").update(readFileSync(`server/drizzle/${e.tag}.sql`)).digest("hex"));
  console.log(`${hashes.length} ${hashes.join(",")}`);')
# Undoing every migration after the baseline: the first step of the way back to v0.2.16.
ROLLBACK_SQL=$(cd server && bun scripts/rollback-after-baseline.ts)
printf 'old_image=%s\nnew_image=%s\nbaseline=%s %s\nfolder_ledger=%s\n' "$OLD_IMAGE" "$NEW_IMAGE" "$BASELINE_HASH" "$BASELINE_WHEN" "$FOLDER_LEDGER" | tee "$EVIDENCE/images.txt"

# ---------------------------------------------------------------------------------------------------
# 1. v0.2.16 on a new volume, and a row the way the service writes one.
start "$NAME" "$NAME-db" "$OLD_IMAGE"
wait_healthy "$NAME" "v0.2.16 starts on a new volume"
expect "v0.2.16 left the superuser and the database under the new names" "xiongbao|xiongbao" \
  "$(echo 'SELECT current_user || chr(124) || current_database();' | owner_sql "$NAME")"
HISTORY=$(ledger "$NAME")
HISTORY_ROWS=${HISTORY%% *}
expect "v0.2.16's ledger holds its whole history" 222 "$HISTORY_ROWS"
owner_sql "$NAME" <<'SQL' >/dev/null
SET app.tenant_id = 'platform';
INSERT INTO users (id, email, name) VALUES ('rehearsal-person', 'rehearsal-person@example.test', 'Rehearsal');
SQL
expect "the app role reads the row" "rehearsal-person@example.test" \
  "$(echo "SET app.tenant_id = 'platform'; SELECT email FROM users WHERE id = 'rehearsal-person';" | app_sql "$NAME")"
stop "$NAME" v0216-first

# ---------------------------------------------------------------------------------------------------
# 2. This tree's image on the same volume: the ledger is taken onto the baseline.
start "$NAME" "$NAME-db" "$NEW_IMAGE"
wait_healthy "$NAME" "this tree's image starts on v0.2.16's volume"
log=$(docker logs "$NAME" 2>&1)
printf '%s\n' "$log" | grep -q "\"type\":\"migration-baseline-adopted\",\"replaced\":$HISTORY_ROWS" &&
  pass "the start says it took the ledger onto the baseline, replacing $HISTORY_ROWS rows" ||
  fail "no migration-baseline-adopted line for $HISTORY_ROWS rows"
expect "the ledger is the baseline's row, then every migration after it" "$FOLDER_LEDGER" "$(ledger "$NAME")"
expect "the baseline's row carries its journal stamp" "$BASELINE_HASH $BASELINE_WHEN" \
  "$(echo "SELECT hash || ' ' || created_at FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 1;" | owner_sql "$NAME")"
expect "the memory correction columns (0001, after the baseline) are there" "correction_count,from_correction,replaces_id" \
  "$(echo "SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'personal_memories' AND column_name IN ('from_correction', 'correction_count', 'replaces_id');" | owner_sql "$NAME")"
expect "the replaced rows are kept beside it" "$HISTORY" \
  "$(echo "SELECT count(*) || ' ' || string_agg(hash, ',' ORDER BY id) FROM drizzle.__drizzle_migrations_before_baseline;" | owner_sql "$NAME")"
expect "the row written under v0.2.16 is there for the app role" "rehearsal-person@example.test" \
  "$(echo "SET app.tenant_id = 'platform'; SELECT email FROM users WHERE id = 'rehearsal-person';" | app_sql "$NAME")"
expect "the app role is still bound by row-level security" "xiongbao_app|false|false" \
  "$(echo 'SELECT current_user || chr(124) || rolsuper || chr(124) || rolbypassrls FROM pg_roles WHERE rolname = current_user;' | app_sql "$NAME")"

# ---------------------------------------------------------------------------------------------------
# 3. A second start changes nothing.
keep_log "$NAME" new-first
RUN=$((RUN + 1))
docker restart "$NAME" >/dev/null
sleep 5
wait_healthy "$NAME" "this tree's image starts a second time"
since_restart=$(docker logs --since "$(docker inspect -f '{{.State.StartedAt}}' "$NAME")" "$NAME" 2>&1)
printf '%s\n' "$since_restart" | grep -q 'migration-baseline-adopted' &&
  fail "the second start adopted the baseline again" || pass "the second start does not adopt again"
expect "the ledger is as the first start left it" "$FOLDER_LEDGER" "$(ledger "$NAME")"

# ---------------------------------------------------------------------------------------------------
# 4. The way back: every migration after the baseline undone, the kept rows put back, and v0.2.16 starts on
#    the volume again; then this tree's image adopts it again.
printf '%s\n' "$ROLLBACK_SQL" | owner_sql "$NAME" >/dev/null
owner_sql "$NAME" <<'SQL' >/dev/null
BEGIN;
DELETE FROM drizzle.__drizzle_migrations;
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at)
  SELECT id, hash, created_at FROM drizzle.__drizzle_migrations_before_baseline;
COMMIT;
SQL
stop "$NAME" new-second
start "$NAME" "$NAME-db" "$OLD_IMAGE"
wait_healthy "$NAME" "with the kept rows put back, v0.2.16 starts on the volume again"
expect "and its ledger is the history again" "$HISTORY" "$(ledger "$NAME")"
stop "$NAME" v0216-back
start "$NAME" "$NAME-db" "$NEW_IMAGE"
wait_healthy "$NAME" "after the way back, this tree's image adopts the volume again"
expect "with the same ledger as the first time" "$FOLDER_LEDGER" "$(ledger "$NAME")"
stop "$NAME" new-again

# ---------------------------------------------------------------------------------------------------
# 5. A structure changed by hand is refused, with the difference printed, and nothing changes.
M=$NAME-mismatch
start "$M" "$NAME-db-mismatch" "$OLD_IMAGE"
wait_healthy "$M" "v0.2.16 starts on a second new volume"
echo 'CREATE INDEX rehearsal_extra ON public.users USING btree (name);' | owner_sql "$M" >/dev/null
BEFORE=$(ledger "$M")
stop "$M" mismatch-v0216
start "$M" "$NAME-db-mismatch" "$NEW_IMAGE"
deadline=$((SECONDS + 300))
until docker logs "$M" 2>&1 | grep -q '和 v0.2.17 的基线不一致'; do
  [ "$SECONDS" -lt "$deadline" ] || { keep_log "$M" mismatch-new; die "the changed structure was not refused within 300 seconds"; }
  sleep 3
done
sleep 5
log=$(docker logs "$M" 2>&1)
printf '%s\n' "$log" >"$EVIDENCE/mismatch-refusal.log"
printf '%s\n' "$log" | grep -q 'index public.rehearsal_extra' && pass "the refusal names the index" ||
  fail "the refusal does not name the index"
printf '%s\n' "$log" | grep -q '数据库没有任何改动' && pass "the refusal says nothing changed" ||
  fail "the refusal does not say nothing changed"
healthy && fail "the refused start serves anyway" || pass "the refused start does not serve"
stop "$M" mismatch-new
start "$M" "$NAME-db-mismatch" "$OLD_IMAGE"
wait_healthy "$M" "v0.2.16 still starts on the refused volume"
expect "its ledger is untouched" "$BEFORE" "$(ledger "$M")"
stop "$M" mismatch-back

if [ "$FAILS" -ne 0 ]; then
  echo "$FAILS check(s) failed; see $EVIDENCE/result.txt" >&2
  exit 1
fi
echo "all checks passed" | tee -a "$EVIDENCE/result.txt"
