#!/usr/bin/env bash
# Pre-reviews a range of commits with open-code-review (native mode) and leaves a report. Report only:
# nothing here comments on a pull request, approves, or blocks a merge.
#
#   OCR_BASE, OCR_HEAD    the range, as `ocr review --from <base> --to <head>` (merge-base mode)
#   OCR_API_KEY           the model key. Missing or empty: the run is skipped and says why (exit 0)
#   OCR_PROVIDER          the provider `ocr` calls, see `ocr llm providers`. No default: this is where the
#                         code goes, so the person who turns the review on names it. Missing: skipped (exit 0)
#   OCR_MODEL             the model (default deepseek-v4-flash)
#   OCR_OUT_DIR           where the report goes (default ./ocr-report)
#   OCR_TOKEN_BUDGET      cap on input+output tokens for the whole review (default 1500000)
#   OCR_INCLUDE_TESTS     1 to read test files as well (the CI workflow sets it; the default leaves them out)
#   OCR_BIN               an ocr executable to use instead of installing the pinned version (tests)
#
# The installed version is OCR_VERSION below: bump it on purpose, never to "latest". It is installed
# with --ignore-scripts, like every other install in a job that holds a key: the platform binary comes
# from the package's own optional dependency, so the postinstall script is not needed. The install runs
# without the model key in its environment.
#
# Every failure after the range and key checks ends in a skip (exit 0, reason in SKIPPED.txt), so the job
# never shows a red cross on a pull request's checks. Do not make this a required check.
set -euo pipefail

OCR_VERSION="1.14.2"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RULES="$HERE/rules/xiongbao-review.rule.json"
OUT="${OCR_OUT_DIR:-ocr-report}"
BASE="${OCR_BASE:-}"
HEAD_REF="${OCR_HEAD:-HEAD}"
PROVIDER="${OCR_PROVIDER:-}"
MODEL="${OCR_MODEL:-deepseek-v4-flash}"
BUDGET="${OCR_TOKEN_BUDGET:-1500000}"
# Tests are excluded from the run by default: a pre-review of a large range is dominated by them, which
# matters for the benchmark's cost. The rules ask for changed assertions to be reported, which needs the
# tests, so the CI workflow sets OCR_INCLUDE_TESTS=1.
EXCLUDE='**/node_modules/**,**/*.lock,**/bun.lock*,**/*.md'
if [ "${OCR_INCLUDE_TESTS:-0}" != "1" ]; then
  EXCLUDE="$EXCLUDE,**/tests/**,**/*.test.*"
fi

mkdir -p "$OUT"

skip() {
  # One line of text for the person reading the run, and the same in a file the artifact carries.
  printf '%s\n' "$1" >"$OUT/SKIPPED.txt"
  printf '{"skipped":true,"reason":"%s","ocr_version":"%s"}\n' "$1" "$OCR_VERSION" >"$OUT/skipped.json"
  echo "ocr-review skipped: $1"
  exit 0
}

if [ -z "$BASE" ]; then
  skip "OCR_BASE is empty: no range to review"
fi
# A ref is a name or a sha: nothing that could be read as an option, nothing a shell would treat specially.
for ref in "$BASE" "$HEAD_REF"; do
  case "$ref" in
    -* | *[!A-Za-z0-9._/@^~+-]*) skip "OCR_BASE and OCR_HEAD must be plain git refs" ;;
  esac
done
if [ -z "${OCR_API_KEY:-}" ] && [ -z "${OCR_BIN:-}" ]; then
  skip "no model key: the Environment secret OCR_API_KEY is not set (or this run cannot read it), so nothing was sent to a model"
fi

if [ -z "$PROVIDER" ]; then
  skip "no provider: the Environment variable OCR_PROVIDER is not set, so nothing was sent to a model (it names where the code goes)"
fi
# The provider name becomes part of a config key: a plain word only.
case "$PROVIDER" in
  *[!A-Za-z0-9._-]*) skip "OCR_PROVIDER must be a plain provider name (letters, digits, . _ -)" ;;
esac

# Git 2.41 or newer: ocr's range mode relies on it.
git_version="$(git --version | sed -E 's/[^0-9]*([0-9]+)\.([0-9]+).*/\1 \2/')"
read -r git_major git_minor <<<"$git_version"
if [ "$git_major" -lt 2 ] || { [ "$git_major" -eq 2 ] && [ "$git_minor" -lt 41 ]; }; then
  skip "git $git_major.$git_minor is older than 2.41, which open-code-review needs"
fi

# The meaning of ocr's telemetry switch is not verified (its default is unknown), so it is turned off
# explicitly in case it is on by default.
export OCR_ENABLE_TELEMETRY=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# A home of its own: the config below holds the key, and must not outlive the run or land in the artifact.
export HOME="$WORK/home"
mkdir -p "$HOME"

if [ -n "${OCR_BIN:-}" ]; then
  OCR="$OCR_BIN"
else
  env -u OCR_API_KEY npm install --prefix "$WORK/ocr" --ignore-scripts --no-audit --no-fund "@alibaba-group/open-code-review@$OCR_VERSION" >"$OUT/install.log" 2>&1 \
    || skip "could not install @alibaba-group/open-code-review@$OCR_VERSION (see install.log)"
  OCR="$WORK/ocr/node_modules/.bin/ocr"
fi

installed="$("$OCR" --version 2>/dev/null | head -n1)" && [ -n "$installed" ] \
  || skip "ocr --version failed: the installed open-code-review does not run on this machine"

# The key reaches ocr as a command-line argument (visible in the process list while this runs, in a
# single-tenant runner). Whether ocr can take it from the environment instead (it knows OCR_LLM_TOKEN) is
# not verified. Output is dropped: a failing command must not echo the key into the log.
if [ -n "${OCR_API_KEY:-}" ]; then
  {
    "$OCR" config set provider "$PROVIDER" &&
      "$OCR" config set model "$MODEL" &&
      "$OCR" config set "providers.$PROVIDER.api_key" "$OCR_API_KEY"
  } >/dev/null 2>&1 || skip "ocr config set failed: provider, model or key was not accepted (nothing was reviewed)"
fi

status=0
"$OCR" review \
  --from "$BASE" --to "$HEAD_REF" \
  --rule "$RULES" \
  --exclude "$EXCLUDE" \
  --max-tokens-budget "$BUDGET" \
  --audience agent \
  --format json \
  --output "$OUT/ocr-report.json" \
  >"$OUT/ocr-review.log" 2>&1 || status=$?

{
  echo "# open-code-review pre-review"
  echo
  echo "- version: $installed (pinned $OCR_VERSION)"
  echo "- range: $BASE .. $HEAD_REF"
  echo "- provider/model: $PROVIDER / $MODEL"
  echo "- exit status of ocr review: $status"
  echo "- rules: xiongbao/scripts/review/ocr/rules/xiongbao-review.rule.json"
  echo "- this report is advice only: it commented on nothing and blocked nothing"
} >"$OUT/summary.md"

# The report is what the artifact carries: if the key text got into any file of it, that file goes.
if [ -n "${OCR_API_KEY:-}" ]; then
  while IFS= read -r leaked; do
    rm -f -- "$leaked"
    echo "removed $(basename "$leaked"): it contained the model key" >>"$OUT/summary.md"
  done < <(grep -rlF -- "$OCR_API_KEY" "$OUT" || true)
fi

# A failed review is reported in the summary and the log, not by failing the run.
exit 0
