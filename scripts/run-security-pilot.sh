#!/usr/bin/env bash
set -euo pipefail

security_pilot_require() {
  local description="$1"
  shift
  if ! "$@"; then
    echo "BLOCKED: $description" >&2
    exit 1
  fi
}

parse_security_pilot_egress_log() {
  local log_file="$1"
  awk '
    $0 == "[security-pilot] external_network_attempts=0" ||
    $0 == "# [security-pilot] external_network_attempts=0" { count++ }
    END { exit (count == 1 ? 0 : 1) }
  ' "$log_file"
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
. "$REPO_ROOT/scripts/security-pilot-cleanup.sh"
if [[ -n "${COMPOSE_FILE:-}" ]]; then
  echo "BLOCKED: an existing compose file is selected; refusing non-pilot compose" >&2
  exit 3
fi
reject_conflicting_inherited() {
  local name expected value
  for name in "$@"; do
    expected="${2:-}"
    case "$name" in
      DATABASE_URL) expected="postgresql://memento_pilot:local_security_pilot_only@127.0.0.1:35434/memento_security_pilot" ;;
      POSTGRES_HOST|DB_HOST|PGHOST) expected="127.0.0.1" ;;
      POSTGRES_PORT|DB_PORT|PGPORT) expected="35434" ;;
      POSTGRES_DB|DB_NAME|PGDATABASE) expected="memento_security_pilot" ;;
      POSTGRES_USER|DB_USER|PGUSER) expected="memento_pilot" ;;
      POSTGRES_PASSWORD|DB_PASSWORD|PGPASSWORD) expected="local_security_pilot_only" ;;
      BATCH_DATABASE_URL|PGSERVICE|EMBEDDING_API_KEY|EMBEDDING_BASE_URL|SECURITY_PILOT_DEFER_SYNTHETIC_CLEANUP|OPENAI_API_KEY|GEMINI_API_KEY|CF_API_TOKEN|CLOUDFLARE_API_TOKEN|ANTHROPIC_API_KEY|XAI_API_KEY|GOOGLE_API_KEY|AZURE_OPENAI_API_KEY) expected="" ;;
    esac
    value="${!name-}"
    if [[ -n "$value" && "$value" != "$expected" ]]; then
      echo "BLOCKED: inherited $name conflicts with the dedicated security-pilot contract" >&2
      exit 3
    fi
  done
}
reject_conflicting_inherited \
  DATABASE_URL POSTGRES_HOST POSTGRES_PORT POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD \
  DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD \
  BATCH_DATABASE_URL PGSERVICE EMBEDDING_API_KEY EMBEDDING_BASE_URL \
  SECURITY_PILOT_DEFER_SYNTHETIC_CLEANUP \
  OPENAI_API_KEY GEMINI_API_KEY CF_API_TOKEN CLOUDFLARE_API_TOKEN \
  ANTHROPIC_API_KEY XAI_API_KEY GOOGLE_API_KEY AZURE_OPENAI_API_KEY
