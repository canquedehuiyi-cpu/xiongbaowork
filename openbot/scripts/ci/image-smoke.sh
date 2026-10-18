#!/usr/bin/env bash
# Only disposable B containers and a new B volume. No env file or real provider key.
set -euo pipefail
image=${1:-openbot:trackb}
name="openbot-trackb-${GITHUB_RUN_ID:-local}-$$"
bad="$name-owner"
auth="$name-auth"
volume="$name-data"
evidence=${EVIDENCE_DIR:-$PWD/.delivery-evidence}
mkdir -p "$evidence"
evidence=$(cd "$evidence" && pwd)
secret_env=$(mktemp)
chmod 600 "$secret_env"
# MSYS_NO_PATHCONV protects container paths, so host file arguments need an
# explicit Windows conversion for docker.exe and the native bun.exe too.
evidence_native=$evidence
secret_env_native=$secret_env
if command -v cygpath >/dev/null 2>&1; then
  evidence_native=$(cygpath -m "$evidence")
  secret_env_native=$(cygpath -m "$secret_env")
fi
cleanup() {
  docker logs "$name" > "$evidence/startup.log" 2>&1 || true
  docker logs "$bad" > "$evidence/owner.log" 2>&1 || true
  docker logs "$auth" > "$evidence/auth.log" 2>&1 || true
  docker rm -f "$name" "$bad" "$auth" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -f "$secret_env"
}
trap cleanup EXIT
export MSYS_NO_PATHCONV=1
failures=0
check() {
  if "$@"; then echo "PASS $*"; else echo "FAIL $*"; failures=$((failures+1)); fi
}
wait_health() {
  local container=$1 deadline=$((SECONDS+60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:3772/health || true)" = 200 ]; then return 0; fi
    [ "$(docker inspect -f '{{.State.Running}}' "$container")" = true ] || break
    sleep 1
  done
  return 1
}
docker volume create "$volume" >/dev/null
key=$(bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"))')
docker run -d --name "$name" -p 127.0.0.1:3772:3001 \
  -v "$volume:/var/lib/postgresql" \
  -e EMBEDDED_POSTGRES=on -e EMBEDDED_COMPUTER=off -e COPILOTKIT_TELEMETRY_DISABLED=true \
  -e TENANT_PACKAGE_DIR=../examples/qoderwake \
  -e OPENBOT_SINGLE_USER=true -e OPENBOT_PUBLIC_URL=http://localhost:3772 \
  -e KEY_ENCRYPTION_KEY="$key" "$image" >/dev/null
deadline=$((SECONDS+60))
healthy=false
while [ "$SECONDS" -lt "$deadline" ]; do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:3772/health || true)" = 200 ]; then
    healthy=true; break
  fi
  [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || break
  sleep 1
done
check test "$healthy" = true
echo "HEALTH elapsed=${SECONDS}s (limit 60s)"
docker logs "$name" > "$evidence/startup.log" 2>&1
cp "$evidence/startup.log" "$evidence/initial.log"
check test "$(grep -ac 'rls-not-enforced\|rls-role-check-unavailable' "$evidence/startup.log" || true)" = 0
if [ "$healthy" = true ]; then
  check bun scripts/ci/assert-image.mjs http://127.0.0.1:3772 "$evidence_native"
  check docker exec "$name" sh -c 'test "$(stat -c %a /var/lib/postgresql/pgpassword)" = 600 && test "$(stat -c %a /var/lib/postgresql/pgpassword-app)" = 600'
  check test "$(docker exec "$name" sh -c 'url=$(cat /run/s6/container_environment/DATABASE_URL); /usr/lib/postgresql/16/bin/psql "$url" -At -v ON_ERROR_STOP=1 -c "select current_user, rolsuper, rolbypassrls from pg_roles where rolname=current_user"')" = 'openbot_app|f|f'
  check docker exec "$name" sh -c 'PGPASSWORD=openbot /usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -U openbot_app -d openbot -c "select 1" >/dev/null 2>&1; test "$?" -ne 0'
  check docker exec -u apiuser "$name" sh -c 'test ! -r /run/s6/container_environment/MIGRATION_DATABASE_URL'
  check docker exec "$name" sh -c 'test -z "$(find /app ! -user pwuser -print -quit)"'
  # Recreate against the same volume: both credentials and stored data survive.
  check docker exec "$name" sh -c '
    sha256sum /var/lib/postgresql/pgpassword /var/lib/postgresql/pgpassword-app > /var/lib/postgresql/.trackb-hashes
    sha256sum /var/lib/postgresql/pgpassword > /var/lib/postgresql/.trackb-owner-hash
    url=$(cat /run/s6/container_environment/MIGRATION_DATABASE_URL)
    /usr/lib/postgresql/16/bin/psql "$url" -v ON_ERROR_STOP=1 -c "CREATE TABLE public.track_b_delivery_probe (marker text NOT NULL); INSERT INTO public.track_b_delivery_probe VALUES ('"'"'preserved'"'"');" >/dev/null
  '
  # URL stays in a private temporary file, never on stdout or the job summary.
  docker exec "$name" sh -c 'printf "DATABASE_URL=%s\n" "$(cat /run/s6/container_environment/MIGRATION_DATABASE_URL)"' > "$secret_env"
  # Deliberate crash of our disposable container exercises PostgreSQL recovery.
  docker kill --signal KILL "$name" >/dev/null
  docker rm "$name" >/dev/null
  docker run -d --name "$name" -p 127.0.0.1:3772:3001 \
    -v "$volume:/var/lib/postgresql" \
    -e EMBEDDED_POSTGRES=on -e EMBEDDED_COMPUTER=off -e COPILOTKIT_TELEMETRY_DISABLED=true \
    -e OPENBOT_SINGLE_USER=true -e OPENBOT_PUBLIC_URL=http://localhost:3772 \
    -e KEY_ENCRYPTION_KEY="$key" "$image" >/dev/null
  check wait_health "$name"
  check docker exec "$name" sh -c 'sha256sum -c /var/lib/postgresql/.trackb-hashes >/dev/null'
  check test "$(docker exec "$name" sh -c 'url=$(cat /run/s6/container_environment/MIGRATION_DATABASE_URL); /usr/lib/postgresql/16/bin/psql "$url" -At -v ON_ERROR_STOP=1 -c "SELECT marker FROM public.track_b_delivery_probe"')" = preserved
  docker logs "$name" > "$evidence/recreated.log" 2>&1
  check test "$(grep -ac 'rls-not-enforced\|rls-role-check-unavailable' "$evidence/recreated.log" || true)" = 0
  # Model the upgrade from an older embedded volume which has only an owner secret.
  docker exec "$name" rm /var/lib/postgresql/pgpassword-app
  docker stop "$name" >/dev/null
  auth_secret=$(bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"))')
  docker run -d --name "$auth" -p 127.0.0.1:3772:3001 \
    -v "$volume:/var/lib/postgresql" \
    -e EMBEDDED_POSTGRES=on -e EMBEDDED_COMPUTER=off -e COPILOTKIT_TELEMETRY_DISABLED=true \
    -e OPENBOT_SINGLE_USER=false -e OPENBOT_PUBLIC_URL=http://127.0.0.1:3772 \
    -e BETTER_AUTH_URL=http://127.0.0.1:3772 -e BETTER_AUTH_SECRET="$auth_secret" \
    -e INITIAL_ADMIN_EMAILS=delivery-admin@example.test \
    -e KEY_ENCRYPTION_KEY="$key" "$image" >/dev/null
  if wait_health "$auth"; then
    check docker exec "$auth" sh -c 'sha256sum -c /var/lib/postgresql/.trackb-owner-hash >/dev/null && test "$(stat -c %a /var/lib/postgresql/pgpassword-app)" = 600'
    check test "$(docker exec "$auth" sh -c 'url=$(cat /run/s6/container_environment/DATABASE_URL); /usr/lib/postgresql/16/bin/psql "$url" -At -v ON_ERROR_STOP=1 -c "select current_user, rolsuper, rolbypassrls from pg_roles where rolname=current_user"')" = 'openbot_app|f|f'
    check docker exec "$auth" sh -c 'PGPASSWORD=openbot /usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -U openbot_app -d openbot -c "select 1" >/dev/null 2>&1; test "$?" -ne 0'
    check bun scripts/ci/assert-tenants.mjs http://127.0.0.1:3772
  else
    echo 'FAIL upgraded/auth container healthy within 60 seconds'
    failures=$((failures+1))
  fi
  docker logs "$auth" > "$evidence/auth.log" 2>&1
  check test "$(grep -ac 'rls-not-enforced\|rls-role-check-unavailable' "$evidence/auth.log" || true)" = 0
  docker stop "$auth" >/dev/null
  docker run -d --name "$bad" --env-file "$secret_env_native" \
    -v "$volume:/var/lib/postgresql" \
    -e EMBEDDED_POSTGRES=on -e EMBEDDED_COMPUTER=off -e COPILOTKIT_TELEMETRY_DISABLED=true \
    -e TENANT_PACKAGE_DIR=../examples/qoderwake \
    -e OPENBOT_SINGLE_USER=true -e OPENBOT_PUBLIC_URL=http://localhost:3772 \
    -e KEY_ENCRYPTION_KEY="$key" "$image" >/dev/null
  deadline=$((SECONDS+60))
  while [ "$(docker inspect -f '{{.State.Running}}' "$bad")" = true ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 1; done
  check test "$(docker inspect -f '{{.State.Running}}' "$bad")" = false
  check test "$(docker inspect -f '{{.State.ExitCode}}' "$bad")" -ne 0
  docker logs "$bad" > "$evidence/owner.log" 2>&1
  check grep -aq 'Refusing to serve: tenant isolation' "$evidence/owner.log"
else
  failures=$((failures+1))
fi
echo "IMAGE failed command checks=$failures (see individual assertions above)"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '## 镜像验证\n\n失败检查组：%s（品牌组内逐项结果见日志）。日志与 HTML/主 JS 见 image-evidence artifact。端口 3772；未配置模型凭据。\n' "$failures" >> "$GITHUB_STEP_SUMMARY"
fi
[ "$failures" -eq 0 ]
