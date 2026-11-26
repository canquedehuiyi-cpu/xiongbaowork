#!/bin/sh
# The v0.2.16 rename of the embedded database's bootstrap superuser and of the database itself to
# xiongbao, and the question every boot asks first: which names does this cluster answer to now.
#
# legacy-compat：introducedIn 0.2.16，removeIn 0.2.17，the whole file goes once fresh volumes are created
# under the new names (R4 baseline) and no volume from before v0.2.16 is left to rename
#
# WHY A FRESH VOLUME STILL STARTS UNDER THE OLD NAMES. A historical migration (0054) grants default
# privileges FOR ROLE <the old superuser name>, so until the migrations are squashed into a new baseline an
# empty database can only be migrated by a superuser carrying that name. postgres-init therefore still
# creates the cluster and the database under it; the first boot migrates, then renames, exactly as an
# existing volume does on its upgrade boot. The old names are never spelled in here: migrate.sh passes them
# as -U and -d, the names a volume made before v0.2.16 carries.
#
#   PGPASSWORD=<owner password> rebrand-superuser.sh names [--wait <seconds>] -h <host> [-p <port>] -U <old superuser> -d <old database>
#
#     Prints "<superuser> <database>": the role that logs in with the owner password and the database the
#     services use, as the cluster says now. It tries the new superuser name first once the rename has been
#     recorded on the volume ($HINT), the old one first before that, so a boot does not leave a failed login
#     in the server log; either way it falls back to the other name, so a missing or stale hint costs one
#     failed login and nothing else. The database is xiongbao when that exists, else the old one. Both
#     existing at once is refused: nothing here can tell which one holds the data. With --wait it keeps
#     trying to log in for that long (the database may still be starting: migrate.sh uses this as its
#     readiness wait), but a refusal is final and returns at once.
#
#   PGPASSWORD=<owner password> rebrand-superuser.sh rename -h <host> [-p <port>] -U <old superuser> -d <old database>
#
#     Renames whichever of the two still carries the old name, in ONE transaction on the `postgres`
#     database, so a failure leaves both names as they were. The superuser is the session user, which
#     PostgreSQL will not rename, so the transaction makes a NOLOGIN superuser, sets the session
#     authorization to it, renames, sets it back and drops it again: no password is created, nothing
#     outlives the transaction. ALTER DATABASE … RENAME refuses while any other session is connected to
#     that database, which is why migrate.sh runs this after the migrations and before any service starts.
#     The password is not reset: PostgreSQL keeps a SCRAM verifier across a rename (it does not involve
#     the role name). An MD5 hash, which does involve it and which PostgreSQL clears on a rename, is
#     replaced in the same transaction by a SCRAM verifier of the same password (the owner password this
#     session logged in with; reachable only on a cluster whose pg_hba.conf someone changed to md5, since
#     under the scram-sha-256 lines initdb writes an MD5-hashed role cannot log in at all). Afterwards it
#     logs in under the new names with that password, then records the rename on the volume. On a cluster
#     already renamed it only does the last two, silently. A leftover of the temporary role (only a hand-made
#     one can exist: the transaction never commits it) is dropped first when it is a bare NOLOGIN role that
#     owns, holds and belongs to nothing; any other leftover is refused by name.
#
#   Exit codes: 0 done; 1 no login (not up yet, or the password does not match), worth waiting for; 3
#   refused for a reason that waiting does not change (the message says which); 2 usage. A failed rename
#   transaction exits 1.
#
# The overrides exist for the tests; the delivery image uses the defaults.
set -eu
umask 077

PG_BIN=${REBRAND_PG_BIN:-/usr/lib/postgresql/16/bin}
HINT=${REBRAND_SUPERUSER_HINT:-/var/lib/postgresql/superuser-renamed}
NEW=xiongbao

say() { printf 'rebrand-superuser: %s\n' "$@"; }
refuse() { printf 'rebrand-superuser: %s\n' "$@" >&2; }

usage() {
  echo 'usage: rebrand-superuser.sh names|rename -h <host> [-p <port>] -U <old superuser> -d <old database>' >&2
  exit 2
}

