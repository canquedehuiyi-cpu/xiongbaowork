#!/usr/bin/env bash
# Checks the device app's macOS bundle (F2 stage 3, acceptance 2), on macOS.
#
#   verify-macos.sh --team-id <Apple team ID> [--expected-version X.Y.Z] [--evidence-dir DIR]
#   verify-macos.sh --unsigned [--expected-version X.Y.Z] [--evidence-dir DIR]
#
# Always: exactly one .app (bundle/macos) and one .dmg (bundle/dmg); the app carries tauri.conf.json's
# identifier, productName and version, the main binary and the runner sidecar; the sidecar starts
# under the app's signature and entitlements (it prints its usage); the dmg holds the same app.
# Signed: app, sidecar and dmg are signed by a Developer ID Application certificate of --team-id,
# with the hardened runtime and the JIT entitlement on the sidecar; `stapler validate` passes on app
# and dmg; `spctl --assess` accepts the app as notarized Developer ID and the dmg for opening.
# --unsigned: the app is ad-hoc signed only, and Gatekeeper (`spctl --assess`) rejects it, so a build
# labelled unsigned never carries someone's real identity.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
tauri="$here/../src-tauri"
bundle="$tauri/target/release/bundle"
mode=""
team=""
expected=""
evidence="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/macos-evidence"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --unsigned) mode=unsigned; shift ;;
    --team-id) mode=signed; team="${2:-}"; shift 2 ;;
    --expected-version) expected="${2:-}"; shift 2 ;;
    --evidence-dir) evidence="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$mode" ] || { [ "$mode" = signed ] && [ -z "$team" ]; }; then
  echo "usage: verify-macos.sh (--unsigned | --team-id TEAMID) [--expected-version X.Y.Z] [--evidence-dir DIR]" >&2
  exit 2
fi
fail() { echo "::error::$*" >&2; exit 1; }
mkdir -p "$evidence"

# plutil reads JSON as well as plists. tauri.conf.json's version is a path to package.json.
config="$tauri/tauri.conf.json"
product="$(plutil -extract productName raw -o - "$config")"
identifier="$(plutil -extract identifier raw -o - "$config")"
main_binary="$(plutil -extract mainBinaryName raw -o - "$config")"
version="$(plutil -extract version raw -o - "$config")"
case "$version" in
  *.json) version="$(plutil -extract version raw -o - "$tauri/$version")" ;;
esac
if [ -n "$expected" ] && [ "$expected" != "$version" ]; then
  fail "expected version $expected, but tauri.conf.json builds $version"
fi

