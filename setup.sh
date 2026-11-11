#!/usr/bin/env bash
# Memento MCP Setup

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}${BOLD}[setup]${RESET} $*"; }
success() { echo -e "${GREEN}${BOLD}[ok]${RESET} $*"; }
warn()    { echo -e "${YELLOW}${BOLD}[!]${RESET} $*"; }
error()   { echo -e "${RED}${BOLD}[x]${RESET} $*" >&2; }

ask() {
  local prompt="$1" default="${2:-}" var
  if [[ -n "$default" ]]; then
    read -rp "$(echo -e "${BOLD}${prompt}${RESET} [${default}]: ")" var
    echo "${var:-$default}"
  else
    read -rp "$(echo -e "${BOLD}${prompt}${RESET}: ")" var
    echo "$var"
  fi
}

ask_secret() {
  local prompt="$1" var
  read -rsp "$(echo -e "${BOLD}${prompt}${RESET}: ")" var
  echo
  echo "$var"
}

ask_yn() {
  local prompt="$1" default="${2:-y}" ans
  read -rp "$(echo -e "${BOLD}${prompt}${RESET} [${default}]: ")" ans
  ans="${ans:-$default}"
  [[ "$ans" =~ ^[Yy] ]]
}

echo
echo -e "${BOLD}------------------------------------------${RESET}"
echo -e "${BOLD}  Memento MCP -- Interactive Setup${RESET}"
echo -e "${BOLD}------------------------------------------${RESET}"
echo

# .env check
ENV_FILE=".env"

if [[ -f "$ENV_FILE" ]]; then
  warn ".env already exists."
  if ! ask_yn "Overwrite?" "n"; then
    info "Keeping existing .env. Exiting."
    exit 0
  fi
  cp "$ENV_FILE" "${ENV_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
  success "Backed up existing .env."
fi

echo

# Server
info "Server"
PORT=$(ask "Port" "57332")
SESSION_TTL=$(ask "Session TTL (minutes)" "43200")
LOG_DIR=$(ask "Log directory" "/var/log/mcp")

MEMENTO_ACCESS_KEY=""
MEMENTO_AUTH_DISABLED=""

while true; do
  MEMENTO_ACCESS_KEY=$(ask_secret "Access key (MEMENTO_ACCESS_KEY, leave blank for dev mode)")
  if [[ -n "$MEMENTO_ACCESS_KEY" ]]; then
    break
  fi
  warn "MEMENTO_ACCESS_KEY is required from v2.7.0. Blank value causes server startup failure."
  if ask_yn "Disable authentication instead? (dev only -- sets MEMENTO_AUTH_DISABLED=true)" "n"; then
    MEMENTO_AUTH_DISABLED="true"
    break
  fi
  warn "Please enter a non-empty access key, or choose to disable authentication."
done

echo

# PostgreSQL
info "PostgreSQL"
PG_HOST=$(ask "Host" "localhost")
PG_PORT=$(ask "Port" "5432")
PG_DB=$(ask "Database name")
PG_USER=$(ask "User")
PG_PASSWORD=$(ask_secret "Password")
DB_MAX_CONNECTIONS=$(ask "Max connections" "20")

DATABASE_URL="postgresql://${PG_USER}:$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$PG_PASSWORD")@${PG_HOST}:${PG_PORT}/${PG_DB}"

echo

# Redis
info "Redis"
if ask_yn "Enable Redis?" "y"; then
  REDIS_ENABLED="true"
  REDIS_HOST=$(ask "Host" "localhost")
  REDIS_PORT=$(ask "Port" "6379")
  REDIS_PASSWORD=$(ask_secret "Password (leave blank if none)")
  REDIS_DB=$(ask "DB index" "0")
else
  REDIS_ENABLED="false"
  REDIS_HOST="localhost"; REDIS_PORT="6379"; REDIS_PASSWORD=""; REDIS_DB="0"
fi

echo

# Embedding provider
info "Embedding Provider"
echo "  1) openai        (text-embedding-3-small, 1536 dims)"
echo "  2) gemini        (gemini-embedding-001, 3072 dims)"
echo "  3) ollama        (local, nomic-embed-text)"
echo "  4) localai       (local OpenAI-compatible)"
echo "  5) custom        (manual configuration)"
echo "  6) none          (disable semantic search)"
echo "  7) transformers  (local, no API key, ~150MB)"
EMBED_CHOICE=$(ask "Choice" "1")

EMBEDDING_PROVIDER=""; EMBEDDING_API_KEY=""; EMBEDDING_MODEL=""
EMBEDDING_DIMENSIONS=""; EMBEDDING_BASE_URL=""