host='' port=5432 old_user='' old_db='' wait=0
parse() {
  while [ "$#" -ge 2 ]; do
    case $1 in
      --wait) wait=$2 ;;
      -h) host=$2 ;;
      -p) port=$2 ;;
      -U) old_user=$2 ;;
      -d) old_db=$2 ;;
      *) usage ;;
    esac
    shift 2
  done
  [ "$#" -eq 0 ] && [ -n "$host" ] || usage
  case $port$wait in '' | *[!0-9]*) usage ;; esac
  # Identifiers only: they reach SQL as psql variables, but a name outside this set is not one of ours.
  for n in "$old_user" "$old_db"; do
    case $n in '' | *[!a-z0-9_]*) usage ;; esac
  done
}

# psql as <user> on the `postgres` database, script on stdin; the old database name is the psql variable
# `old_db`, never pasted into the SQL text. Errors go to $err.
sql_as() { # user
  "$PG_BIN/psql" -X -q -A -t -w -v ON_ERROR_STOP=1 -v old_db="$old_db" -F ' ' \
    -h "$host" -p "$port" -U "$1" -d postgres 2>"$err"
}

err=$(mktemp)
trap 'rm -f "$err"' EXIT

# What the cluster looks like from whichever name logs in: sets who, bootstrap, new_db, old_db_count,
# other_new_role and leftover (the temporary role, if one exists: "<can login> <dependencies>", else
# empty). Returns 1 when neither name logs in; the last error is in $err.
inspect() {
  if [ -f "$HINT" ]; then order="$NEW $old_user"; else order="$old_user $NEW"; fi
  for who in $order; do
    if row=$(printf '%s\n' "SELECT session_user,
        (SELECT rolname FROM pg_roles WHERE oid = 10),
        (SELECT count(*) FROM pg_database WHERE datname = '$NEW'),
        (SELECT count(*) FROM pg_database WHERE datname = :'old_db'),
        (SELECT count(*) FROM pg_roles WHERE rolname = '$NEW' AND oid <> 10),
        coalesce((SELECT r.rolcanlogin::text || ' ' || (
            (SELECT count(*) FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = r.oid)
          + (SELECT count(*) FROM pg_auth_members WHERE roleid = r.oid OR member = r.oid))
          FROM pg_roles r WHERE r.rolname = '${NEW}_renaming'), 'none');" | sql_as "$who") && [ -n "$row" ]; then
      set -- $row
      [ "$#" -ge 6 ] || break
      who=$1 bootstrap=$2 new_db=$3 old_db_count=$4 other_new_role=$5
      shift 5
      leftover=$*
      [ "$leftover" != none ] || leftover=''
      return 0
    fi
  done
  return 1
}
no_login() {
  refuse "用新名和旧名都登录不了数据库，无法判断超级用户现在叫什么。数据库的报错：" "$(cat "$err" 2>/dev/null)"
}

database() {
  if [ "$new_db" -eq 1 ] && [ "$old_db_count" -eq 1 ]; then
    refuse "库 $NEW 和改名前的库同时存在，无法判断数据在哪一个里，不改名、不启动（这一步没有改动任何数据）。" \
      "请先确认哪一个是在用的库，把另一个改名或删除后再启动。"
    exit 3
  elif [ "$new_db" -eq 1 ]; then echo "$NEW"
  elif [ "$old_db_count" -eq 1 ]; then echo "$old_db"
  else
    refuse "库 $NEW 和改名前的库都不存在，不改名、不启动（这一步没有改动任何数据）。"
    exit 3
  fi
}

names() {
  parse "$@"
  deadline=$(($(date +%s) + wait))
  until inspect; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      no_login
      [ "$wait" -eq 0 ] || refuse "等了 $wait 秒仍登录不上（数据库没有就绪，或者口令对不上）。"
      exit 1
    fi
    sleep 1
  done
  db=$(database) || exit 3
  printf '%s %s\n' "$who" "$db"
}

# A new file made by mktemp (which never opens an existing path) renamed over the hint, which replaces a
# link rather than following it: the directory may be writable by postgres.
mark_renamed() {
  [ -f "$HINT" ] && [ ! -L "$HINT" ] && return 0
  tmp=$(mktemp "$HINT.XXXXXX")
  mv -f "$tmp" "$HINT"
}

rename() {
  parse "$@"
  inspect || { no_login; exit 1; }
  db=$(database) || exit 3
  if [ "$bootstrap" = "$NEW" ] && [ "$db" = "$NEW" ]; then
    mark_renamed
    return 0
  fi
  if [ "$bootstrap" != "$NEW" ] && [ "$other_new_role" -ne 0 ]; then
    refuse "已经有一个叫 $NEW 的角色，但它不是集群的引导超级用户，无法把超级用户改成这个名字。不改名、不启动（这一步没有改动任何数据）。" \
      "请先查明这个角色是怎么来的，删除或改名后再启动。"
    exit 3
  fi
  drop_leftover=''
  if [ "$bootstrap" != "$NEW" ] && [ -n "$leftover" ]; then
    if [ "$leftover" = "false 0" ]; then
      drop_leftover="DROP ROLE ${NEW}_renaming;"
    else
      refuse "已经有一个叫 ${NEW}_renaming 的角色（改名时临时用的名字），它能登录、拥有对象、带着权限或属于别的角色，不能替你删。不改名、不启动（这一步没有改动任何数据）。" \
        "请先查明它是怎么来的，确认无用后删掉（DROP OWNED BY ${NEW}_renaming; DROP ROLE ${NEW}_renaming;，各库都要执行 DROP OWNED）再启动。"
      exit 3
    fi
  fi
  if ! printf '%s\n' "\\set ON_ERROR_STOP on
BEGIN;
SELECT rolname <> '$NEW' AS role_pending, coalesce(rolpassword LIKE 'md5%', false) AS md5
  FROM pg_authid WHERE oid = 10 \\gset
\\if :role_pending
$drop_leftover
CREATE ROLE ${NEW}_renaming SUPERUSER NOLOGIN;
SET SESSION AUTHORIZATION ${NEW}_renaming;
SELECT format('ALTER ROLE %I RENAME TO $NEW', rolname) FROM pg_roles WHERE oid = 10 \\gexec
RESET SESSION AUTHORIZATION;
DROP ROLE ${NEW}_renaming;
\\if :md5
\\getenv owner_password PGPASSWORD
SET LOCAL password_encryption = 'scram-sha-256';
ALTER ROLE $NEW PASSWORD :'owner_password';
\\endif
\\endif
SELECT format('ALTER DATABASE %I RENAME TO $NEW', datname) FROM pg_database
  WHERE datname = :'old_db' AND NOT EXISTS (SELECT FROM pg_database WHERE datname = '$NEW') \\gexec
COMMIT;" | sql_as "$who" >/dev/null; then
    failure=$(cat "$err" 2>/dev/null)
    # Said from what the cluster shows now, not assumed: a connection lost during COMMIT leaves the outcome
    # to the server.
    after=$( (inspect && printf '%s %s' "$bootstrap" "$(database)") 2>/dev/null) || after=''
    refuse "超级用户与库改名失败，报错：" "$failure"
    if [ "$after" = "$bootstrap $db" ]; then
      refuse "改名在一个事务里执行，已整体回滚：超级用户与库仍是改名前的名字。"
      case $failure in
        *'being accessed by other users'*)
          refuse "原因是库上还有别的连接（改库名要求没有其它连接）；断开它们后重启容器会再试（不会再备份）。" ;;
        *)
          refuse "原因见上面数据库的报错；排除之后重启容器会再试（不会再备份）。" ;;
      esac
    else
      refuse "改完之后读不出确定的结果（现在读到的超级用户与库：${after:-读不到}）。重启容器会重新判断，名字没改完就接着改。"
    fi
    exit 1
  fi
  # The proof that matters: the owner password still logs in, under the new names.
  if ! printf '%s\n' "SELECT 1;" | "$PG_BIN/psql" -X -q -A -t -w -v ON_ERROR_STOP=1 \
    -h "$host" -p "$port" -U "$NEW" -d "$NEW" >/dev/null 2>"$err"; then
    refuse "改名已经提交，但用原来的口令以 $NEW 登录 $NEW 库失败，服务不启动。数据库的报错：" "$(cat "$err" 2>/dev/null)"
    exit 1
  fi
  mark_renamed
  say "数据库超级用户与库已改名为 $NEW（口令不变）。"
}

case ${1:-} in
  names) shift; names "$@" ;;
  rename) shift; rename "$@" ;;
  *) usage ;;
esac
