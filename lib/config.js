/**
 * 설정 상수
 *
 * 작성자: 최진호
 * 작성일: 2026-01-30
 * 수정일: 2026-04-18
 */

import "dotenv/config";

/**
 * 환경 변수 문자열을 쉼표 구분 배열로 파싱한다.
 * 빈 문자열, undefined, null 입력은 빈 배열을 반환한다.
 *
 * @param {string|undefined} raw  - 환경 변수 원시값
 * @returns {string[]}
 */
const parseEnvList = (raw) =>
  String(raw || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

/** transformers.js provider 지원 모델별 임베딩 차원 수 */
const _TRANSFORMERS_MODEL_DIMS = {
  "Xenova/multilingual-e5-small":                   384,
  "Xenova/bge-m3":                                 1024,
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2":   384,
  "Xenova/all-MiniLM-L6-v2":                        384,
};

export const PORT               = Number(process.env.PORT || 57332);

/**
 * 지원하는 MCP 프로토콜 버전 목록 (최신순)
 * - 2024-11-05: 초기 릴리스 (인증 모델 미포함)
 * - 2025-03-26: OAuth 2.1 인증, Streamable HTTP 도입
 * - 2025-06-18: 구조화된 도구 출력, 서버 주도 상호작용
 * - 2025-11-25: Tasks 추상화, 장기 실행 작업 지원
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
];

export const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const ACCESS_KEY         = process.env.MEMENTO_ACCESS_KEY || "";

/**
 * 빈 ACCESS_KEY의 fail-closed 동작을 우회하는 명시적 opt-in 플래그.
 * MEMENTO_AUTH_DISABLED=true 로만 활성화 가능.
 * 활성화 시 서버는 모든 요청을 master 권한으로 처리한다 (개발/테스트 전용).
 */
export const AUTH_DISABLED      = process.env.MEMENTO_AUTH_DISABLED === "true";
export const SESSION_TTL_MS            = Number(process.env.SESSION_TTL_MINUTES || 43200) * 60 * 1000;
export const OAUTH_TOKEN_TTL_SECONDS   = Number(process.env.SESSION_TTL_MINUTES || 43200) * 60;
export const OAUTH_REFRESH_TTL_SECONDS = OAUTH_TOKEN_TTL_SECONDS * 2;
export const LOG_DIR            = process.env.LOG_DIR || "./logs";

export const ALLOWED_ORIGINS    = new Set(parseEnvList(process.env.ALLOWED_ORIGINS));

export const ADMIN_ALLOWED_ORIGINS = new Set(parseEnvList(process.env.ADMIN_ALLOWED_ORIGINS));

/** Redis 설정 */
export const REDIS_ENABLED      = process.env.REDIS_ENABLED === "true" || false;
export const REDIS_SENTINEL_ENABLED = process.env.REDIS_SENTINEL_ENABLED === "true" || false;
export const REDIS_HOST         = process.env.REDIS_HOST || "localhost";
export const REDIS_PORT         = Number(process.env.REDIS_PORT || 6379);
export const REDIS_PASSWORD     = process.env.REDIS_PASSWORD || undefined;
export const REDIS_DB           = Number(process.env.REDIS_DB || 0);

/** Redis Sentinel 설정 */
export const REDIS_MASTER_NAME  = process.env.REDIS_MASTER_NAME || "mymaster";
export const REDIS_SENTINELS    = process.env.REDIS_SENTINELS
  ? process.env.REDIS_SENTINELS.split(",").map(s => {
    const [host, port] = s.trim().split(":");
    return { host, port: Number(port || 26379) };
  })
  : [
    { host: "localhost", port: 26379 },
    { host: "localhost", port: 26380 },
    { host: "localhost", port: 26381 }
  ];

/** 캐싱 설정 */
export const CACHE_ENABLED      = process.env.CACHE_ENABLED === "true" || REDIS_ENABLED;
export const CACHE_DB_TTL       = Number(process.env.CACHE_DB_TTL || 300);        // 5분
export const CACHE_SESSION_TTL  = Number(process.env.CACHE_SESSION_TTL || SESSION_TTL_MS / 1000); // 세션과 동일

/** 임베딩 Provider 설정
 *
 * EMBEDDING_PROVIDER 지원값:
 *   openai        — OpenAI API (기본값). OPENAI_API_KEY 또는 EMBEDDING_API_KEY 필요.
 *   gemini        — Google Gemini. GEMINI_API_KEY 또는 EMBEDDING_API_KEY 필요.
 *                   OpenAI 호환 엔드포인트 사용 (별도 SDK 불필요).
 *   ollama        — 로컬 Ollama 서버. API 키 불필요.
 *   localai       — 로컬 LocalAI 서버. API 키 불필요.
 *   cloudflare    — Cloudflare Workers AI. CF_ACCOUNT_ID + CF_API_TOKEN 필요.
 *                   OpenAI 호환 엔드포인트 사용 (별도 SDK 불필요).
 *   transformers  — @huggingface/transformers 로컬 실행. API 키 없이 동작.
 *                   기본 모델: Xenova/multilingual-e5-small (384차원).
 *                   API 키와 상호 배타 — 동시 설정 시 시작 실패.
 *   custom        — EMBEDDING_BASE_URL, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS 직접 지정.
 */
export const EMBEDDING_PROVIDER   = (process.env.EMBEDDING_PROVIDER || "openai").toLowerCase();

/** Cloudflare Workers AI 계정 설정 (cloudflare provider 전용) */
const _CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || "";

/** Provider별 기본값 */
const _PROVIDER_DEFAULTS = {
  openai:       { model: "text-embedding-3-small",           dims: 1536, baseUrl: "",                                                        supportsDimensionsParam: true  },
  gemini:       { model: "gemini-embedding-001",              dims: 3072, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", supportsDimensionsParam: false },
  ollama:       { model: "nomic-embed-text",                  dims: 768,  baseUrl: "http://localhost:11434/v1",                               supportsDimensionsParam: false },
  localai:      { model: "text-embedding-ada-002",            dims: 1536, baseUrl: "http://localhost:8080/v1",                                supportsDimensionsParam: false },
  cloudflare:   { model: "@cf/baai/bge-small-en-v1.5",        dims: 384,  baseUrl: _CF_ACCOUNT_ID ? `https://api.cloudflare.com/client/v4/accounts/${_CF_ACCOUNT_ID}/ai/v1` : "", supportsDimensionsParam: false },
  transformers: { model: "Xenova/multilingual-e5-small",      dims: 384,  baseUrl: "",                                                        supportsDimensionsParam: false },
  custom:       { model: "",                                   dims: 1536, baseUrl: "",                                                        supportsDimensionsParam: false },
};
const _defaults = _PROVIDER_DEFAULTS[EMBEDDING_PROVIDER] ?? _PROVIDER_DEFAULTS.custom;

/** 임베딩 API 키 (EMBEDDING_API_KEY 우선, GEMINI_API_KEY, CF_API_TOKEN, OPENAI_API_KEY 순 폴백) */
export const OPENAI_API_KEY              = process.env.OPENAI_API_KEY || "";
export const EMBEDDING_API_KEY           = process.env.EMBEDDING_API_KEY
                                        || process.env.GEMINI_API_KEY
                                        || process.env.CF_API_TOKEN
                                        || process.env.CLOUDFLARE_API_TOKEN
                                        || process.env.OPENAI_API_KEY
                                        || "";

/** Cloudflare Workers AI 계정 ID / API 토큰 */
export const CF_ACCOUNT_ID               = _CF_ACCOUNT_ID;
export const CF_API_TOKEN                = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "";
/** OpenAI 호환 엔드포인트 URL (미설정 시 provider 기본값 사용) */
export const EMBEDDING_BASE_URL          = process.env.EMBEDDING_BASE_URL  || _defaults.baseUrl;
/** 임베딩 모델명 (미설정 시 provider 기본값 사용) */
export const EMBEDDING_MODEL             = process.env.EMBEDDING_MODEL     || _defaults.model;

/**
 * 임베딩 벡터 차원 수.
 * transformers provider + 알려진 모델이면 EMBEDDING_DIMENSIONS env 미지정 시 자동 매핑.
 */
const _resolvedDims = (() => {
  if (process.env.EMBEDDING_DIMENSIONS) return Number(process.env.EMBEDDING_DIMENSIONS);
  if (EMBEDDING_PROVIDER === "transformers") {
    const resolvedModel = process.env.EMBEDDING_MODEL || _defaults.model;
    return _TRANSFORMERS_MODEL_DIMS[resolvedModel] ?? _defaults.dims;
  }
  return _defaults.dims;
})();
export const EMBEDDING_DIMENSIONS        = _resolvedDims;

/** dimensions 파라미터 지원 여부 (provider 자동 결정, EMBEDDING_SUPPORTS_DIMS_PARAM=true/false로 override) */
export const EMBEDDING_SUPPORTS_DIMS_PARAM = process.env.EMBEDDING_SUPPORTS_DIMS_PARAM !== undefined
  ? process.env.EMBEDDING_SUPPORTS_DIMS_PARAM === "true"
  : _defaults.supportsDimensionsParam;

/** transformers provider + API 키 동시 설정 시 데이터 혼합 방지 — 즉시 종료 */
if (EMBEDDING_PROVIDER === "transformers" && EMBEDDING_API_KEY) {
  throw new Error(
    "EMBEDDING_PROVIDER=transformers이면 API 키는 설정하지 마십시오. 데이터 혼합 방지를 위해 로컬과 API는 동시에 사용할 수 없습니다."
  );
}

/** 임베딩 기능 활성화 여부 */
export const EMBEDDING_ENABLED           = EMBEDDING_PROVIDER === "transformers"
  ? true
  : !!(EMBEDDING_API_KEY || EMBEDDING_BASE_URL);

/** 임베딩 외부 호출 하드닝 (공개 서비스 안정성) */
export const EMBEDDING_TIMEOUT_MS  = Number(process.env.EMBEDDING_TIMEOUT_MS  || 8000);
/** per-call AbortSignal이 전체 절대 데드라인이므로 재시도 기본 0 (타임아웃 중첩 무력화 방지) */
export const EMBEDDING_MAX_RETRIES = Number(process.env.EMBEDDING_MAX_RETRIES || 0);
export const EMBEDDING_CONCURRENCY = Number(process.env.EMBEDDING_CONCURRENCY || 6);
export const EMBEDDING_SEM_WAIT_MS = Number(process.env.EMBEDDING_SEM_WAIT_MS || 3000);

/** LLM Provider 설정 (v2.8.0)
 *
 * LLM_PRIMARY   — 주 provider 이름 (기본 "gemini-cli")
 * LLM_FALLBACKS — JSON 배열. 각 원소는 {provider, model, apiKey?, baseUrl?, timeoutMs?, extraHeaders?, ...providerOptions}
 *
 * 예시:
 *   LLM_PRIMARY=gemini-cli
 *   LLM_FALLBACKS='[{"provider":"anthropic","apiKey":"sk-ant-...","model":"claude-opus-4-6"}]'
 *
 * 개별 provider별 env var (ANTHROPIC_API_KEY, OPENAI_MODEL 등)는 선언하지 않는다.
 * 모든 provider 설정은 LLM_FALLBACKS JSON에 포함한다.
 */
export const LLM_PRIMARY = (process.env.LLM_PRIMARY || "gemini-cli").toLowerCase();

function parseLlmFallbacks() {
  const raw = process.env.LLM_FALLBACKS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn("[config] LLM_FALLBACKS must be a JSON array, ignoring");
      return [];
    }
    return parsed.map(item => {
      const {
        provider,
        apiKey,
        model,
        baseUrl,
        timeoutMs,
        extraHeaders,
        ...providerOptions
      } = item;
      return {
        provider    : String(provider || "").toLowerCase(),
        apiKey      : apiKey       ?? null,
        model       : model        ?? null,
        baseUrl     : baseUrl      ?? null,
        timeoutMs   : timeoutMs    ?? null,
        extraHeaders: extraHeaders ?? null,
        ...providerOptions
      };
    }).filter(item => item.provider);
  } catch (err) {
    console.warn(`[config] LLM_FALLBACKS parse failed: ${err.message}, using empty chain`);
    return [];
  }
}

