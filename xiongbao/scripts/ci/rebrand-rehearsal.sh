#!/usr/bin/env bash
# The v0.2.16 rename upgrade, rehearsed on a throwaway machine the way the upgrade sheet
# (docs/acceptance/HUMAN-STEPS.md, section 21) has the JD Cloud server do it: the sheet's own blocks
# (<!-- v0216:<name>:begin -->) run verbatim, under the sheet's own names (container xiongbao, volumes
# xiongbao-db / -workspace / -profiles, /opt/xiongbao/.env.delivery, ports 3772 and 3773).
#
#   bash scripts/ci/rebrand-rehearsal.sh <v0.2.15 image> <image under test> <evidence dir>
#
# Run from xiongbao/, with Docker and bun, as a user who can write /opt/xiongbao (CI creates it). It
# removes the sheet's containers and volumes before it starts and when it ends: never on a machine
# that runs a real deployment under those names.
#
# The story, one database all the way through:
#   1. v0.2.15 on a new volume, the server's env file shaped like production's (four OPENBOT_ names
#      and XIONGBAO_CONTENT_PORT), data written the way v0.2.15 wrote it: credentials sealed under kid
#      k1 (one of them under a key the deployment does not have), history carrying the old event name,
#      run properties, context title and error code, a person's message that happens to start with the
#      old card marker, plugin grants and a skin under the old markers, rows the app role reads.
#   2. Sheet steps ①–③: the pre-upgrade check (the credential check names the credential that does not
#      open; the rehearsal goes on regardless), the env rewrite, the guarded switch. That credential
#      stops the upgrade: the log must say the business database did not change.
#   3. Rollback A: back to v0.2.15 on the same volume, data as it was, the in-progress record gone.
#   4. The broken credential removed (what the operator would sort out), steps ① and ③ again: the
#      upgrade goes through. Step ④'s summary and backups (each 0600, postgres), step ⑤'s checks,
#      every kind of data written in 1 read back under the new names, the API answering.
#   5. A second start: nothing renamed, nothing backed up, nothing rekeyed.
#   6. Rollback B: v0.2.15 started once on another new volume and stopped, the backup restored by the
#      image's rebrand-restore.sh in a one-shot v0.2.15 container on that volume (v0.2.15's api finish
#      script halts the whole container, so the restore never runs inside it), then v0.2.15 started again:
#      its app role is v0.2.15's and cannot write user_roles, the data is as backed up.
#
# legacy-compat：introducedIn 0.2.16，removeIn 0.2.17，the old names below are what v0.2.15 wrote and
# what this rehearsal upgrades from; it goes with the rename migration.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: bash scripts/ci/rebrand-rehearsal.sh <v0.2.15 image> <image under test> <evidence dir>" >&2
  exit 2
fi
OLD_IMAGE=$1
NEW_IMAGE=$2
EVIDENCE=$3
SHEET=../docs/acceptance/HUMAN-STEPS.md
D=/opt/xiongbao/upgrade-v0.2.16
ENV_FILE=/opt/xiongbao/.env.delivery
CONTAINERS=(xiongbao xiongbao-v0215-rollback xiongbao-v0216-failed xiongbao-v0216-stopped)
VOLUMES=(xiongbao-db xiongbao-workspace xiongbao-profiles xiongbao-db-v0215-restore)
mkdir -p "$EVIDENCE"
: >"$EVIDENCE/result.txt"
FAILS=0
STEP=0

