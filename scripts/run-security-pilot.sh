#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ -n "${COMPOSE_FILE:-}" ]]; then
  echo "BLOCKED: an existing compose file is selected; refusing non-pilot compose" >&2
  exit 3
fi
ENV_FILE="${SECURITY_PILOT_ENV_FILE:-.env.security-pilot.example}"
if [[ "$ENV_FILE" != /* ]]; then ENV_FILE="$REPO_ROOT/$ENV_FILE"; fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "BLOCKED: security pilot env file is missing: $ENV_FILE" >&2
  exit 3
fi

set -a
# This is a checked-in synthetic-only example file; no other dotenv file is loaded.
. "$ENV_FILE"
set +a

COMPOSE_FILE="${SECURITY_PILOT_COMPOSE_FILE:-docker-compose.security-pilot.yml}"
if [[ "$COMPOSE_FILE" != /* ]]; then COMPOSE_FILE="$REPO_ROOT/$COMPOSE_FILE"; fi
MODEL_CACHE="${SECURITY_PILOT_MODEL_CACHE:-$HOME/.cache/huggingface/hub/models--Xenova--multilingual-e5-small}"
DATABASE_URL="${DATABASE_URL:-postgresql://memento_pilot:local_security_pilot_only@127.0.0.1:35434/memento_security_pilot}"
export DATABASE_URL

if ! command -v docker >/dev/null 2>&1; then
  echo "BLOCKED: docker is unavailable; refusing external pull" >&2
  exit 3
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "BLOCKED: docker compose is unavailable; refusing external pull" >&2
  exit 3
fi
if ! docker image inspect pgvector/pgvector:pg15 >/dev/null 2>&1; then
  echo "BLOCKED: pgvector image is not present locally; refusing external pull" >&2
  exit 3
fi
if [[ ! -f "$MODEL_CACHE/config.json" || ! -f "$MODEL_CACHE/tokenizer.json" ]]; then
  echo "BLOCKED: transformers model cache is missing; refusing external download" >&2
  exit 3
fi
for port in 35432 35433; do
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tail -n +2 | grep -q .; then
    echo "BLOCKED: port $port is already listening; refusing existing test/dev runtime" >&2
    exit 3
  fi
done
if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "BLOCKED: dedicated compose file is missing: $COMPOSE_FILE" >&2
  exit 3
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "BLOCKED: psql is unavailable; refusing to run the pilot without SQL readback" >&2
  exit 3
fi

cd "$REPO_ROOT"
COMPOSE_ARGS=(--project-name anchormind-security-pilot -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
docker compose "${COMPOSE_ARGS[@]}" config --services | grep -Fxq postgres-security-pilot

cleanup() {
  local rc=$?
  set +e
  docker compose "${COMPOSE_ARGS[@]}" down --remove-orphans >/tmp/anchormind-security-pilot-down.log 2>&1
  local down_rc=$?
  if (( down_rc != 0 )); then
    echo "WARN: dedicated compose teardown failed; see /tmp/anchormind-security-pilot-down.log" >&2
    if (( rc == 0 )); then rc=1; fi
  fi
  exit "$rc"
}
trap cleanup EXIT

docker compose "${COMPOSE_ARGS[@]}" up -d --wait
SERVICE_ID="$(docker compose "${COMPOSE_ARGS[@]}" ps -q postgres-security-pilot)"
[[ -n "$SERVICE_ID" ]]
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$SERVICE_ID")" == "healthy" ]]
[[ "$(docker port "$SERVICE_ID" 5432/tcp)" == 127.0.0.1:35434 ]]
[[ "$(docker inspect -f '{{range .Mounts}}{{.Name}}{{end}}' "$SERVICE_ID")" == anchormind_security_pilot_pgdata ]]
NETWORK_NAME="$(docker inspect -f '{{range $name, $network := .NetworkSettings.Networks}}{{$name}}{{end}}' "$SERVICE_ID")"
[[ "$(docker network inspect -f '{{.Internal}}' "$NETWORK_NAME")" == true ]]

echo "[security-pilot] database=memento_security_pilot"
echo "[security-pilot] binding=127.0.0.1:35434"
echo "[security-pilot] volume=anchormind_security_pilot_pgdata"
echo "[security-pilot] network=$NETWORK_NAME internal=true"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/memory/memory-schema.sql >/dev/null
node scripts/migrate.js

MEMENTO_METRICS_DEFAULT=off \
REDIS_ENABLED=false \
CACHE_ENABLED=false \
MEMENTO_SECURITY_PILOT_AUTOMATION=off \
MEMENTO_AUTO_REFLECT=false \
MEMENTO_GRAPH_LINK=false \
MEMENTO_CONSOLIDATE=false \
MEMENTO_GC=false \
MEMENTO_CONSOLIDATE_SPLIT_LONG=false \
MEMENTO_CONSOLIDATE_DETECT_CONTRADICT=false \
MEMENTO_CONSOLIDATE_COMPRESS_OLD=false \
ENABLE_RECONSOLIDATION=false \
ENABLE_SPREADING_ACTIVATION=false \
HF_HUB_OFFLINE=1 \
TRANSFORMERS_OFFLINE=1 \
EMBEDDING_PROVIDER=transformers \
EMBEDDING_MODEL=Xenova/multilingual-e5-small \
node --test --test-concurrency=1 tests/integration/security-pilot.test.js | tee /tmp/anchormind-security-pilot-test.log
grep -Fxq '[security-pilot] external_network_attempts=0' /tmp/anchormind-security-pilot-test.log

[[ "$(psql "$DATABASE_URL" -Atqc 'SELECT current_database()')" == memento_security_pilot ]]
[[ "$(psql "$DATABASE_URL" -Atqc "SELECT extname FROM pg_extension WHERE extname = 'vector'")" == vector ]]
[[ "$(psql "$DATABASE_URL" -Atqc "SELECT count(*) FROM agent_memory.fragments WHERE topic = 'security-pilot-synthetic'")" == 3 ]]
EXPECTED_PAIRS=$'00000000-0000-0000-0000-00000000aaaa|pilot-ws-a\n00000000-0000-0000-0000-00000000aaaa|pilot-ws-b\n00000000-0000-0000-0000-00000000bbbb|pilot-ws-a'
ACTUAL_PAIRS=$(psql "$DATABASE_URL" -Atqc "SELECT key_id || '|' || workspace FROM agent_memory.fragments WHERE topic = 'security-pilot-synthetic' ORDER BY key_id, workspace")
[[ "$ACTUAL_PAIRS" == "$EXPECTED_PAIRS" ]]
echo "[security-pilot] fixture_count=3"
printf '%s\n' "$ACTUAL_PAIRS"
echo "[security-pilot] tripwire=zero-non-loopback"