export const LLM_FALLBACKS = parseLlmFallbacks();

/** LLM Provider 동시성 제어 (v2.8.1+)
 *
 * LLM_CONCURRENCY_ENABLED  — false이면 세마포어 우회 (기본 true)
 * LLM_CONCURRENCY_WAIT_MS  — 슬롯 대기 타임아웃 ms (기본 30000)
 * LLM_CONCURRENCY          — JSON: chainKey 또는 provider 이름 기준 슬롯 한도
 */
export const LLM_CONCURRENCY_ENABLED = process.env.LLM_CONCURRENCY_ENABLED !== "false";
export const LLM_CONCURRENCY_WAIT_MS = Number(process.env.LLM_CONCURRENCY_WAIT_MS || 30000);

const DEFAULT_LLM_CONCURRENCY = {
  "ollama"                                                                  : 16,
  "openai|https://token-plan-sgp.xiaomimimo.com/v1|mimo-v2-pro"            : 8,
  "gemini-cli"                                                              : 1,
  "copilot-cli"                                                             : 1,
  "codex-cli"                                                               : 1,
  "qwen-cli"                                                                : 1,
  "opencode-cli"                                                            : 1
};

function parseLlmConcurrency() {
  const raw = process.env.LLM_CONCURRENCY;
  if (!raw) return DEFAULT_LLM_CONCURRENCY;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn("[config] LLM_CONCURRENCY must be a JSON object, using defaults");
      return DEFAULT_LLM_CONCURRENCY;
    }
    return { ...DEFAULT_LLM_CONCURRENCY, ...parsed };
  } catch (err) {
    console.warn(`[config] LLM_CONCURRENCY parse failed: ${err.message}, using defaults`);
    return DEFAULT_LLM_CONCURRENCY;
  }
}