pass() { echo "ok - $1" | tee -a "$EVIDENCE/result.txt"; }
fail() {
  echo "FAIL: $1" | tee -a "$EVIDENCE/result.txt" >&2
  FAILS=$((FAILS + 1))
}
# expect <what> <expected> <actual>
expect() {
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
finish() {
  for c in "${CONTAINERS[@]}"; do
    docker logs "$c" >"$EVIDENCE/container-$c.log" 2>&1 || rm -f "$EVIDENCE/container-$c.log"
  done
  remove_all
  # The env file and its backups carry the deployment's key: never kept as evidence, removed with the rest.
  rm -rf "$D" "$ENV_FILE" "$ENV_FILE".bak-*
}
trap finish EXIT
remove_all
rm -rf "$D" "$ENV_FILE" "$ENV_FILE".bak-*

# sheet <name>: one block of the upgrade sheet, extracted and run as written. Its output is kept.
sheet() {
  STEP=$((STEP + 1))
  local base
  base="$EVIDENCE/$(printf '%02d' "$STEP")-${1//:/-}"
  bun scripts/ci/manual-blocks.mjs "$SHEET" "$1" >"$base.sh"
  echo "::group::sheet $1"
  set +e
  bash "$base.sh" >"$base.out" 2>&1
  SHEET_RC=$?
  set -e
  cat "$base.out"
  echo "::endgroup::"
  SHEET_OUT=$base.out
}

# SQL through the container's own connection strings: the owner's (whatever the names are now) or the
# API's (the app role). Statements on stdin; nothing secret leaves the container.
owner_sql() {
  docker exec -i xiongbao sh -c 'u=$(cat /run/s6/container_environment/MIGRATION_DATABASE_URL); exec /usr/lib/postgresql/16/bin/psql "$u" -X -q -A -t -v ON_ERROR_STOP=1'
}
app_sql() {
  docker exec -i xiongbao sh -c 'u=$(cat /run/s6/container_environment/DATABASE_URL); exec /usr/lib/postgresql/16/bin/psql "$u" -X -q -A -t -v ON_ERROR_STOP=1'
}
healthy() { curl -fsS --max-time 3 http://127.0.0.1:3772/health >/dev/null 2>&1; }
wait_healthy() { # what
  local deadline=$((SECONDS + 300))
  until healthy; do
    [ "$SECONDS" -lt "$deadline" ] || die "$1: not healthy within 300 seconds"
    sleep 3
  done
  pass "$1"
}
backups() { docker exec xiongbao sh -c 'ls /var/lib/postgresql/backup/pre-rebrand-*.dump 2>/dev/null | wc -l' | tr -d ' '; }

# A credential envelope exactly as v0.2.15 sealed one (kid k1, the label before v0.2.16), written out
# here rather than taken from the code under test, sealed inside the container with the deployment's
# KEY_ENCRYPTION_KEY, or with a key it does not have (`foreign`).
SEAL_V0215='
const [tenant, id, kind, plaintext] = process.argv.slice(1);
const frame = (part) => { const b = Buffer.from(part, "utf8"); const n = Buffer.alloc(4); n.writeUInt32BE(b.length); return [n, b]; };
const aad = Buffer.concat(["openbot.vault.credential.v2", tenant, id, kind].flatMap(frame));
const key = await crypto.subtle.importKey("raw", Buffer.from(process.env.SEAL_KEY, "base64"), { name: "AES-GCM" }, false, ["encrypt"]);
const iv = crypto.getRandomValues(new Uint8Array(12));
const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, Buffer.from(plaintext, "utf8"));
process.stdout.write(JSON.stringify({ version: 2, alg: "A256GCM", bind: "credential", kid: "k1",
  iv: Buffer.from(iv).toString("base64"), ciphertext: Buffer.from(ciphertext).toString("base64") }));
'
seal() { # deployment|foreign tenant id kind plaintext
  docker exec xiongbao sh -c '
    if [ "$1" = deployment ]; then SEAL_KEY=$(cat /run/s6/container_environment/KEY_ENCRYPTION_KEY)
    else SEAL_KEY=$(head -c 32 /dev/urandom | base64 | tr -d "\n"); fi
    export SEAL_KEY
    shift
    exec bun -e "$0" "$@"' "$SEAL_V0215" "$@"
}
# "<id> <kid> <plaintext or (does not open)>" for each rehearsal credential, opened inside the container
# with the deployment's key under the label its kid names.
OPEN_ROWS='
const labels = { k1: "openbot.vault.credential.v2", k2: "xiongbao.vault.credential.v2" };
const frame = (part) => { const b = Buffer.from(part, "utf8"); const n = Buffer.alloc(4); n.writeUInt32BE(b.length); return [n, b]; };
const key = await crypto.subtle.importKey("raw", Buffer.from(process.env.OPEN_KEY, "base64"), { name: "AES-GCM" }, false, ["decrypt"]);
const lines = [];
for (const row of JSON.parse(await Bun.stdin.text())) {
  const envelope = JSON.parse(row.value);
  let opened = "(does not open)";
  try {
    const aad = Buffer.concat([labels[envelope.kid], row.tenant, row.id, row.kind].flatMap(frame));
    opened = Buffer.from(await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(envelope.iv, "base64"), additionalData: aad },
      key, Buffer.from(envelope.ciphertext, "base64"))).toString("utf8");
  } catch {}
  lines.push(`${row.id} ${envelope.kid} ${opened}`);
}
console.log(lines.join(","));
'
credentials() {
  echo "SELECT coalesce(json_agg(json_build_object('id', id, 'tenant', tenant_id, 'kind', kind, 'value', encrypted_value) ORDER BY id), '[]')
    FROM credentials WHERE provider = 'rehearsal';" | owner_sql |
    docker exec -i xiongbao sh -c 'OPEN_KEY=$(cat /run/s6/container_environment/KEY_ENCRYPTION_KEY) exec bun -e "$0"' "$OPEN_ROWS"
}

