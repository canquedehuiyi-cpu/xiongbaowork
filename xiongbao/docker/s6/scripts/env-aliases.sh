#!/bin/sh
# XIONGBAO_<X> -> OPENBOT_<X>, for the container's own environment (the shell twin of
# shared/env-aliases.ts). Runs as a oneshot before everything that reads the environment, because
# s6 services see only what is in this directory.
#
# New name wins; a clash prints one warning line. Names with no XIONGBAO_ counterpart are not
# touched, so an old-style deployment sees no change and no warning.
#
# THE IMAGE'S DEFAULTS COME FIRST AND COUNT LEAST. Each `<X>=<value>` line of the defaults file
# (`#` starts a comment) is written as XIONGBAO_<X> only when neither XIONGBAO_<X> nor its legacy
# name is set, and is then copied like any other. As an image ENV under the new name it would win
# over a customer's own setting under the legacy name: RLS_ENFORCE=warn turned back into refuse.
# An entry right after a line that is exactly `#third-party` is a third party's own variable name and has no
# XIONGBAO_ counterpart: it is written as it is, only when that name is not set, and never copied.
# A missing defaults file is skipped.
#
# Usage: env-aliases.sh [dir] [defaults-file]
#   dir            default /run/s6/container_environment
#   defaults-file  default /etc/xiongbao/defaults.env (s6 passes neither; the tests pass both)
set -eu
dir=${1:-/run/s6/container_environment}
defaults=${2:-/etc/xiongbao/defaults.env}
[ -d "$dir" ] || exit 0

# The legacy name of a suffix, as a path in $dir.
legacy_of() { printf '%s\n' "$dir"/OPENBOT_"$1"; }

if [ -f "$defaults" ]; then
  own=
  while IFS= read -r entry || [ -n "$entry" ]; do
    case $entry in
      '#third-party') own=1; continue ;;
      '' | '#'*) continue ;;
    esac
    suffix=${entry%%=*}
    [ -n "$suffix" ] && [ "$suffix" != "$entry" ] || { own=; continue; }
    if [ -n "$own" ]; then
      own=
      [ -e "$dir/$suffix" ] || printf %s "${entry#*=}" > "$dir/$suffix"
      continue
    fi
    if [ ! -e "$dir/XIONGBAO_$suffix" ] && [ ! -e "$(legacy_of "$suffix")" ]; then
      printf %s "${entry#*=}" > "$dir/XIONGBAO_$suffix"
    fi
  done < "$defaults"
fi

for file in "$dir"/XIONGBAO_*; do
  [ -f "$file" ] || continue
  name=${file##*/}
  suffix=${name#XIONGBAO_}
  [ -n "$suffix" ] || continue
  legacy=$(legacy_of "$suffix")
  if [ -f "$legacy" ] && ! cmp -s "$file" "$legacy"; then
    echo "OPENBOT_$suffix is also set under its XIONGBAO_ name; using the XIONGBAO_ value." >&2
  fi
  cp "$file" "$legacy"
done