export const LLM_CONCURRENCY_LIMITS = parseLlmConcurrency();

/**
 * chainKey 또는 providerName으로 동시 슬롯 한도를 반환한다.
 *
 * @param {string} chainKey    - "provider|baseUrl|model" 형식
 * @param {string} providerName - provider 이름만 (fallback 조회용)
 * @returns {number}
 */
export function getConcurrencyLimit(chainKey, providerName) {
  if (Object.prototype.hasOwnProperty.call(LLM_CONCURRENCY_LIMITS, chainKey)) {
    return LLM_CONCURRENCY_LIMITS[chainKey];
  }
  if (Object.prototype.hasOwnProperty.call(LLM_CONCURRENCY_LIMITS, providerName)) {
    return LLM_CONCURRENCY_LIMITS[providerName];
  }
  return 10;
}

/** Circuit breaker 튜닝 */
export const LLM_CB_FAILURE_THRESHOLD = Number(process.env.LLM_CB_FAILURE_THRESHOLD || 5);
export const LLM_CB_OPEN_DURATION_MS  = Number(process.env.LLM_CB_OPEN_DURATION_MS  || 60000);
export const LLM_CB_FAILURE_WINDOW_MS = Number(process.env.LLM_CB_FAILURE_WINDOW_MS || 60000);

