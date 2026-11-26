#!/bin/sh
# The connection strings the services of the embedded database read, written into s6's container
# environment: the owner's for migrations (MIGRATION_DATABASE_URL), and, unless the deployment set its own,
# the API's app role (DATABASE_URL) and the role writer (ROLE_WRITER_DATABASE_URL).
#
#   database-urls.sh <superuser> <database>
#
# migrate.sh runs this every boot, last before the API starts and after the database has said which names
# it answers to (v0.2.16 renames the superuser and the database). Not postgres-init, which runs before the
# database is up and so cannot ask. The passwords are the generated ones on the database volume; they are
# hex, so they go into a URL as they are. Each file is written whole under a temporary name in the same
# directory and renamed over the old one: a reader sees the old string or the new one, never half of one.
# Nothing is printed but errors, and never a password. The directory is s6's own, root's and 0700: pwuser
# cannot write it and the Bot's shell does not read it.
#
# An explicit runtime DATABASE_URL or ROLE_WRITER_DATABASE_URL, a mistaken owner URL included, is left as
# it is: the readiness gate must see that configuration and refuse it, not have it quietly replaced.
#
# The overrides exist for the tests; the delivery image uses the defaults.
set -eu
umask 077

DIR=${DATABASE_URLS_DIR:-/run/s6/container_environment}
SECRETS=${DATABASE_SECRETS_DIR:-/var/lib/postgresql}

[ "$#" -eq 2 ] || { echo 'usage: database-urls.sh <superuser> <database>' >&2; exit 2; }
owner=$1 db=$2
for n in "$owner" "$db"; do
  case $n in '' | *[!a-z0-9_]*) echo "database-urls: not a database name: $n" >&2; exit 2 ;; esac
done

# Generated as 32 random bytes in hex (postgres-init), checked the way migrate.sh checks them.
secret() { # file
  v=$(cat "$SECRETS/$1" 2>/dev/null) || v=''
  [ "${#v}" -eq 64 ] || v=''
  case $v in
    '' | *[!0-9a-f]*)
      echo "database-urls: $SECRETS/$1 is missing or not a generated password; restore it with the database volume." >&2
      exit 1
      ;;
  esac
  printf '%s' "$v"
}

# The temporary file holds a password until it is renamed: removed on any way out.
tmp=''
trap '[ -z "$tmp" ] || rm -f "$tmp"' EXIT
put() { # name value
  tmp=$(mktemp "$DIR/.$1.XXXXXX")
  printf '%s' "$2" >"$tmp"
  mv -f "$tmp" "$DIR/$1"
  tmp=''
}

owner_pw=$(secret pgpassword)
put MIGRATION_DATABASE_URL "postgres://$owner:$owner_pw@127.0.0.1:5432/$db"
if [ -z "${DATABASE_URL:-}" ]; then
  app_pw=$(secret pgpassword-app)
  put DATABASE_URL "postgres://openbot_app:$app_pw@127.0.0.1:5432/$db"
fi
# The server refuses to start without the role writer; same rule as DATABASE_URL for an explicit value.
if [ -z "${ROLE_WRITER_DATABASE_URL:-}" ]; then
  writer_pw=$(secret pgpassword-role-writer)
  put ROLE_WRITER_DATABASE_URL "postgres://openbot_role_writer:$writer_pw@127.0.0.1:5432/$db"
fi
