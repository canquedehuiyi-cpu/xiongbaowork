#!/usr/bin/env bash
# Renders charts/openbot the way an install would and checks what the API is handed.
#
# Run from openbot/ with helm on PATH (the root CI `chart` job). Small on purpose: a lint, and a
# handful of `helm template` renders read with grep, no cluster. Each check names the install it
# stands for, because every one of these is an install that would otherwise crash-loop.
set -euo pipefail

chart=charts/openbot
key="$(openssl rand -base64 32)"
external="$chart/ci/eks-values.yaml"     # postgresql off, database.existingSecret: openbot-database
bundled="$chart/ci/self-hosted-values.yaml" # postgresql on

render() {
  helm template ci "$chart" \
    --set-string secrets.keyEncryptionKey="$key" \
    --api-versions agents.x-k8s.io/v1beta1/Sandbox \
    --api-versions extensions.agents.x-k8s.io/v1beta1/SandboxTemplate \
    "$@"
}

fail() {
  echo "::error::$1"
  exit 1
}

# The lines after an env entry, read whole rather than piped into `grep -q`, which can close the
# pipe early and, under pipefail, fail a check that passed.
env_after() {
  grep -A"$2" "name: $1\$" <<<"$3" || true
}
writer_env() { env_after ROLE_WRITER_DATABASE_URL "$1" "$2"; }