/** LLM timeout 튜닝 */
const LLM_PROVIDER_TIMEOUT_MS_RAW = process.env.LLM_PROVIDER_TIMEOUT_MS;
export const LLM_PROVIDER_TIMEOUT_CONFIGURED = LLM_PROVIDER_TIMEOUT_MS_RAW !== undefined && LLM_PROVIDER_TIMEOUT_MS_RAW !== "";
export const LLM_PROVIDER_TIMEOUT_MS         = Number(LLM_PROVIDER_TIMEOUT_MS_RAW || 60_000);
export const LLM_CHAIN_TIMEOUT_MS            = Number(process.env.LLM_CHAIN_TIMEOUT_MS || 0);

/** Token usage cap (enforcement) */
export const LLM_TOKEN_BUDGET_INPUT      = process.env.LLM_TOKEN_BUDGET_INPUT  ? Number(process.env.LLM_TOKEN_BUDGET_INPUT)  : null;
export const LLM_TOKEN_BUDGET_OUTPUT     = process.env.LLM_TOKEN_BUDGET_OUTPUT ? Number(process.env.LLM_TOKEN_BUDGET_OUTPUT) : null;
export const LLM_TOKEN_BUDGET_WINDOW_SEC = Number(process.env.LLM_TOKEN_BUDGET_WINDOW_SEC || 86400);