shopt -s nullglob
apps=("$bundle"/macos/*.app)
dmgs=("$bundle"/dmg/*.dmg)
shopt -u nullglob
[ "${#apps[@]}" -eq 1 ] || fail "expected one .app in $bundle/macos, found ${#apps[@]}"
[ "${#dmgs[@]}" -eq 1 ] || fail "expected one .dmg in $bundle/dmg, found ${#dmgs[@]}"
app="${apps[0]}"
dmg="${dmgs[0]}"

check_app() {
  local app="$1" plist="$1/Contents/Info.plist" key want got
  for key in CFBundleIdentifier CFBundleName CFBundleShortVersionString CFBundleVersion; do
    case "$key" in
      CFBundleIdentifier) want="$identifier" ;;
      CFBundleName) want="$product" ;;
      *) want="$version" ;;
    esac
    got="$(plutil -extract "$key" raw -o - "$plist")"
    [ "$got" = "$want" ] || fail "$key of $(basename "$app") is '$got', expected '$want'"
  done
  [ -x "$app/Contents/MacOS/$main_binary" ] || fail "$(basename "$app") has no Contents/MacOS/$main_binary"
  [ -x "$app/Contents/MacOS/openbot-runner" ] || fail "$(basename "$app") has no Contents/MacOS/openbot-runner"
  codesign --verify --deep --strict --verbose=2 "$app"
}

check_app "$app"
sidecar="$app/Contents/MacOS/openbot-runner"
# The runner is a Bun binary: under the hardened runtime it starts only with the JIT entitlements.
# --help prints usage and exits 2; a signature or entitlement problem kills it before that.
help="$("$sidecar" --help 2>&1 || true)"
grep -q '^usage:' <<<"$help" || fail "the bundled runner did not start: $help"

codesign -dv --verbose=4 "$app" > "$evidence/app.codesign.txt" 2>&1
codesign -dv --verbose=4 "$sidecar" > "$evidence/runner.codesign.txt" 2>&1
codesign -d --entitlements - --xml "$sidecar" > "$evidence/runner.entitlements.plist" 2> /dev/null || true
# In the job log too: which signature, flags (runtime) and entitlements the runner really carries.
grep -E '^(Identifier|Format|CodeDirectory|Signature|Authority|TeamIdentifier|Timestamp)' "$evidence/runner.codesign.txt" || true
grep -o 'com\.apple\.security\.[a-z.-]*' "$evidence/runner.entitlements.plist" || true

if [ "$mode" = unsigned ]; then
  grep -q '^Signature=adhoc' "$evidence/app.codesign.txt" || fail "an unsigned build must be ad-hoc signed only: $(cat "$evidence/app.codesign.txt")"
  if spctl --assess --type execute --verbose=4 "$app" > "$evidence/app.spctl.txt" 2>&1; then
    fail "Gatekeeper accepted a build labelled unsigned: $(cat "$evidence/app.spctl.txt")"
  fi
else
  for record in app runner; do
    file="$evidence/$record.codesign.txt"
    grep -q '^Authority=Developer ID Application: ' "$file" || fail "$record is not signed with a Developer ID Application certificate"
    grep -qx "TeamIdentifier=$team" "$file" || fail "$record is not signed by team $team"
    grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]+\(.*runtime.*\)' "$file" || fail "$record is not signed with the hardened runtime"
    grep -q '^Timestamp=' "$file" || fail "$record has no secure timestamp"
  done
  codesign -d --entitlements - --xml "$sidecar" 2>/dev/null | grep -q 'com.apple.security.cs.allow-jit' ||
    fail "the runner is signed without the JIT entitlement"
  codesign --verify --strict --verbose=2 "$dmg"
  codesign -dv --verbose=4 "$dmg" > "$evidence/dmg.codesign.txt" 2>&1
  grep -qx "TeamIdentifier=$team" "$evidence/dmg.codesign.txt" || fail "the dmg is not signed by team $team"
  xcrun stapler validate "$app" | tee "$evidence/app.stapler.txt"
  xcrun stapler validate "$dmg" | tee "$evidence/dmg.stapler.txt"
  spctl --assess --type execute --verbose=4 "$app" 2>&1 | tee "$evidence/app.spctl.txt"
  grep -q 'source=Notarized Developer ID' "$evidence/app.spctl.txt" || fail "Gatekeeper does not see the app as notarized Developer ID"
  spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg" 2>&1 | tee "$evidence/dmg.spctl.txt"
fi

# The dmg is what people download: it must hold this same app.
mount="$(mktemp -d)"
hdiutil attach -readonly -nobrowse -mountpoint "$mount" "$dmg" > /dev/null
trap 'hdiutil detach "$mount" > /dev/null || true' EXIT
shopt -s nullglob
inside=("$mount"/*.app)
shopt -u nullglob
[ "${#inside[@]}" -eq 1 ] || fail "the dmg holds ${#inside[@]} apps, expected one"
check_app "${inside[0]}"
if [ "$mode" = signed ]; then
  xcrun stapler validate "${inside[0]}"
fi

shasum -a 256 "$dmg" | tee "$evidence/dmg.sha256"
echo "Verified $(basename "$dmg") and $(basename "$app"): $product $version ($identifier), $mode${team:+, team $team}. Evidence: $evidence"