case "$EMBED_CHOICE" in
  1)
    EMBEDDING_PROVIDER="openai"
    EMBEDDING_API_KEY=$(ask_secret "OpenAI API Key")
    EMBEDDING_MODEL=$(ask "Model" "text-embedding-3-small")
    EMBEDDING_DIMENSIONS=$(ask "Dimensions" "1536")
    ;;
  2)
    EMBEDDING_PROVIDER="gemini"
    EMBEDDING_API_KEY=$(ask_secret "Gemini API Key")
    EMBEDDING_MODEL=$(ask "Model" "gemini-embedding-001")
    EMBEDDING_DIMENSIONS=$(ask "Dimensions" "3072")
    warn "3072 dims: fragments + morpheme_dict 두 테이블을 동시 처리합니다 (v2.9.0+). post-migrate-flexible-embedding-dims required."
    ;;
  3)
    EMBEDDING_PROVIDER="ollama"
    EMBEDDING_MODEL=$(ask "Model" "nomic-embed-text")
    EMBEDDING_DIMENSIONS=$(ask "Dimensions" "768")
    ;;
  4)
    EMBEDDING_PROVIDER="localai"
    EMBEDDING_MODEL=$(ask "Model" "text-embedding-ada-002")
    EMBEDDING_DIMENSIONS=$(ask "Dimensions" "1536")
    ;;
  5)
    EMBEDDING_PROVIDER="custom"
    EMBEDDING_BASE_URL=$(ask "Base URL (e.g. http://localhost:8080/v1)")
    EMBEDDING_API_KEY=$(ask_secret "API Key")
    EMBEDDING_MODEL=$(ask "Model name")
    EMBEDDING_DIMENSIONS=$(ask "Dimensions")
    ;;
  6)
    EMBEDDING_PROVIDER=""
    ;;
  7)
    EMBEDDING_PROVIDER="transformers"
    echo "  a) Xenova/multilingual-e5-small (384d, ~150MB, default)"
    echo "  b) Xenova/bge-m3               (1024d, ~600MB, high quality multilingual)"
    EMBED_MODEL_CHOICE=$(ask "Model" "a")
    if [[ "$EMBED_MODEL_CHOICE" == "b" ]]; then
      EMBEDDING_MODEL="Xenova/bge-m3"
      EMBEDDING_DIMENSIONS="1024"
    else
      EMBEDDING_MODEL="Xenova/multilingual-e5-small"
      EMBEDDING_DIMENSIONS="384"
    fi
    warn "API keys (OPENAI/GEMINI/EMBEDDING_API_KEY) must NOT be set -- 상호 배타 가드."
    warn "Initial model download (~120MB) on first use."
    warn "fragments + morpheme_dict 두 테이블을 동시 처리합니다 (v2.9.0+). post-migrate-flexible-embedding-dims required."
    ;;
esac

echo

# LLM provider chain
info "LLM Provider Chain (formateme/consolidate/reflect 등에 사용)"
echo "  1) gemini-cli   (local CLI, requires 'gemini' binary login)"
echo "  2) codex-cli    (local CLI)"
echo "  3) copilot-cli  (local CLI)"
echo "  4) skip         (기능 일부 fallback)"
LLM_PRIMARY_CHOICE=$(ask "Primary provider" "1")

LLM_PRIMARY=""
case "$LLM_PRIMARY_CHOICE" in
  1) LLM_PRIMARY="gemini-cli" ;;
  2) LLM_PRIMARY="codex-cli" ;;
  3) LLM_PRIMARY="copilot-cli" ;;
  4) LLM_PRIMARY="" ;;
esac

LLM_FALLBACKS=""
if [[ -n "$LLM_PRIMARY" ]] && ask_yn "Configure fallback chain (recommended)?" "y"; then
  LLM_FALLBACKS='[{"provider":"codex-cli"},{"provider":"copilot-cli"}]'
fi

echo

# Write .env
info "Writing .env..."

cat > "$ENV_FILE" <<EOF
# Memento MCP environment variables
# Generated: $(date '+%Y-%m-%d %H:%M:%S')

# --- Server ----------------------------------------------------------
PORT=${PORT}
SESSION_TTL_MINUTES=${SESSION_TTL}
LOG_DIR=${LOG_DIR}
# NODE_ENV=production
# LOG_LEVEL=info
# WORKER_ID=single
EOF

if [[ -n "$MEMENTO_ACCESS_KEY" ]]; then
  echo "MEMENTO_ACCESS_KEY=${MEMENTO_ACCESS_KEY}" >> "$ENV_FILE"
else
  echo "# MEMENTO_ACCESS_KEY=" >> "$ENV_FILE"
fi

if [[ -n "$MEMENTO_AUTH_DISABLED" ]]; then
  echo "MEMENTO_AUTH_DISABLED=${MEMENTO_AUTH_DISABLED}" >> "$ENV_FILE"