/** NLI 서비스 설정 (미설정 시 in-process ONNX 모델 로드) */
export const NLI_SERVICE_URL    = process.env.NLI_SERVICE_URL || "";
export const NLI_TIMEOUT_MS     = Number(process.env.NLI_TIMEOUT_MS || 5000);

/**
 * Case event 검증 결과(verification_passed/failed)를 증거 파편 importance에 역전파할지 여부.
 * 기본 off. true로 설정하면 CaseRewardBackprop.backprop이 실제 UPDATE를 수행하고,
 * false면 호출 자체가 no-op으로 처리되어 DB·메트릭 영향이 없다.
 */
export const CASE_BACKPROP_ENABLED = process.env.MEMENTO_CASE_BACKPROP_ENABLED === "true";

/** Reranker 서비스 설정 (미설정 시 in-process ONNX cross-encoder 로드)
 *
 * RERANKER_MODEL 지원값:
 *   minilm  — Xenova/ms-marco-MiniLM-L-6-v2 (기본값, ~80MB, 영어 전용)
 *   bge-m3  — onnx-community/bge-reranker-v2-m3-ONNX (q4, ~280MB, 다국어)
 */
export const RERANKER_URL        = process.env.RERANKER_URL || "";
export const RERANKER_TIMEOUT_MS = Number(process.env.RERANKER_TIMEOUT_MS || 5000);
export const RERANKER_MODEL      = (process.env.RERANKER_MODEL || "minilm").toLowerCase();
/** external 리랭커 3연속 실패 시 정책: "skip"(쿨다운 진입·원점수 유지, 기본) | "inprocess"(ONNX 전환, opt-in) */
export const RERANKER_EXTERNAL_FALLBACK    = (process.env.RERANKER_EXTERNAL_FALLBACK || "skip").toLowerCase();
/** skip 정책에서 쿨다운 유지 시간(ms). 이 창 동안 external 호출을 생략하고 원점수를 반환한다. */
export const RERANKER_EXTERNAL_COOLDOWN_MS = Number(process.env.RERANKER_EXTERNAL_COOLDOWN_MS || 60000);

/** Fragment 쿼터 기본값 */
export const FRAGMENT_DEFAULT_LIMIT = process.env.FRAGMENT_DEFAULT_LIMIT
  ? Number(process.env.FRAGMENT_DEFAULT_LIMIT)
  : 5000;

/** API 키 생성 기본값 */
export const DEFAULT_DAILY_LIMIT    = Number(process.env.DEFAULT_DAILY_LIMIT || 10000);
export const DEFAULT_FRAGMENT_LIMIT = process.env.DEFAULT_FRAGMENT_LIMIT
  ? Number(process.env.DEFAULT_FRAGMENT_LIMIT) : null;
export const DEFAULT_PERMISSIONS    = parseEnvList(process.env.DEFAULT_PERMISSIONS || "read,write");