inline=(
  --set-string database.existingSecret=
  --set-string database.url=postgres://openbot_app:x@db.internal:5432/openbot
)
owner=(--set-string database.migrationUrl=postgres://openbot:o@db.internal:5432/openbot)

helm dependency build "$chart" >/dev/null
for values in "$external" "$bundled"; do
  helm lint "$chart" --values "$values" --set-string secrets.keyEncryptionKey="$key"
done

# External database through its Secret: the API reads the role writer from the same Secret, under
# its own key.
out="$(render --values "$external")"
[[ "$(writer_env 4 "$out")" == *"key: role-writer-database-url"* ]] ||
  fail "External database via Secret: the API is not given ROLE_WRITER_DATABASE_URL from the database Secret."
echo "ok: external database via Secret carries the role-writer URL"
# ... and the migrations Job reads the owner's URL from the same Secret, optionally.
[[ "$(env_after MIGRATION_DATABASE_URL 5 "$out")" == *"key: migration-database-url"*"optional: true"* ]] ||
  fail "External database via Secret: the migrations Job is not given MIGRATION_DATABASE_URL from the database Secret."
echo "ok: external database via Secret gives the migrations Job the owner's URL key"

# External database given inline: an inline role-writer URL reaches the API.
out="$(render --values "$external" "${inline[@]}" "${owner[@]}" \
  --set-string database.roleWriterUrl=postgres://openbot_role_writer:y@db.internal:5432/openbot)"
[[ "$(writer_env 1 "$out")" == *"openbot_role_writer:y@db.internal"* ]] ||
  fail "External database inline: database.roleWriterUrl did not reach the API."
echo "ok: external database inline carries the role-writer URL"
# The migrations Job migrates as the owner, never as the API's openbot_app.
[[ "$out" == *'value: "postgres://openbot:o@db.internal:5432/openbot"'* ]] ||
  fail "External database inline: the migrations Job is not given database.migrationUrl."
echo "ok: external database inline migrates with the owner's URL"

# Inline without a role writer: refused at render, by the role-writer rule and not something else.
if refusal="$(render --values "$external" "${inline[@]}" "${owner[@]}" 2>&1)"; then
  fail "An inline external database with no role-writer URL rendered; it must be refused."
fi
[[ "$refusal" == *"database.roleWriterUrl"* ]] ||
  fail "The inline external database was refused, but not for the missing role writer: $refusal"
echo "ok: inline external database without a role writer is refused"

# Inline without the owner's URL: refused at render, by the migration rule.
if refusal="$(render --values "$external" "${inline[@]}" \
  --set-string database.roleWriterUrl=postgres://openbot_role_writer:y@db.internal:5432/openbot 2>&1)"; then
  fail "An inline external database with no migration URL rendered; it must be refused."
fi
[[ "$refusal" == *"database.migrationUrl"* ]] ||
  fail "The inline external database was refused, but not for the missing migration URL: $refusal"
echo "ok: inline external database without an owner URL for migrations is refused"

# Bundled database: the chart makes the role writer's password, the API's URL carries it, and the
# migrations Job sets it on the role after migrating, as the embedded image does.
out="$(render --values "$bundled")"
[[ "$out" == *"-database-roles"*"role-writer-password: "* ]] ||
  fail "Bundled database: no role-writer password Secret was rendered."
[[ "$(writer_env 1 "$out")" == *'postgres://openbot_role_writer:$(ROLE_WRITER_PASSWORD)@'* ]] ||
  fail "Bundled database: the API is not given ROLE_WRITER_DATABASE_URL from the role-writer password."
[[ "$out" == *"ALTER ROLE openbot_role_writer WITH LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD"* ]] ||
  fail "Bundled database: the migrations Job does not set the role writer's password."
echo "ok: bundled database makes, wires and sets the role writer's password"

# Bundled, the API pods follow the password: a change to it rolls them, because the Job ALTERs the
# role and a running pod keeps the password it started with.
[[ "$out" == *"checksum/role-writer: "* ]] ||
  fail "Bundled database: the API pod template has no checksum/role-writer annotation."
echo "ok: bundled database API pods carry a role-writer checksum"

# An operator's password is the one rendered, and the same render twice rolls nothing (GitOps).
fixed=(--set-string database.roleWriterPassword=abcdef0123456789abcdef01)
out="$(render --values "$bundled" "${fixed[@]}")"
[[ "$out" == *'role-writer-password: "abcdef0123456789abcdef01"'* ]] ||
  fail "Bundled database: database.roleWriterPassword is not the password rendered."
role_sum() { grep -o 'checksum/role-writer: [0-9a-f]*' <<<"$1" || true; }
first="$(role_sum "$out")"
[[ -n "$first" && "$first" == "$(role_sum "$(render --values "$bundled" "${fixed[@]}")")" ]] ||
  fail "Bundled database: a fixed role-writer password renders a different checksum each time."
[[ "$first" != "$(role_sum "$(render --values "$bundled" --set-string database.roleWriterPassword=0123456789abcdef0123456789)")" ]] ||
  fail "Bundled database: a changed role-writer password does not change the API's checksum."
echo "ok: database.roleWriterPassword is stable across renders, and a change rolls the API"

# An operator's own Secret: the chart writes none, and both the API and the Job read theirs.
out="$(render --values "$bundled" --set-string database.roleWriterPasswordExistingSecret=my-role-writer)"
[[ "$out" != *"-database-roles"* ]] ||
  fail "Bundled database with roleWriterPasswordExistingSecret: the chart still rendered its own Secret."
[[ "$(env_after ROLE_WRITER_PASSWORD 4 "$out")" == *"name: my-role-writer"*"key: role-writer-password"* ]] ||
  fail "Bundled database with roleWriterPasswordExistingSecret: ROLE_WRITER_PASSWORD is not read from it."
echo "ok: an operator's role-writer Secret replaces the chart's"

# A password that would not survive a SQL literal or a URL is refused at render.
if refusal="$(render --values "$bundled" --set-string "database.roleWriterPassword=short'pw" 2>&1)"; then
  fail "A role-writer password with a quote in it rendered; it must be refused."
fi
[[ "$refusal" == *"database.roleWriterPassword"* ]] ||
  fail "The bad role-writer password was refused, but not by its own rule: $refusal"
echo "ok: a role-writer password that is not letters and digits is refused"

# External with a separate owner URL: the Job is given the API's URL as well, and checks both reach
# the same database before migrating.
out="$(render --values "$external" "${inline[@]}" "${owner[@]}" \
  --set-string database.roleWriterUrl=postgres://openbot_role_writer:y@db.internal:5432/openbot)"
[[ "$(env_after APP_DATABASE_URL 1 "$out")" == *'postgres://openbot_app:x@db.internal'* ]] ||
  fail "External database inline: the migrations Job is not given the API's URL to compare with."
[[ "$out" == *"pg_postmaster_start_time()"*"refusing to migrate"* ]] ||
  fail "External database inline: the migrations Job does not check the two URLs reach one database."
echo "ok: the migrations Job checks the owner's and the API's URLs reach the same database"

# With migrations off the chart migrates nothing, so it asks for no owner URL.
render --values "$external" "${inline[@]}" --set migrations.enabled=false \
  --set-string database.roleWriterUrl=postgres://openbot_role_writer:y@db.internal:5432/openbot >/dev/null ||
  fail "With migrations.enabled=false an inline database without database.migrationUrl was refused."
echo "ok: migrations.enabled=false needs no owner URL"