fi

cat >> "$ENV_FILE" <<EOF

# --- CORS ------------------------------------------------------------
# ALLOWED_ORIGINS=https://example.com,https://app.example.com
# ADMIN_ALLOWED_ORIGINS=https://admin.example.com

# --- Rate Limiting ---------------------------------------------------
# RATE_LIMIT_WINDOW_MS=60000
# RATE_LIMIT_MAX_REQUESTS=120

# --- PostgreSQL ------------------------------------------------------
POSTGRES_HOST=${PG_HOST}
POSTGRES_PORT=${PG_PORT}
POSTGRES_DB=${PG_DB}
POSTGRES_USER=${PG_USER}
POSTGRES_PASSWORD=${PG_PASSWORD}
DATABASE_URL=${DATABASE_URL}
DB_MAX_CONNECTIONS=${DB_MAX_CONNECTIONS}
DB_IDLE_TIMEOUT_MS=30000
DB_CONN_TIMEOUT_MS=10000
DB_QUERY_TIMEOUT=30000

# --- Redis -----------------------------------------------------------
REDIS_ENABLED=${REDIS_ENABLED}
REDIS_HOST=${REDIS_HOST}
REDIS_PORT=${REDIS_PORT}
EOF

if [[ -n "$REDIS_PASSWORD" ]]; then
  echo "REDIS_PASSWORD=${REDIS_PASSWORD}" >> "$ENV_FILE"
else
  echo "# REDIS_PASSWORD=" >> "$ENV_FILE"
fi

cat >> "$ENV_FILE" <<EOF
REDIS_DB=${REDIS_DB}

# --- Redis Sentinel (HA) --------------------------------------------
# REDIS_SENTINEL_ENABLED=false
# REDIS_MASTER_NAME=mymaster
# REDIS_SENTINELS=host1:26379,host2:26380,host3:26381

# --- Cache -----------------------------------------------------------
CACHE_ENABLED=true
CACHE_DB_TTL=300
# CACHE_SESSION_TTL=3600

# --- Compression -----------------------------------------------------
# MIN_COMPRESS_SIZE=1024
# COMPRESSION_LEVEL=6
EOF

if [[ -n "$EMBEDDING_PROVIDER" ]]; then
  cat >> "$ENV_FILE" <<EOF

# --- Embedding -------------------------------------------------------
EMBEDDING_PROVIDER=${EMBEDDING_PROVIDER}
EOF
  if [[ "$EMBEDDING_PROVIDER" == "openai" ]]; then
    echo "OPENAI_API_KEY=${EMBEDDING_API_KEY}" >> "$ENV_FILE"
  elif [[ "$EMBEDDING_PROVIDER" == "gemini" ]]; then
    echo "GEMINI_API_KEY=${EMBEDDING_API_KEY}" >> "$ENV_FILE"
  elif [[ "$EMBEDDING_PROVIDER" == "custom" ]]; then
    echo "EMBEDDING_BASE_URL=${EMBEDDING_BASE_URL}" >> "$ENV_FILE"
    echo "EMBEDDING_API_KEY=${EMBEDDING_API_KEY}" >> "$ENV_FILE"
  fi
  [[ -n "$EMBEDDING_MODEL"      ]] && echo "EMBEDDING_MODEL=${EMBEDDING_MODEL}" >> "$ENV_FILE"
  [[ -n "$EMBEDDING_DIMENSIONS" ]] && echo "EMBEDDING_DIMENSIONS=${EMBEDDING_DIMENSIONS}" >> "$ENV_FILE"
  echo "# EMBEDDING_SUPPORTS_DIMS_PARAM=true" >> "$ENV_FILE"
else
  cat >> "$ENV_FILE" <<EOF

# --- Embedding (disabled) --------------------------------------------
# EMBEDDING_PROVIDER=openai
# OPENAI_API_KEY=
# EMBEDDING_MODEL=text-embedding-3-small
# EMBEDDING_DIMENSIONS=1536
# EMBEDDING_SUPPORTS_DIMS_PARAM=true
# EMBEDDING_BASE_URL=
EOF
fi

cat >> "$ENV_FILE" <<EOF

# --- LLM Provider Chain ----------------------------------------------
EOF

if [[ -n "$LLM_PRIMARY" ]]; then
  echo "LLM_PRIMARY=${LLM_PRIMARY}" >> "$ENV_FILE"
else
  echo "# LLM_PRIMARY=" >> "$ENV_FILE"
fi

if [[ -n "$LLM_FALLBACKS" ]]; then
  echo "LLM_FALLBACKS=${LLM_FALLBACKS}" >> "$ENV_FILE"
else
  echo "# LLM_FALLBACKS=" >> "$ENV_FILE"
