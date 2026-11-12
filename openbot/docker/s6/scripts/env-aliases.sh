#!/bin/sh
# XIONGBAO_<X> -> OPENBOT_<X>, for the container's own environment (the shell twin of
# shared/env-aliases.ts). Runs as a oneshot before everything that reads the environment, because
# s6 services see only what is in this directory.
#
# New name wins; a clash prints one warning line. Names with no XIONGBAO_ counterpart are not
# touched, so an old-style deployment sees no change and no warning.
#
# Usage: env-aliases.sh [environment-directory]   (default /run/s6/container_environment)
set -eu
dir=${1:-/run/s6/container_environment}
[ -d "$dir" ] || exit 0
for file in "$dir"/XIONGBAO_*; do
  [ -f "$file" ] || continue
  name=${file##*/}
  suffix=${name#XIONGBAO_}
  [ -n "$suffix" ] || continue
  legacy=$dir/OPENBOT_$suffix
  if [ -f "$legacy" ] && ! cmp -s "$file" "$legacy"; then
    echo "OPENBOT_$suffix is also set under its XIONGBAO_ name; using the XIONGBAO_ value." >&2
  fi
  cp "$file" "$legacy"
done
