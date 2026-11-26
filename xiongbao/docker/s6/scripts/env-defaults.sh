#!/bin/sh
# The image's defaults, for the container's own environment, and the refusal of settings still under the
# names they had before v0.2.16. Runs as a oneshot before everything that reads the environment, because
# s6 services see only what is in this directory.
#
# THE IMAGE'S DEFAULTS COME FIRST AND COUNT LEAST. Each `<X>=<value>` line of the defaults file
# (`#` starts a comment) is written as XIONGBAO_<X> only when XIONGBAO_<X> is not set. As an image ENV it
# would win over a customer's own setting: RLS_ENFORCE=warn turned back into refuse.
# An entry right after a line that is exactly `#third-party` is a third party's own variable name and has no
# XIONGBAO_ counterpart: it is written as it is, only when that name is not set.
# A missing defaults file is skipped.
#
# SETTINGS UNDER THE OLD PREFIX ARE REFUSED, NOT READ. v0.2.16 read every setting under both prefixes and
# its upgrade sheet renamed the lines; this release reads only the new one and is reached only from v0.2.16.
# An old-prefix variable with a value whose new name is unset or empty is something the deployment relies
# on and this release would silently drop, so the container stops here, naming each one (never a value).
# One set under both names is not refused: the new one is in effect, as it was in v0.2.16. The server, the
# worker and the other processes refuse the same settings themselves (shared/env-name.ts).
#
# Usage: env-defaults.sh [dir] [defaults-file]
#   dir            default /run/s6/container_environment
#   defaults-file  default /etc/xiongbao/defaults.env (s6 passes neither; the tests pass both)
set -eu
dir=${1:-/run/s6/container_environment}
defaults=${2:-/etc/xiongbao/defaults.env}
[ -d "$dir" ] || exit 0
old=OPENBOT_

refused=''
for file in "$dir/$old"*; do
  [ -f "$file" ] && [ -s "$file" ] || continue
  name=${file##*/}
  suffix=${name#"$old"}
  [ -n "$suffix" ] || continue
  [ -s "$dir/XIONGBAO_$suffix" ] && continue
  refused="$refused${refused:+, }$name"
done
if [ -n "$refused" ]; then
  echo "这些设置还是 v0.2.16 之前的旧名，这个版本不再读取，不启动：$refused。这个版本只能从 v0.2.16 升级上来：请先升级到 v0.2.16（按它的升级单把旧名改成新名），或者把每一行改成 XIONGBAO_ 开头的同名设置后再启动。" >&2
  exit 1
fi

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
    [ -e "$dir/XIONGBAO_$suffix" ] || printf %s "${entry#*=}" > "$dir/XIONGBAO_$suffix"
  done < "$defaults"
fi