HISTORY_EVENT='{"type":"CUSTOM","name":"openbot.headless.waiting","value":{"kind":"approval","continuation":{"threadId":"rehearsal-thread","runId":"rehearsal-run","messages":[],"context":[{"description":"OpenBot standing role","value":"Be kind."}],"forwardedProps":{"openbotRun":"signed","openbotTimeZone":"Asia/Shanghai"}}}}'
HISTORY_ERROR='{"type":"RUN_ERROR","message":"refused","code":"OPENBOT_MODEL_REFUSED"}'
HISTORY_SNAPSHOT='[{"id":"m-1","role":"user","content":"<<openbot:staffing-proposal>>{} typed by the person"}]'
# The stored event's name, run property keys and context titles, the error code, and whether the
# person's message is byte for byte what they wrote.
history() {
  echo "SELECT h.event ->> 'name' || ' '
      || (SELECT string_agg(k, ',' ORDER BY k COLLATE \"C\") FROM jsonb_object_keys(h.event #> '{value,continuation,forwardedProps}') k) || ' '
      || jsonb_path_query_array(h.event, '\$.value.continuation.context[*].description')::text || ' '
      || (SELECT (event #>> '{}')::jsonb ->> 'code' FROM thread_run_events WHERE run_id = 'rehearsal-run' AND seq = 1) || ' '
      || (t.messages_snapshot #>> '{}' = '$HISTORY_SNAPSHOT')::text
    FROM (SELECT (event #>> '{}')::jsonb AS event FROM thread_run_events WHERE run_id = 'rehearsal-run' AND seq = 0) h,
         threads t WHERE t.id = 'rehearsal-thread';" | owner_sql
}
HISTORY_V0215='openbot.headless.waiting openbotRun,openbotTimeZone ["OpenBot standing role"] OPENBOT_MODEL_REFUSED true'
HISTORY_V0216='xiongbao.headless.waiting xiongbaoRun,xiongbaoTimeZone ["XiongBao standing role"] XIONGBAO_MODEL_REFUSED true'
probe() { echo "SELECT count(*) || ':' || md5(string_agg(id || ':' || body, ',' ORDER BY id)) FROM public.rehearsal_probe;" | "$1"; }
markers() {
  echo "SELECT (SELECT preferences ->> 'skin' FROM users WHERE id = 'rehearsal-person') || ' '
    || (SELECT string_agg(granted_by, ',' ORDER BY granted_by COLLATE \"C\") FROM plugin_grants WHERE agent_id = 'rehearsal-bot');" | owner_sql
}
app_role() { echo "SELECT current_user || '|' || rolsuper || '|' || rolbypassrls || '|' || has_table_privilege(current_user, 'public.user_roles', 'UPDATE') FROM pg_roles WHERE rolname = current_user;" | app_sql; }

# ---------------------------------------------------------------------------------------------------
# 1. v0.2.15 on a new volume, as the server runs it, with data the way v0.2.15 wrote it.
mkdir -p "$D"
chmod 700 "$D"
(
  umask 077
  {
    echo 'EMBEDDED_POSTGRES=on'
    echo 'OPENBOT_SINGLE_USER=true'
    echo 'OPENBOT_PUBLIC_URL=http://localhost:3772'
    echo 'OPENBOT_SELF_HOST_BANNER=false'
    echo 'OPENBOT_RLS_ENFORCE=refuse'
    echo 'TENANT_PACKAGE_DIR=../examples/xiongbao'
    echo 'TENANT_RUNTIME=cloud'
    echo 'XIONGBAO_CONTENT_PORT=3773'
    printf 'KEY_ENCRYPTION_KEY=%s\n' "$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
  } >"$ENV_FILE"
)
# The command the server's v0.2.15 container was created with (the v0.2.15 upgrade).
docker run -d --name xiongbao --restart unless-stopped --env-file "$ENV_FILE" \
  -p 0.0.0.0:3772:3001 -p 0.0.0.0:3773:3773 \
  -v xiongbao-db:/var/lib/postgresql -v xiongbao-workspace:/workspace -v xiongbao-profiles:/profiles \
  "$OLD_IMAGE" >/dev/null
wait_healthy "v0.2.15 starts on a new volume"

C1=00000000-0000-4000-8000-0000000000c1
C2=00000000-0000-4000-8000-0000000000c2
C9=00000000-0000-4000-8000-0000000000c9
env1=$(seal deployment rehearsal-person "$C1" model rehearsal-model-key)
env2=$(seal deployment team "$C2" mcp rehearsal-team-secret)
env9=$(seal foreign rehearsal-person "$C9" connector rehearsal-never-opens)
owner_sql <<SQL >/dev/null
SET app.tenant_id = 'platform';
INSERT INTO users (id, email, preferences) VALUES ('rehearsal-person', 'rehearsal-person@example.test', '{"skin":"openbot"}');
INSERT INTO agents (id, name, type, configuration, tenant_id) VALUES ('rehearsal-bot', 'Rehearsal Bot', 'built_in', '{}', 'system');
INSERT INTO plugin_grants (kind, ref, agent_id, granted_by, tenant_id) VALUES
  ('skill', 'rehearsal-skill', 'rehearsal-bot', 'openbot:personal-defaults', 'system'),
  ('mcp', 'rehearsal-app', 'rehearsal-bot', 'openbot:staffing-default', 'system');
INSERT INTO threads (id, tenant_id, agent_id, messages_snapshot)
  VALUES ('rehearsal-thread', 'rehearsal-person', 'rehearsal-bot', to_jsonb('$HISTORY_SNAPSHOT'::text));
INSERT INTO thread_run_events (thread_id, run_id, seq, event, tenant_id) VALUES
  ('rehearsal-thread', 'rehearsal-run', 0, to_jsonb('$HISTORY_EVENT'::text), 'rehearsal-person'),
  ('rehearsal-thread', 'rehearsal-run', 1, to_jsonb('$HISTORY_ERROR'::text), 'rehearsal-person');
INSERT INTO credentials (id, tenant_id, kind, provider, encrypted_value, key_id, metadata) VALUES
  ('$C1', 'rehearsal-person', 'model', 'rehearsal', '$env1', 'rehearsal-$C1', '{}'),
  ('$C2', 'team', 'mcp', 'rehearsal', '$env2', 'rehearsal-$C2', '{}'),
  ('$C9', 'rehearsal-person', 'connector', 'rehearsal', '$env9', 'rehearsal-$C9', '{}');
CREATE TABLE public.rehearsal_probe (id serial PRIMARY KEY, body text NOT NULL);
INSERT INTO public.rehearsal_probe (body) SELECT 'row ' || g FROM generate_series(1, 500) g;
GRANT SELECT ON public.rehearsal_probe TO openbot_app;
SQL
PROBE=$(probe owner_sql)
expect "the app role of v0.2.15 reads the rows written for it" "$PROBE" "$(probe app_sql)"
expect "v0.2.15 holds the history under the old names" "$HISTORY_V0215" "$(history)"
expect "v0.2.15 holds the credentials under kid k1" \
  "$C1 k1 rehearsal-model-key,$C2 k1 rehearsal-team-secret,$C9 k1 (does not open)" "$(credentials)"
PACKAGE_V0215=$(echo "SELECT count(*) FROM deployment_packages WHERE tenant_id = 'openbot';" | owner_sql)
echo "deployment package rows under the old tenant id: $PACKAGE_V0215" | tee -a "$EVIDENCE/result.txt"

# ---------------------------------------------------------------------------------------------------
# 2. Steps 0–③ (the sheet's download and pull come from the release; here the scripts come from this
#    tree and the images are the ones under test), and an upgrade the broken credential stops.
cp scripts/rebrand/pre-upgrade-check.sh scripts/rebrand/prod-inspect.sh scripts/rebrand/rewrite-env.sh "$D/"
printf 'NEW_IMAGE=%s\nOLD_IMAGE=%s\n' "$NEW_IMAGE" "$(docker inspect --format '{{.Config.Image}}' xiongbao)" >"$D/images.env"
sheet v0216:check
grep -q '结论：可以升级' "$SHEET_OUT" && pass "step ①: the pre-upgrade check says go" || fail "step ①: the pre-upgrade check does not say go"
for name in automation_hooks_signed opentag_chat_bindings web_bot_auth_env_named approval_exact_input_captures approval_exact_input_objects; do
  grep -qx "$name=0" "$SHEET_OUT" || fail "step ①: $name is not 0"
done
grep -qx 'credentials_live_kid_k1=3' "$SHEET_OUT" && pass "step ①: three live k1 credentials counted" ||
  fail "step ①: the k1 count is not 3: $(grep '^credentials_' "$SHEET_OUT" | tr '\n' ' ')"
grep -q 'xiongbao-db:/var/lib/postgresql' "$SHEET_OUT" && grep -q '3772->3001/tcp' "$SHEET_OUT" &&
  pass "step ①: the volumes and ports the sheet names are the container's" || fail "step ①: volumes or ports differ from the sheet"
grep -Eq '^shm=67108864 memory=0 cpus=0 restart=unless-stopped network=(default|bridge) security=\[\] capadd=\[\] devices=0$' "$SHEET_OUT" &&
  pass "step ①: the other run settings are the ones the sheet says to expect" ||
  fail "step ①: other run settings: $(grep '^shm=' "$SHEET_OUT")"
sheet v0216:credcheck
grep -qF "要重新加密的旧格式凭据 3 条，能解开 2 条，解不开 1 条：$C9" "$SHEET_OUT" &&
  pass "step ①: the credential check finds the one that does not open" || fail "step ①: the credential check missed it"

sheet v0216:rewrite-env
expect "step ②: no OPENBOT_ line is left in the env file" 0 "$(grep -c '^OPENBOT_' "$ENV_FILE" || true)"
envb=$(ls "$ENV_FILE".bak-* 2>/dev/null | head -n 1 || true)
[ -n "$envb" ] && expect "step ②: the env backup is 0600" 600 "$(stat -c '%a' "$envb")" || fail "step ②: no env backup"
grep -qx 'XIONGBAO_PUBLIC_URL=http://localhost:3772' "$ENV_FILE" && pass "step ②: the value moved to the new name" ||
  fail "step ②: XIONGBAO_PUBLIC_URL is not the old value"

sheet v0216:switch
expect "step ③: the switch ran" 0 "$SHEET_RC"
expect "step ③: xiongbao runs the image under test" "$NEW_IMAGE" "$(docker inspect -f '{{.Config.Image}}' xiongbao)"
expect "step ③: the old container is kept, stopped, not restarted" "exited no" \
  "$(docker inspect -f '{{.State.Status}} {{.HostConfig.RestartPolicy.Name}}' xiongbao-v0215-rollback)"
deadline=$((SECONDS + 300))
until docker logs xiongbao 2>&1 | grep -q '「数据库迁移」这一步失败'; do
  [ "$SECONDS" -lt "$deadline" ] || die "the upgrade with a credential that does not open did not stop at the migration"
  sleep 3
done
sleep 5
log=$(docker logs xiongbao 2>&1)
printf '%s\n' "$log" >"$EVIDENCE/failed-upgrade.log"
printf '%s\n' "$log" | grep -q '业务库没有改动' && pass "a credential that does not open stops the upgrade, business database unchanged" ||
  fail "the failed upgrade does not say the business database is unchanged"
printf '%s\n' "$log" | grep -q "凭据 $C9" && pass "the failure names the credential" || fail "the failure does not name the credential"
printf '%s\n' "$log" | grep -q '升级前备份已写好：/var/lib/postgresql/backup/pre-rebrand-' &&
  pass "the failed upgrade backed up first" || fail "no backup line before the failed upgrade"
healthy && fail "the failed upgrade serves anyway" || pass "the failed upgrade does not serve"

# ---------------------------------------------------------------------------------------------------
# 3. Rollback A: v0.2.15 again on the same volume, nothing lost, the in-progress record gone.
sheet v0216:rollback-a
expect "rollback A ran" 0 "$SHEET_RC"
sheet v0216:health
wait_healthy "rollback A: v0.2.15 serves again"
expect "rollback A: xiongbao runs v0.2.15" "$(. "$D/images.env" && echo "$OLD_IMAGE")" "$(docker inspect -f '{{.Config.Image}}' xiongbao)"
expect "rollback A: the rows are as they were" "$PROBE" "$(probe owner_sql)"
expect "rollback A: the history is as it was" "$HISTORY_V0215" "$(history)"
expect "rollback A: the credentials are as they were" \
  "$C1 k1 rehearsal-model-key,$C2 k1 rehearsal-team-secret,$C9 k1 (does not open)" "$(credentials)"
docker exec xiongbao test ! -e /var/lib/postgresql/backup/rebrand-in-progress &&
  pass "rollback A: the in-progress record is gone" || fail "rollback A: the in-progress record is still there"
expect "rollback A: the failed container is kept, stopped, not restarted" "exited no" \
  "$(docker inspect -f '{{.State.Status}} {{.HostConfig.RestartPolicy.Name}}' xiongbao-v0216-failed)"

# ---------------------------------------------------------------------------------------------------
# 4. The broken credential sorted out on v0.2.15, then the upgrade again: it goes through.
echo "SET app.tenant_id = 'platform'; DELETE FROM credentials WHERE id = '$C9';" | owner_sql >/dev/null
sheet v0216:check
grep -q '结论：可以升级' "$SHEET_OUT" && pass "step ① again: the pre-upgrade check says go" || fail "step ① again: no go"
sheet v0216:credcheck
grep -qx '要重新加密的旧格式凭据 2 条，能解开 2 条。' "$SHEET_OUT" &&
  pass "step ① again: every credential to rekey opens" || fail "step ① again: the credential check does not say all open"
sheet v0216:switch
expect "step ③ again: the switch ran" 0 "$SHEET_RC"
sheet v0216:health
wait_healthy "step ④: v0.2.16 serves after the rename"
sheet v0216:summary
for line in '升级前备份已写好：/var/lib/postgresql/backup/pre-rebrand-' '"type":"credentials-rekeyed","rekeyed":2' \
  '数据库超级用户与库已改名为 xiongbao' '改名迁移全部完成。升级前的备份保留在'; do
  grep -qF "$line" "$SHEET_OUT" && pass "step ④ summary: $line" || fail "step ④ summary lacks: $line"
done
grep -q 'OPENBOT_ prefix' "$SHEET_OUT" && fail "step ④: the old-prefix warning is still printed" || pass "step ④: no old-prefix warning"
sheet v0216:backup
expect "step ④: the backup copy ran" 0 "$SHEET_RC"
expect "step ④: two backups on the volume (the failed attempt's and this one's)" 2 "$(backups)"
expect "step ④: every backup is 0600 postgres:postgres" "600 postgres postgres
600 postgres postgres" "$(docker exec xiongbao sh -c 'stat -c "%a %U %G" /var/lib/postgresql/backup/pre-rebrand-*.dump')"
expect "step ④: each backup has its database size beside it, 0600 postgres:postgres" "600 postgres postgres
600 postgres postgres" "$(docker exec xiongbao sh -c 'stat -c "%a %U %G" /var/lib/postgresql/backup/pre-rebrand-*.dump.size')"
hostcopy=$(ls "$D"/pre-rebrand-*.dump 2>/dev/null | tail -n 1 || true)
[ -n "$hostcopy" ] && expect "step ④: the host copy is 0600" 600 "$(stat -c '%a' "$hostcopy")" || fail "step ④: no host copy"

sheet v0216:verify
grep -qx 'xiongbao_app|f|f' "$SHEET_OUT" && pass "step ⑤: the API connects as xiongbao_app, no superuser, no BYPASSRLS" ||
  fail "step ⑤: the API's role is not xiongbao_app|f|f"
for name in credentials_live_kid_k1 deployment_packages_tenant_old_brand plugin_grants_granted_by_old_brand user_skin_old_brand; do
  grep -qx "$name=0" "$SHEET_OUT" || fail "step ⑤: $name is not 0"
done
expect "step ⑤: no role, database, function or trigger carries the old name" "" \
  "$(sed -n '/^# roles whose/,/^database_size_bytes/p' "$SHEET_OUT" | grep -v '^#\|^database_size_bytes' || true)"
sheet v0216:recheck
# Each key by name, so an empty answer (prod-inspect not reaching the database) cannot pass.
for name in automation_hooks_signed opentag_chat_bindings web_bot_auth_env_named learning_settings_rows \
  learning_person_spaces_rows shared_account_mcp_servers shared_account_composio_connections \
  shared_account_brokered_accounts shared_account_pending_authorizations; do
  grep -Eqx "$name=(0|n/a)" "$SHEET_OUT" && pass "step ⑦: $name has nothing to reconnect" ||
    fail "step ⑦: $name is not 0: $(grep "^$name=" "$SHEET_OUT" || echo missing)"
done
expect "step ⑦: nothing to reconnect" "" "$(grep -E '=' "$SHEET_OUT" | grep -vE '=(0|n/a)$' || true)"

expect "after the upgrade: the rows are as they were" "$PROBE" "$(probe owner_sql)"
expect "after the upgrade: the app role reads them" "$PROBE" "$(probe app_sql)"
expect "after the upgrade: the app role cannot write user_roles" "xiongbao_app|f|f|f" "$(app_role)"
expect "after the upgrade: the history is under the new names, the person's text untouched" "$HISTORY_V0216" "$(history)"
expect "after the upgrade: the credentials are kid k2 and open to the same secrets" \
  "$C1 k2 rehearsal-model-key,$C2 k2 rehearsal-team-secret" "$(credentials)"
expect "after the upgrade: skin and grant markers are the new ones" \
  "xiongbao xiongbao:personal-defaults,xiongbao:staffing-default" "$(markers)"
expect "after the upgrade: the superuser and database are renamed" "xiongbao xiongbao 0" \
  "$(echo "SELECT session_user || ' ' || current_database() || ' ' || (SELECT count(*) FROM pg_roles WHERE rolname ILIKE '%openbot%');" | owner_sql)"
if [ "$PACKAGE_V0215" = 1 ]; then
  expect "after the upgrade: the package row is renamed and keeps the digest of its old name" 1 \
    "$(echo "SELECT count(*) FROM deployment_packages WHERE tenant_id = 'xiongbao' AND former_name_digest = encode(sha256('openbot'::bytea), 'hex');" | owner_sql)"
fi
bun scripts/ci/assert-image.mjs http://127.0.0.1:3772 "$EVIDENCE" >"$EVIDENCE/assert-image.out" 2>&1 &&
  pass "after the upgrade: the API answers as the image gate expects" ||
  fail "after the upgrade: the image gate's API assertions: $(grep FAIL "$EVIDENCE/assert-image.out" | head -n 5 | tr '\n' ' ')"

# ---------------------------------------------------------------------------------------------------
# 5. A second start does nothing: no rename, no backup, no rekey, the same journal.
journal=$(echo "SELECT count(*) FROM drizzle.__drizzle_migrations;" | owner_sql)
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sleep 1
docker restart -t 30 xiongbao >/dev/null
wait_healthy "a second start serves"
expect "a second start prints nothing about the rename" 0 \
  "$(docker logs --since "$since" xiongbao 2>&1 | grep -cE 'rebrand-|credentials-rekeyed' || true)"
expect "a second start makes no backup" 2 "$(backups)"
expect "a second start applies no migration" "$journal" "$(echo "SELECT count(*) FROM drizzle.__drizzle_migrations;" | owner_sql)"
expect "a second start leaves the data as it was" "$HISTORY_V0216" "$(history)"

# ---------------------------------------------------------------------------------------------------
# 6. Rollback B: v0.2.15 on a new volume, the latest backup restored with the image's restore script.
sheet v0216:rollback-b-stop
expect "rollback B: stopping v0.2.16 and taking the backup out ran" 0 "$SHEET_RC"
expect "rollback B: the env file is the one before the rewrite again" 4 "$(grep -c '^OPENBOT_' "$ENV_FILE" || true)"
sheet v0216:rollback-b-start
expect "rollback B: v0.2.15 started on a new volume" 0 "$SHEET_RC"
sheet v0216:health
wait_healthy "rollback B: v0.2.15 serves on the new volume"
sheet v0216:rollback-b-restore
expect "rollback B: the restore ran" 0 "$SHEET_RC"
grep -q '正在启动这个卷上的 PostgreSQL' "$SHEET_OUT" && grep -q '还原完成' "$SHEET_OUT" &&
  pass "rollback B: the one-shot container started the volume's database and the restore says it is done" ||
  fail "rollback B: the restore did not finish in the one-shot container"
sheet v0216:health
wait_healthy "rollback B: v0.2.15 serves the restored database"
sheet v0216:rollback-b-check
expect "rollback B: the API's role is v0.2.15's and cannot write user_roles" "openbot_app|f|f
f" "$(cat "$SHEET_OUT")"
expect "rollback B: xiongbao runs v0.2.15" "$(. "$D/images.env" && echo "$OLD_IMAGE")" "$(docker inspect -f '{{.Config.Image}}' xiongbao)"
expect "rollback B: the rows are as backed up" "$PROBE" "$(probe owner_sql)"
expect "rollback B: the app role reads them" "$PROBE" "$(probe app_sql)"
expect "rollback B: the history is as backed up" "$HISTORY_V0215" "$(history)"
expect "rollback B: the credentials are as backed up and open" \
  "$C1 k1 rehearsal-model-key,$C2 k1 rehearsal-team-secret" "$(credentials)"
expect "rollback B: the names are v0.2.15's, and only one database holds the data" "openbot openbot 0 openbot,postgres" \
  "$(echo "SELECT session_user || ' ' || current_database() || ' ' || (SELECT count(*) FROM pg_roles WHERE rolname LIKE 'xiongbao%') || ' '
      || (SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database WHERE NOT datistemplate);" | owner_sql)"
docker exec xiongbao test ! -e /var/lib/postgresql/backup && pass "rollback B: the new volume has no rename backup" ||
  fail "rollback B: the new volume has a backup directory"
expect "rollback B: the old volume's v0.2.16 container is kept, stopped" "exited no" \
  "$(docker inspect -f '{{.State.Status}} {{.HostConfig.RestartPolicy.Name}}' xiongbao-v0216-stopped)"

echo
if [ "$FAILS" -gt 0 ]; then
  echo "rehearsal: $FAILS failed" | tee -a "$EVIDENCE/result.txt"
  exit 1
fi
echo "rehearsal: all passed" | tee -a "$EVIDENCE/result.txt"
