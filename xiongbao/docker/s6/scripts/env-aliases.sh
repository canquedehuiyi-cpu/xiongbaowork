#!/bin/sh
# OPENBOT_<X> -> XIONGBAO_<X>, for the container's own environment (the shell twin of
# shared/env-aliases.ts). Runs as a oneshot before everything that reads the environment, because
# s6 services see only what is in this directory.
#
# legacy-compat：introducedIn 0.2.16，removeIn 0.2.17，env files written before the rename
#
# An old name with a value is copied under its new name when the new name is unset or empty; the old
# file is left as it is. New wins when both are set and differ, and the clash prints one warning line
# naming the old variable (never a value). An old-only deployment is silent here: the server names the
# old names in use when it starts. Nothing is ever copied the other way. A platform model key
# (OPENBOT_POOL_<X>) is copied too: v0.2.16 renames the pool row that names it (migration 0240).
#
# THE IMAGE'S DEFAULTS COME FIRST AND COUNT LEAST. Each `<X>=<value>` line of the defaults file
# (`#` starts a comment) is written as XIONGBAO_<X> only when neither XIONGBAO_<X> nor its old
# name is set. As an image ENV under the new name it would win over a customer's own setting under
# the old name: RLS_ENFORCE=warn turned back into refuse.
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
old=OPENBOT_

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
    if [ ! -e "$dir/XIONGBAO_$suffix" ] && [ ! -e "$dir/$old$suffix" ]; then
      printf %s "${entry#*=}" > "$dir/XIONGBAO_$suffix"
    fi
  done < "$defaults"
fi

for file in "$dir/$old"*; do
  [ -f "$file" ] && [ -s "$file" ] || continue
  name=${file##*/}
  suffix=${name#"$old"}
  [ -n "$suffix" ] || continue
  renamed=$dir/XIONGBAO_$suffix
  if [ ! -s "$renamed" ]; then
    cp "$file" "$renamed"
  elif ! cmp -s "$file" "$renamed"; then
    echo "$name and XIONGBAO_$suffix are both set and differ; using XIONGBAO_$suffix." >&2
  fi
done