/** 데이터베이스 설정 (PostgreSQL) - POSTGRES_* 우선, DB_* 호환 */
export const DB_HOST            = process.env.POSTGRES_HOST || process.env.DB_HOST || "";
export const DB_PORT            = Number(process.env.POSTGRES_PORT || process.env.DB_PORT || 5432);
export const DB_NAME            = process.env.POSTGRES_DB || process.env.DB_NAME || "";
export const DB_USER            = process.env.POSTGRES_USER || process.env.DB_USER || "";
export const DB_PASSWORD        = process.env.POSTGRES_PASSWORD || process.env.DB_PASSWORD || "";
export const DB_MAX_CONNECTIONS = Number(process.env.DB_MAX_CONNECTIONS || 20);
export const DB_IDLE_TIMEOUT_MS = Number(process.env.DB_IDLE_TIMEOUT_MS || 30000);
export const DB_CONN_TIMEOUT_MS = Number(process.env.DB_CONN_TIMEOUT_MS || 10000);
export const DB_QUERY_TIMEOUT   = Number(process.env.DB_QUERY_TIMEOUT || 30000);

/** pgvector 익스텐션이 설치된 스키마 (public이 아닌 경우 지정, 미설정 시 서버 시작 시 자동 감지) */
export let PGVECTOR_SCHEMA      = process.env.PGVECTOR_SCHEMA || "";

/**
 * SET search_path 문자열 생성
 * @param {string} schema - 주 스키마 (예: "agent_memory")
 * @returns {string} "SET search_path TO agent_memory, <pgvector_schema>, public"
 */
export function buildSearchPath(schema) {
  const parts = [schema];
  if (PGVECTOR_SCHEMA) parts.push(PGVECTOR_SCHEMA);
  parts.push("public");
  return `SET search_path TO ${parts.join(", ")}`;
}

/**
 * pgvector 익스텐션 스키마 자동 감지
 *
 * PGVECTOR_SCHEMA 환경변수가 미설정이고 pgvector가 public이 아닌 스키마에 설치된 경우,
 * pg_extension 카탈로그에서 실제 스키마를 감지하여 PGVECTOR_SCHEMA를 갱신한다.
 * 서버 시작 시 1회 호출.
 *
 * @param {import("pg").Pool} pool - PostgreSQL 연결 풀
 */
export async function detectPgvectorSchema(pool) {
  if (PGVECTOR_SCHEMA) return;   // 명시 설정 있으면 스킵

  try {
    const result = await pool.query(
      `SELECT n.nspname
       FROM pg_extension e
       JOIN pg_namespace n ON e.extnamespace = n.oid
       WHERE e.extname = 'vector'`
    );
    if (result.rows.length > 0) {
      const detected = result.rows[0].nspname;
      if (detected && detected !== "public") {
        PGVECTOR_SCHEMA = detected;
      }
    }
  } catch {
    // pgvector 미설치 또는 쿼리 실패 시 무시 — 빈 문자열 유지
  }
}

/** Rate Limiting */
export const RATE_LIMIT_WINDOW_MS    = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
export const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 120);
export const RATE_LIMIT_PER_IP       = Number(process.env.RATE_LIMIT_PER_IP  || 30);
export const RATE_LIMIT_PER_KEY      = Number(process.env.RATE_LIMIT_PER_KEY || 100);

/**
 * 신뢰 가능한 리버스 프록시 hop 수.
 * 미설정 시(undefined) X-Forwarded-For 첫 항목을 사용 — 기존 동작 보존.
 * 0 설정 시 XFF 무시. N≥1 설정 시 XFF 체인의 우측에서 N번째 항목 채택.
 */
export const TRUST_PROXY_HOPS = process.env.TRUST_PROXY_HOPS !== undefined
  ? Number(process.env.TRUST_PROXY_HOPS)
  : undefined;

const DEFAULT_TRUSTED_ORIGINS = [
  "https://claude.ai",
  "https://chatgpt.com",
  "https://platform.openai.com",
  "https://copilot.microsoft.com",
  "https://gemini.google.com",
];

