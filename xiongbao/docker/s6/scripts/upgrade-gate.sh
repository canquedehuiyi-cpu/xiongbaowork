#!/bin/sh
# The release the embedded database's volume may come from, checked every boot before any migration runs.
#
# This release is reached only from v0.2.16, which renamed the database's superuser, the database itself,
# the application roles and the data stored under the product's earlier name, and then kept those names.
# The code that did the renaming is gone, so a volume that has not been through it is refused here, with
# the way out, instead of starting under names this release no longer reads:
#
#   - v0.2.16's rename record is still on the volume (rebrand-in-progress next to its backup): v0.2.16
#     started the rename and did not finish it. Only v0.2.16 can finish it.
#   - the superuser or the database is not called xiongbao. (migrate.sh logs in only as xiongbao, so a
#     volume under any other name never gets this far: its login fails and migrate.sh says the same.)
#
# Everything else, the application roles, the migration journal and the credentials, is checked by the
# migrator itself, for every deployment (server/src/db/upgrade-gate.ts), on the journal v0.2.16 left
# before it is rewritten to the baseline (server/src/db/baseline-adoption.ts). This script adds what only
# the delivery image can know. It reads and never writes, and does not connect to the database.
#
#   upgrade-gate.sh -h <host> [-p <port>] -U <superuser> -d <database>
#
#   Exit 0: may migrate; 1: refused, with the reason on stderr; 2: usage.
#
# The overrides exist for the tests; the delivery image uses the defaults.
set -eu

RECORD=${UPGRADE_GATE_RECORD:-/var/lib/postgresql/backup/rebrand-in-progress}
NEW=xiongbao

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

refuse "这个数据库卷还没有经过 v0.2.16 的改名升级：超级用户是 $user、库是 $db（v0.2.16 之后都叫 $NEW）。" \
  "这个版本只能从 v0.2.16 升级上来，请先升级到 v0.2.16。不迁移、不启动（这一步没有改动任何数据）。" "$AFTER"
exit 1
