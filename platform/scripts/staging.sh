#!/usr/bin/env bash
# Local staging: a throwaway Postgres 16 cluster with the Supabase auth stub and every migration applied in order.
# Never touches the hosted project. Usage:
#   scripts/staging.sh          (re)create the cluster, apply migrations, print DATABASE_URL (server keeps running)
#   scripts/staging.sh stop     stop the server
# Env: STAGING_PORT (default 54329), PG_BIN (default /usr/lib/postgresql/16/bin).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # platform/
STAGE="$ROOT/.staging"
DATA="$STAGE/data"
PORT="${STAGING_PORT:-54329}"
BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
DB=everyspace
URL="postgresql://postgres@127.0.0.1:$PORT/$DB"

# Postgres refuses to run as root: run server commands as the postgres OS user when we are root.
as_pg() { if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
stop() { if [ -f "$DATA/postmaster.pid" ]; then as_pg "$BIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null || true; fi; }

if [ "${1:-}" = stop ]; then stop; echo "staging stopped"; exit 0; fi

stop
rm -rf "$STAGE"
mkdir -p "$STAGE"
[ "$(id -u)" = 0 ] && chown postgres: "$STAGE"
as_pg "$BIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >"$STAGE/initdb.log"
as_pg "$BIN/pg_ctl" -D "$DATA" -l "$STAGE/server.log" -w \
  -o "-p $PORT -c listen_addresses=127.0.0.1 -k $STAGE -c fsync=off" start >/dev/null

PSQL=("$BIN/psql" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U postgres)
"${PSQL[@]}" -d postgres -c "create database $DB"
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/helpers/auth_stub.sql"
# Record applied versions the way the Supabase CLI does, so the replay test can compare against the files.
"${PSQL[@]}" -d "$DB" -c "create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key, name text not null)"

n=0
for f in "$ROOT"/supabase/migrations/*.sql; do
  base="$(basename "$f" .sql)"
  version="${base%%_*}"; name="${base#*_}"
  # One transaction per migration (like `supabase db push`); stop on the first error.
  "${PSQL[@]}" -d "$DB" -1 -f "$f" -c "insert into supabase_migrations.schema_migrations values ('$version', '$name')" \
    || { echo "staging: migration $base failed" >&2; exit 1; }
  n=$((n + 1))
done

echo "staging: applied $n migrations on Postgres $("${PSQL[@]}" -d "$DB" -Atc 'show server_version')"
echo "DATABASE_URL=$URL" | tee "$STAGE/env"