EXPECTED_ENV_FILE="$REPO_ROOT/.env.security-pilot.example"
ENV_FILE="${SECURITY_PILOT_ENV_FILE:-.env.security-pilot.example}"
if [[ "$ENV_FILE" != /* ]]; then ENV_FILE="$REPO_ROOT/$ENV_FILE"; fi
if [[ ! -f "$ENV_FILE" || "$ENV_FILE" != "$EXPECTED_ENV_FILE" ]]; then
  echo "BLOCKED: security pilot env file is missing: $ENV_FILE" >&2
  exit 3
fi

set -a
# This is a checked-in synthetic-only example file; no other dotenv file is loaded.
. "$ENV_FILE"
set +a

COMPOSE_FILE="${SECURITY_PILOT_COMPOSE_FILE:-docker-compose.security-pilot.yml}"
if [[ "$COMPOSE_FILE" != /* ]]; then COMPOSE_FILE="$REPO_ROOT/$COMPOSE_FILE"; fi
MODEL_ID="${SECURITY_PILOT_MODEL_ID:-Xenova/multilingual-e5-small}"
MODEL_CACHE="${SECURITY_PILOT_MODEL_CACHE:-$HOME/.cache/huggingface/hub}"
if [[ "$(basename "$MODEL_CACHE")" == models--* ]]; then
  MODEL_CACHE="$(dirname "$MODEL_CACHE")"
fi
MODEL_DIR="$MODEL_CACHE/models--${MODEL_ID//\//--}"
DATABASE_URL="${DATABASE_URL:-postgresql://memento_pilot:local_security_pilot_only@127.0.0.1:35434/memento_security_pilot}"
export DATABASE_URL
EXPECTED_COMPOSE_FILE="$REPO_ROOT/docker-compose.security-pilot.yml"
if [[ "$COMPOSE_FILE" != "$EXPECTED_COMPOSE_FILE" ]]; then
  echo "BLOCKED: compose path is not the canonical security-pilot file: $COMPOSE_FILE" >&2
  exit 3
fi
if [[ "$DATABASE_URL" != "postgresql://memento_pilot:local_security_pilot_only@127.0.0.1:35434/memento_security_pilot" ]]; then
  echo "BLOCKED: DATABASE_URL must target only the dedicated loopback pilot database" >&2
  exit 3
fi
if [[ "${SECURITY_PILOT_DB_HOST:-}" != "127.0.0.1" ||
      "${SECURITY_PILOT_DB_PORT:-}" != "35434" ||
      "${SECURITY_PILOT_DB_NAME:-}" != "memento_security_pilot" ||
      "${SECURITY_PILOT_DB_USER:-}" != "memento_pilot" ||
      "${SECURITY_PILOT_DB_PASSWORD:-}" != "local_security_pilot_only" ]]; then
  echo "BLOCKED: security pilot database settings are not the dedicated local contract" >&2
  exit 3
fi
if [[ "${POSTGRES_HOST:-}" != "127.0.0.1" || "${POSTGRES_PORT:-}" != "35434" ||
      "${POSTGRES_DB:-}" != "memento_security_pilot" ||
      "${POSTGRES_USER:-}" != "memento_pilot" ||
      "${POSTGRES_PASSWORD:-}" != "local_security_pilot_only" ||
      "${DB_HOST:-}" != "127.0.0.1" || "${DB_PORT:-}" != "35434" ||
      "${DB_NAME:-}" != "memento_security_pilot" ||
      "${DB_USER:-}" != "memento_pilot" ||
      "${DB_PASSWORD:-}" != "local_security_pilot_only" ||
      -n "${BATCH_DATABASE_URL:-}" || -n "${PGSERVICE:-}" ]]; then
  echo "BLOCKED: inherited/application database settings are not the dedicated local contract" >&2
  exit 3
fi
if [[ "${EMBEDDING_PROVIDER:-}" != "transformers" ||
      "${EMBEDDING_DIMENSIONS:-}" != "384" ||
      -n "${EMBEDDING_API_KEY:-}" ]]; then
  echo "BLOCKED: embedding provider contract is not local transformers 384-dimensional mode" >&2
  exit 3
fi
if [[ -z "${MEMENTO_ACCESS_KEY:-}" || "${MEMENTO_AUTH_DISABLED:-}" == "true" ||
      "${MEMENTO_BIND_HOST:-127.0.0.1}" != "127.0.0.1" ]]; then
  echo "BLOCKED: security pilot requires an access key, authentication, and bind host 127.0.0.1" >&2
  exit 3
fi
for credential in OPENAI_API_KEY GEMINI_API_KEY CF_API_TOKEN CLOUDFLARE_API_TOKEN \
  ANTHROPIC_API_KEY XAI_API_KEY GOOGLE_API_KEY AZURE_OPENAI_API_KEY; do
  if [[ -n "${!credential:-}" ]]; then
    echo "BLOCKED: external credential $credential is set; refusing pilot imports" >&2
    exit 3
  fi
done
if [[ -n "${EMBEDDING_BASE_URL:-}" ]]; then
  echo "BLOCKED: EMBEDDING_BASE_URL must be empty for the local transformers pilot" >&2
  exit 3
fi
if [[ "${LLM_PRIMARY:-}" != "none" || "${LLM_FALLBACKS:-}" != "[]" ||
      -n "${RERANKER_URL:-}" || -n "${NLI_SERVICE_URL:-}" ]]; then
  echo "BLOCKED: external LLM, reranker, or NLI configuration is not empty/off" >&2
  exit 3
fi
if [[ "${MEMENTO_SPLIT_LLM_PRIMARY:-}" != "none" ||
      "${MEMENTO_SPLIT_LLM_FALLBACKS:-}" != "[]" ||
      "${MEMENTO_MORPHEME_TOKENIZER:-}" != "local" ]]; then
  echo "BLOCKED: split/tokenizer LLM fallback is not disabled" >&2
  exit 3
fi
if [[ "${MEMENTO_SECURITY_PILOT_AUTOMATION:-}" != "off" ||
      "${MEMENTO_AUTO_REFLECT:-}" != "false" ||
      "${MEMENTO_GRAPH_LINK:-}" != "false" ||
      "${MEMENTO_CONSOLIDATE:-}" != "false" ||
      "${MEMENTO_GC:-}" != "false" ||
      "${MEMENTO_CONSOLIDATE_SPLIT_LONG:-}" != "false" ||
      "${MEMENTO_CONSOLIDATE_DETECT_CONTRADICT:-}" != "false" ||
      "${MEMENTO_CONSOLIDATE_COMPRESS_OLD:-}" != "false" ||
      "${ENABLE_RECONSOLIDATION:-}" != "false" ||
      "${ENABLE_SPREADING_ACTIVATION:-}" != "false" ]]; then
  echo "BLOCKED: security pilot automation is not fully disabled" >&2
  exit 3
fi
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
SNAPSHOT_DIR=""
if [[ -d "$MODEL_DIR/snapshots" ]]; then
  while IFS= read -r candidate; do
    if [[ -f "$candidate/config.json" && -f "$candidate/tokenizer.json" ]]; then
      SNAPSHOT_DIR="$candidate"
      break
    fi
  done < <(find "$MODEL_DIR/snapshots" -mindepth 1 -maxdepth 1 -type d -print | sort)
fi
if [[ -z "$SNAPSHOT_DIR" ]]; then
  echo "BLOCKED: transformers model cache snapshot is missing; refusing external download" >&2
  exit 3
fi
if [[ ! -f "$SNAPSHOT_DIR/onnx/model_quantized.onnx" &&
      ! -f "$SNAPSHOT_DIR/onnx/model_q8.onnx" ]]; then
  echo "BLOCKED: transformers q8 ONNX model is missing from the local snapshot; refusing external download" >&2
  exit 3
fi
export SECURITY_PILOT_MODEL_CACHE="$MODEL_CACHE"
export SECURITY_PILOT_MODEL_SNAPSHOT="$SNAPSHOT_DIR"
export SECURITY_PILOT_MODEL_ID="$MODEL_ID"
export EMBEDDING_MODEL="$SNAPSHOT_DIR"
export DOTENV_CONFIG_PATH="$ENV_FILE"
port_is_listening() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tail -n +2 | grep -q .
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)${port}$"
  elif command -v netstat >/dev/null 2>&1; then
    netstat -an -p tcp 2>/dev/null | grep LISTEN | grep -Eq "[.:]${port}[[:space:]]"
  else
    echo "BLOCKED: no listener inspection tool (lsof, ss, or netstat) is available" >&2
    exit 3
  fi
}
for port in 35432 35433; do
  if port_is_listening "$port"; then
    echo "BLOCKED: port $port is already listening; refusing existing test/dev runtime" >&2
    exit 3
  fi
done
if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "BLOCKED: dedicated compose file is missing: $COMPOSE_FILE" >&2
  exit 3
fi

cd "$REPO_ROOT"
COMPOSE_ARGS=(--project-name anchormind-security-pilot -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
EXPECTED_NETWORK_KEY=security_pilot_internal
EXPECTED_NETWORK_NAME=anchormind_security_pilot_bridge
if ! test "$(docker compose "${COMPOSE_ARGS[@]}" config --services)" = "postgres-security-pilot"; then
  echo "BLOCKED: dedicated compose service contract is invalid" >&2
  exit 3
fi
if ! test "$(docker compose "${COMPOSE_ARGS[@]}" config --networks)" = "$EXPECTED_NETWORK_KEY"; then
  echo "BLOCKED: dedicated compose network contract is invalid" >&2
  exit 3
fi

SYNTHETIC_TOPIC=security-pilot-synthetic
SYNTHETIC_API_KEY_A=00000000-0000-0000-0000-00000000aaaa
SYNTHETIC_API_KEY_B=00000000-0000-0000-0000-00000000bbbb

trap security_pilot_cleanup EXIT

docker compose "${COMPOSE_ARGS[@]}" up -d --wait --pull never
SERVICE_ID="$(docker compose "${COMPOSE_ARGS[@]}" ps -q postgres-security-pilot)"
security_pilot_require "canonical PostgreSQL service was not created" test -n "$SERVICE_ID"
security_pilot_require "canonical PostgreSQL service is not healthy" test "$(docker inspect -f '{{.State.Health.Status}}' "$SERVICE_ID")" = "healthy"
security_pilot_require "canonical PostgreSQL port binding is not loopback-only" test "$(docker port "$SERVICE_ID")" = "5432/tcp -> 127.0.0.1:35434"
security_pilot_require "canonical PostgreSQL volume is not mounted" test "$(docker inspect -f '{{range .Mounts}}{{.Name}}{{end}}' "$SERVICE_ID")" = anchormind_security_pilot_pgdata
NETWORK_NAME="$(docker inspect -f '{{range $name, $network := .NetworkSettings.Networks}}{{$name}}{{end}}' "$SERVICE_ID")"
security_pilot_require "canonical PostgreSQL network is not selected" test "$NETWORK_NAME" = "$EXPECTED_NETWORK_NAME"
security_pilot_require "canonical PostgreSQL network must be non-internal" test "$(docker network inspect -f '{{.Internal}}' "$NETWORK_NAME")" = false

# Prefer host PostgreSQL clients when available. Otherwise use only the
# already-healthy canonical service; never target an arbitrary container.
if command -v psql >/dev/null 2>&1; then
  SECURITY_PILOT_PSQL_MODE=host
else
  SECURITY_PILOT_PSQL_MODE=container
fi
if command -v pg_isready >/dev/null 2>&1; then
  SECURITY_PILOT_PG_ISREADY_MODE=host
else
  SECURITY_PILOT_PG_ISREADY_MODE=container
fi
run_security_pilot_pg_isready() {
  if [[ "$SECURITY_PILOT_PG_ISREADY_MODE" == host ]]; then
    PGPASSWORD="$SECURITY_PILOT_DB_PASSWORD" pg_isready \
      -h "$SECURITY_PILOT_DB_HOST" -p "$SECURITY_PILOT_DB_PORT" \
      -U "$SECURITY_PILOT_DB_USER" -d "$SECURITY_PILOT_DB_NAME"
  else
    docker compose "${COMPOSE_ARGS[@]}" exec -T postgres-security-pilot \
      pg_isready -U "${SECURITY_PILOT_DB_USER}" -d "${SECURITY_PILOT_DB_NAME}"
  fi
}
run_security_pilot_psql() {
  if [[ "$SECURITY_PILOT_PSQL_MODE" == host ]]; then
    psql "$DATABASE_URL" "$@"
  else
    docker compose "${COMPOSE_ARGS[@]}" exec -T postgres-security-pilot \
      psql -U "${SECURITY_PILOT_DB_USER}" -d "${SECURITY_PILOT_DB_NAME}" "$@"
  fi
}
run_security_pilot_pg_isready >/dev/null

echo "[security-pilot] database=memento_security_pilot"
echo "[security-pilot] binding=127.0.0.1:35434"
echo "[security-pilot] volume=anchormind_security_pilot_pgdata"
echo "[security-pilot] network=$NETWORK_NAME internal=false"

run_security_pilot_psql -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null
run_security_pilot_psql -v ON_ERROR_STOP=1 -f - < lib/memory/memory-schema.sql >/dev/null
node scripts/migrate.js
EMBEDDING_DIMENSIONS=384 node scripts/post-migrate-flexible-embedding-dims.js

MEMENTO_METRICS_DEFAULT=off \
REDIS_ENABLED=false \
CACHE_ENABLED=false \
MEMENTO_SECURITY_PILOT_AUTOMATION=off \
MEMENTO_AUTO_REFLECT=false \
MEMENTO_ACCESS_KEY="${MEMENTO_ACCESS_KEY}" \
MEMENTO_AUTH_DISABLED=false \
MEMENTO_BIND_HOST=127.0.0.1 \
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
HF_DATASETS_OFFLINE=1 \
TRANSFORMERS_CACHE="$MODEL_CACHE" \
SECURITY_PILOT_MODEL_CACHE="$MODEL_CACHE" \
SECURITY_PILOT_MODEL_SNAPSHOT="$SNAPSHOT_DIR" \
LLM_PRIMARY=none \
LLM_FALLBACKS='[]' \
RERANKER_URL= \
NLI_SERVICE_URL= \
  EMBEDDING_PROVIDER=transformers \
  EMBEDDING_MODEL="$SNAPSHOT_DIR" \
  EMBEDDING_DIMENSIONS=384 \
  SECURITY_PILOT_DEFER_SYNTHETIC_CLEANUP=true \
  node --test --test-concurrency=1 tests/integration/security-pilot.test.js | tee /tmp/anchormind-security-pilot-test.log
if ! parse_security_pilot_egress_log /tmp/anchormind-security-pilot-test.log; then
  echo "BLOCKED: expected exactly one external-network egress diagnostic" >&2
  exit 1
fi

security_pilot_require "authoritative database identity readback failed" test "$(run_security_pilot_psql -Atqc 'SELECT current_database()')" = memento_security_pilot
security_pilot_require "authoritative vector extension readback failed" test "$(run_security_pilot_psql -Atqc "SELECT extname FROM pg_extension WHERE extname = 'vector'")" = vector
security_pilot_require "authoritative embedding dimension readback failed" test "$(run_security_pilot_psql -Atqc "SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'agent_memory' AND c.relname = 'fragments' AND a.attname = 'embedding'")" = "vector(384)"
EXPECTED_COUNT=$(node --input-type=module -e "import fs from 'node:fs'; const rows=fs.readFileSync('tests/fixtures/security-pilot.ndjson','utf8').trim().split('\\n').map(JSON.parse).filter(row=>row.kind==='fragment'); console.log(rows.length)")
security_pilot_require "authoritative synthetic fixture count readback failed" test "$(run_security_pilot_psql -Atqc "SELECT count(*) FROM agent_memory.fragments WHERE topic = '$SYNTHETIC_TOPIC'")" = "$EXPECTED_COUNT"
EXPECTED_PAIRS=$(node --input-type=module -e "import fs from 'node:fs'; const rows=fs.readFileSync('tests/fixtures/security-pilot.ndjson','utf8').trim().split('\\n').map(JSON.parse).filter(row=>row.kind==='fragment').map(row=>row.key_id+'|'+row.workspace).sort(); console.log(rows.join('\\n'))")
ACTUAL_PAIRS=$(run_security_pilot_psql -Atqc "SELECT key_id || '|' || workspace FROM agent_memory.fragments WHERE topic = '$SYNTHETIC_TOPIC' ORDER BY key_id, workspace")
security_pilot_require "authoritative synthetic fixture pair readback failed" test "$ACTUAL_PAIRS" = "$EXPECTED_PAIRS"
echo "[security-pilot] fixture_count=$EXPECTED_COUNT"
echo "[security-pilot] fixture_pairs="
printf '%s\n' "$ACTUAL_PAIRS"
security_pilot_delete_synthetic_rows
REMAINING_SYNTHETIC_ROWS=$(run_security_pilot_psql -Atqc "SELECT
  (SELECT count(*) FROM agent_memory.fragments WHERE topic = '$SYNTHETIC_TOPIC') +
  (SELECT count(*) FROM agent_memory.api_keys WHERE id IN ('$SYNTHETIC_API_KEY_A', '$SYNTHETIC_API_KEY_B'))")
security_pilot_require "synthetic fixture cleanup readback failed" test "$REMAINING_SYNTHETIC_ROWS" = 0
echo "[security-pilot] tripwire=zero-non-loopback"