export const OAUTH_TRUSTED_ORIGINS = [
  ...DEFAULT_TRUSTED_ORIGINS,
  ...parseEnvList(process.env.OAUTH_TRUSTED_ORIGINS),
];

/** 하위 호환: 정확한 URI 허용 목록 (기존 환경변수 지원) */
export const OAUTH_ALLOWED_REDIRECT_URIS = parseEnvList(process.env.OAUTH_ALLOWED_REDIRECT_URIS);

/** 업데이트 체크 설정 */
export const UPDATE_CHECK_DISABLED       = process.env.UPDATE_CHECK_DISABLED === "true";
export const UPDATE_CHECK_INTERVAL_HOURS = Number(process.env.UPDATE_CHECK_INTERVAL_HOURS || 24);

/** OpenAPI 스펙 엔드포인트 활성화 (GET /openapi.json) */
export const ENABLE_OPENAPI = process.env.ENABLE_OPENAPI === "true";

/**
 * non-API-key OAuth 클라이언트 거부 (기본 true)
 *
 * true(기본): is_api_key=false OAuth 토큰으로 인증 시 거부 → keyId=null 세션 방지
 * false: 기존 동작 유지 (하위 호환 / 테스트 환경)
 */
export const REJECT_NONAPIKEY_OAUTH  = process.env.MCP_REJECT_NONAPIKEY_OAUTH !== "false";

/**
 * OAuth Dynamic Client Registration 자동 등록 허용 (기본 false)
 *
 * false(기본): /authorize에서 미등록 client_id의 자동 등록 차단 → invalid_client 반환
 * true: 기존 자동 등록 허용 (개발/테스트 환경 전용)
 */
export const ALLOW_AUTO_DCR_REGISTER = process.env.MCP_ALLOW_AUTO_DCR_REGISTER === "true";

/** SSE 연결 설정 */
export const SSE_HEARTBEAT_INTERVAL_MS   = Number(process.env.SSE_HEARTBEAT_INTERVAL_MS || 25000);
export const SSE_MAX_HEARTBEAT_FAILURES  = Number(process.env.SSE_MAX_HEARTBEAT_FAILURES || 10);
export const SSE_RETRY_MS                = Number(process.env.SSE_RETRY_MS || 5000);

/** 장기 세션 idle reflect 설정 */
export const IDLE_REFLECT_HOURS          = Number(process.env.MCP_IDLE_REFLECT_HOURS || 24);

/**
 * Origin 헤더 엄격 검증 (DNS rebinding 방어)
 *
 * false(기본): Origin 헤더 검증 없이 통과 — 기존 동작 유지
 * true: CORS 허용 목록에 없는 Origin에서 온 요청을 403으로 거부 (opt-in)
 */
export const STRICT_ORIGIN               = process.env.MCP_STRICT_ORIGIN === "true";

/**
 * 분할(splitLongFragments) 전용 LLM 체인 설정을 해석한다.
 * 전역 LLM_PRIMARY/LLM_FALLBACKS와 독립적으로 provider를 선택할 수 있게 한다.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {Array<object>|null} 엔트리 배열, 또는 미설정/파싱실패 시 null
 */
export function resolveSplitChainConfig(env = process.env) {
  const primary = env.MEMENTO_SPLIT_LLM_PRIMARY;
  const rawFb   = env.MEMENTO_SPLIT_LLM_FALLBACKS;
  if (!primary && !rawFb) return null;

  let fallbacks = [];
  if (rawFb) {
    try {
      const parsed = JSON.parse(rawFb);
      if (!Array.isArray(parsed)) return null;
      fallbacks = parsed;
    } catch {
      return null;
    }
  }

  const entries = [];
  if (primary) entries.push({ provider: String(primary).toLowerCase() });
  for (const fb of fallbacks) {
    if (typeof fb === "string") entries.push({ provider: fb.toLowerCase() });
    else if (fb && typeof fb === "object" && fb.provider) entries.push(fb);
  }
  return entries.length > 0 ? entries : null;
}
