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

# The lines after the API's ROLE_WRITER_DATABASE_URL entry, read whole rather than piped into
# `grep -q`, which can close the pipe early and, under pipefail, fail a check that passed.
writer_env() {
  grep -A"$1" 'name: ROLE_WRITER_DATABASE_URL' <<<"$2" || true
}

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

# External database given inline: an inline role-writer URL reaches the API.
out="$(render --values "$external" \
  --set-string database.existingSecret= \
  --set-string database.url=postgres://openbot_app:x@db.internal:5432/openbot \
  --set-string database.roleWriterUrl=postgres://openbot_role_writer:y@db.internal:5432/openbot)"
[[ "$(writer_env 1 "$out")" == *"openbot_role_writer:y@db.internal"* ]] ||
  fail "External database inline: database.roleWriterUrl did not reach the API."
echo "ok: external database inline carries the role-writer URL"

# Inline without a role writer: refused at render, by the role-writer rule and not something else.
if refusal="$(render --values "$external" \
  --set-string database.existingSecret= \
  --set-string database.url=postgres://openbot_app:x@db.internal:5432/openbot 2>&1)"; then
  fail "An inline external database with no role-writer URL rendered; it must be refused."
fi
[[ "$refusal" == *"database.roleWriterUrl"* ]] ||
  fail "The inline external database was refused, but not for the missing role writer: $refusal"
echo "ok: inline external database without a role writer is refused"

# Bundled database: unchanged by the role-writer wiring.
out="$(render --values "$bundled")"
if [[ "$out" == *"ROLE_WRITER_DATABASE_URL"* ]]; then
  fail "Bundled database: the render gained ROLE_WRITER_DATABASE_URL."
fi
echo "ok: bundled database render has no role-writer URL"