fi

cat >> "$ENV_FILE" <<EOF

# --- NLI (Natural Language Inference) --------------------------------
# NLI_SERVICE_URL=
# NLI_TIMEOUT_MS=5000

# --- Consolidation ---------------------------------------------------
# CONSOLIDATE_INTERVAL_MS=21600000
EOF

success ".env written."
chmod 600 "$ENV_FILE"

echo

# npm install
if ask_yn "Run npm install?" "y"; then
  info "Running npm install..."
  npm install
  success "Packages installed."
fi

echo

# DB schema
if ask_yn "Apply PostgreSQL schema?" "y"; then
  echo "  1) Fresh install (memory-schema.sql)"
  echo "  2) Upgrade existing (run all migration-*.sql files)"
  SCHEMA_CHOICE=$(ask "Choice" "1")

  export DATABASE_URL

  if [[ "$SCHEMA_CHOICE" == "1" ]]; then
    info "Applying schema..."
    psql "$DATABASE_URL" -f lib/memory/memory-schema.sql
    success "Schema applied."
  else
    info "Running migrations..."
    # migration-*.sql 파일을 번호 순으로 자동 탐지하여 실행한다.
    # migration-034-v2.16.0-bundle.sql 포함, IF NOT EXISTS 가드로 멱등 실행 가능.
    # 수백만 건 이상의 대규모 운영 DB에서는 migration-034-v2.16.0-bundle의 CREATE UNIQUE INDEX가
    # 테이블 잠금을 발생시킬 수 있다. 이 경우 실행 전에 docs/INSTALL.md의
    # "migration-034-v2.16.0 CONCURRENTLY 옵션" 섹션을 참조하여 수동 실행을 먼저 완료한다.
    for f in lib/memory/migration-*.sql; do
      if [[ -f "$f" ]]; then
        psql "$DATABASE_URL" -f "$f" && success "$(basename "$f") done." || warn "$(basename "$f") failed (may already be applied)."
      fi
    done
    # 마이그레이션 완료 후 서버 재시작이 필요하다 (새 컬럼/인덱스 반영).
  fi

  if [[ -n "$EMBEDDING_PROVIDER" ]]; then
    _run_migration_007=false
    if [[ "${EMBEDDING_DIMENSIONS:-0}" -gt 2000 ]]; then
      warn "Dimensions ${EMBEDDING_DIMENSIONS} > 2000: fragments + morpheme_dict 두 테이블을 동시 처리합니다 (v2.9.0+). post-migrate-flexible-embedding-dims required."
      _run_migration_007=true
    elif [[ "$EMBEDDING_PROVIDER" == "transformers" ]]; then
      warn "transformers provider: fragments + morpheme_dict 두 테이블을 동시 처리합니다 (v2.9.0+). post-migrate-flexible-embedding-dims recommended."
      _run_migration_007=true
    fi

    if [[ "$_run_migration_007" == "true" ]]; then
      if ask_yn "Run post-migrate-flexible-embedding-dims (embedding dimension update)?" "y"; then
        EMBEDDING_DIMENSIONS="$EMBEDDING_DIMENSIONS" DATABASE_URL="$DATABASE_URL" \
          node scripts/post-migrate-flexible-embedding-dims.js
        success "post-migrate-flexible-embedding-dims done."
      fi
    fi
  fi

  if [[ -n "$EMBEDDING_PROVIDER" ]]; then
    if ask_yn "Run L2 normalization on existing vectors? (one-time)" "y"; then
      node scripts/normalize-vectors.js
      success "L2 normalization done."

      if ask_yn "Verify embedding dimension consistency (fragments + morpheme_dict)?" "y"; then
        DATABASE_URL="$DATABASE_URL" EMBEDDING_DIMENSIONS="$EMBEDDING_DIMENSIONS" \
          node -e "import('./scripts/check-embedding-consistency.js').then(async ({ checkEmbeddingConsistency }) => { const ok = await checkEmbeddingConsistency(); process.exit(ok ? 0 : 1); });" \
          && success "Consistency check passed." \
          || warn "Consistency check failed. See above for details."
      fi
    fi
  fi
fi

echo
echo -e "${GREEN}${BOLD}------------------------------------------${RESET}"
echo -e "${GREEN}${BOLD}  Setup complete. Start: node server.js${RESET}"
echo -e "${GREEN}${BOLD}------------------------------------------${RESET}"
echo
echo "Next steps:"
echo "  - Test health:    curl http://localhost:${PORT}/health"
echo "  - Integration:    npm run test:integration:llm  (requires E2E_LLM_* env vars)"
echo "  - Documentation:  docs/INSTALL.md, docs/embedding-local.md, SKILL.md"
echo
