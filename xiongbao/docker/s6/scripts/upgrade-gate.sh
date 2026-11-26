#!/bin/sh
# The release the embedded database's volume may come from, checked every boot before any migration runs.
#
# This release is reached only from v0.2.16, which renamed the database's superuser, the database itself,
# the application roles and the data stored under the product's earlier name, and then kept those names.
# The code that did the renaming on an existing volume is gone, so a volume that has not been through it
# is refused here, with the way out, instead of starting under names this release no longer reads:
#
#   - v0.2.16's rename record is still on the volume (rebrand-in-progress next to its backup): v0.2.16
#     started the rename and did not finish it. Only v0.2.16 can finish it.
#   - the superuser or the database still carries a name other than xiongbao, and the migration journal
#     is not empty yet does not hold both of v0.2.16's rename migrations (0240, 0241): a volume v0.2.15
#     or earlier made.
#
# Passes, printing nothing:
#   - a new volume (no journal yet), whatever its superuser is called: postgres-init still creates it under
#     the name before v0.2.16, because a historical migration (0054) needs that name until the migrations
#     are squashed into a new baseline, and migrate.sh renames it after the first migrations;
#   - a volume whose journal holds 0240 and 0241 under any names: if the superuser or the database is still
#     old, the last step of a first boot (the rename) did not run, and migrate.sh runs it now;
#   - a volume under the new names.
#
# The application roles, the rest of the journal and the credentials are checked again by the migrator
# itself, for every deployment (server/src/db/upgrade-gate.ts); this script adds what only the delivery
# image can know. It reads and never writes.
#
#   PGPASSWORD=<owner password> upgrade-gate.sh -h <host> [-p <port>] -U <superuser> -d <database>
#
#   with the names rebrand-superuser.sh says the cluster answers to now. Exit 0: may migrate; 1: refused,
#   with the reason on stderr; 2: usage.
#
# The overrides exist for the tests; the delivery image uses the defaults.
set -eu

PG_BIN=${UPGRADE_GATE_PG_BIN:-/usr/lib/postgresql/16/bin}
RECORD=${UPGRADE_GATE_RECORD:-/var/lib/postgresql/backup/rebrand-in-progress}
SQL_DIR=${UPGRADE_GATE_SQL_DIR:-/app/server/recovery/recovery-20261018-v1/sql}
NEW=xiongbao
RENAME_MIGRATIONS='0240_rebrand_names 0241_rebrand_history'

refuse() { printf 'upgrade-gate: %s\n' "$@" >&2; }
usage() {
  echo 'usage: upgrade-gate.sh -h <host> [-p <port>] -U <superuser> -d <database>' >&2
  exit 2
}

host='' port=5432 user='' db=''
while [ "$#" -ge 2 ]; do
  case $1 in
    -h) host=$2 ;;
    -p) port=$2 ;;
    -U) user=$2 ;;
    -d) db=$2 ;;
    *) usage ;;
  esac
  shift 2
done
[ "$#" -eq 0 ] && [ -n "$host" ] || usage
case $port in '' | *[!0-9]*) usage ;; esac
for n in "$user" "$db"; do
  case $n in '' | *[!a-z0-9_]*) usage ;; esac
done

AFTER='先换回 v0.2.16 镜像启动一次，等它完成改名升级（启动日志里迁移成功、服务正常），再换成这个版本。'

if [ -e "$RECORD" ] || [ -L "$RECORD" ]; then
  refuse "卷上还有 v0.2.16 改名升级的进行中记录（$RECORD）：v0.2.16 开始了改名升级，还没有做完。" \
    "这个版本只能从做完改名升级的 v0.2.16 升级上来，请先升级到 v0.2.16。不迁移、不启动（这一步没有改动任何数据）。" "$AFTER"
  exit 1
fi

[ "$user" = "$NEW" ] && [ "$db" = "$NEW" ] && exit 0

# The hashes the migrator records for the two rename migrations: sha256 of each whole file, as it reads it.
hashes=''
for tag in $RENAME_MIGRATIONS; do
  file=$SQL_DIR/$tag.sql
  [ -f "$file" ] || { refuse "找不到迁移文件 $file。"; exit 1; }
  hashes="$hashes'$(sha256sum "$file" | cut -d' ' -f1)',"
done
hashes=${hashes%,}

err=$(mktemp)
trap 'rm -f "$err"' EXIT
ask() { # statement
  "$PG_BIN/psql" -X -q -A -t -w -v ON_ERROR_STOP=1 -F ' ' -h "$host" -p "$port" -U "$user" -d "$db" -c "$1" 2>"$err"
}
cannot_tell() {
  refuse "读不出这个库的迁移记录，无法判断它是不是从 v0.2.16 升级上来的。不迁移、不启动（这一步没有改动任何数据）。数据库的报错：" "$(cat "$err")"
  exit 1
}
journal=$(ask "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL;") || cannot_tell
[ "$journal" = t ] || exit 0
facts=$(ask "SELECT count(*), count(DISTINCT hash) FILTER (WHERE hash IN ($hashes)) FROM drizzle.__drizzle_migrations;") ||
  cannot_tell
set -- $facts
applied=$1 renamed=$2
[ "$applied" -eq 0 ] && exit 0
[ "$renamed" -eq 2 ] && exit 0

refuse "这个数据库卷还没有经过 v0.2.16 的改名升级：超级用户是 $user、库是 $db（v0.2.16 之后都叫 $NEW），迁移记录里也没有 v0.2.16 的改名迁移（0240、0241）。" \
  "这个版本只能从 v0.2.16 升级上来，请先升级到 v0.2.16。不迁移、不启动（这一步没有改动任何数据）。" "$AFTER"
exit 1
