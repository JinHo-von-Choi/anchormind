/**
 * 설정 상수
 *
 * 작성자: 최진호
 * 작성일: 2026-01-30
 * 수정일: 2026-10-03
 */

import "dotenv/config";
import { classifyBool, classifyEnum } from "./env-parse.js";

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

/**
 * 환경 변수 값 검사에서 나온 문제 목록. 기동 시 getConfigIssues()로 한 번에 기록한다.
 * 항목: { name, value, problem, used, usedDefault }
 */
const CONFIG_ISSUES     = [];
const CONFIG_ISSUE_KEYS = new Set();

/**
 * 문제 하나를 기록한다. 같은 변수의 같은 문제는 한 번만 남기고, 값은 앞 32자만 남긴다.
 * 요청마다 읽는 변수도 목록이 늘지 않는다.
 */
function noteConfigIssue(name, raw, problem, used, usedDefault) {
  const key = `${name}:${problem}`;
  if (CONFIG_ISSUE_KEYS.has(key)) return;
  CONFIG_ISSUE_KEYS.add(key);
  CONFIG_ISSUES.push({ name, value: String(raw).slice(0, 32), problem, used, usedDefault });
}

/**
 * 숫자 환경 변수를 읽는다.
 *
 * - 미설정 또는 공백: def
 * - Number()로 유한수가 아님: def를 쓰고 not_a_number로 기록
 * - integer 요구인데 정수가 아님: 값을 그대로 쓰고 not_integer로 기록
 * - min/max 밖: 값을 그대로 쓰고 below_min/above_max로 기록
 * - fallback이 true이면 정수 아님과 범위 밖에서도 def를 쓰고 같은 문제를 기록한다
 *
 * @param {string} name
 * @param {number|null} def
 * @param {{ min?: number, max?: number, integer: boolean, fallback?: boolean }} options
 * @returns {number|null}
 */
function parseEnvNumber(name, def, { min, max, integer, fallback = false }) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    noteConfigIssue(name, raw, "not_a_number", def, true);
    return def;
  }
  let problem = null;
  if (integer && !Number.isInteger(value))   problem = "not_integer";
  else if (min !== undefined && value < min) problem = "below_min";
  else if (max !== undefined && value > max) problem = "above_max";
  if (problem === null) return value;
  const used = fallback ? def : value;
  noteConfigIssue(name, raw, problem, used, fallback);
  return used;
}

/**
 * 정수 환경 변수. 규칙은 parseEnvNumber를 따른다.
 *
 * @param {string} name
 * @param {number|null} def
 * @param {{ min?: number, max?: number, fallback?: boolean }} [bounds]
 * @returns {number|null}
 */
export function envInt(name, def, { min, max, fallback } = {}) {
  return parseEnvNumber(name, def, { min, max, fallback, integer: true });
}

/**
 * 실수 환경 변수. 규칙은 parseEnvNumber를 따른다.
 *
 * @param {string} name
 * @param {number|null} def
 * @param {{ min?: number, max?: number, fallback?: boolean }} [bounds]
 * @returns {number|null}
 */
export function envFloat(name, def, { min, max, fallback } = {}) {
  return parseEnvNumber(name, def, { min, max, fallback, integer: false });
}

/**
 * boolean 환경 변수. "true", "false"만 값으로 본다.
 * 미설정 또는 공백은 def, 그 밖의 값은 def를 쓰고 not_boolean으로 기록한다.
 *
 * @param {string} name
 * @param {boolean} def
 * @returns {boolean}
 */
export function envBool(name, def) {
  const raw    = process.env[name];
  const parsed = classifyBool(raw);
  if (parsed.status === "valid") return parsed.value;
  if (parsed.status === "invalid") noteConfigIssue(name, raw, "not_boolean", def, true);
  return def;
}

/**
 * 열거형 환경 변수. allowed 밖의 값은 def를 쓰고 not_in_enum으로 기록한다.
 * emptyOnly이면 빈 문자열만 미설정으로 보고 공백만 있는 값도 allowed 밖의 값으로 기록한다.
 *
 * @param {string} name
 * @param {readonly string[]} allowed
 * @param {string} def
 * @param {{ emptyOnly?: boolean }} [options]
 * @returns {string}
 */
export function envEnum(name, allowed, def, { emptyOnly = false } = {}) {
  const raw    = process.env[name];
  const parsed = classifyEnum(raw, allowed, { emptyOnly });
  if (parsed.status === "valid") return parsed.value;
  if (parsed.status === "invalid") noteConfigIssue(name, raw, "not_in_enum", def, true);
  return def;
}

/**
 * 지금까지 기록된 환경 변수 문제의 사본.
 *
 * @returns {Array<{ name: string, value: string, problem: string, used: unknown, usedDefault: boolean }>}
 */
export function getConfigIssues() {
  return CONFIG_ISSUES.slice();
}

/** transformers.js provider 지원 모델별 임베딩 차원 수 */
const _TRANSFORMERS_MODEL_DIMS = {
  "Xenova/multilingual-e5-small":                   384,
  "Xenova/bge-m3":                                 1024,
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2":   384,
  "Xenova/all-MiniLM-L6-v2":                        384,
};

export const PORT               = envInt("PORT", 57332, { min: 0, max: 65535 });

export { SUPPORTED_PROTOCOL_VERSIONS, DEFAULT_PROTOCOL_VERSION } from "./protocol-versions.js";

export const ACCESS_KEY         = process.env.MEMENTO_ACCESS_KEY || "";

/**
 * 빈 ACCESS_KEY의 fail-closed 동작을 우회하는 명시적 opt-in 플래그.
 * MEMENTO_AUTH_DISABLED=true 로만 활성화 가능.
 * 활성화 시 서버는 모든 요청을 master 권한으로 처리한다 (개발/테스트 전용).
 */
export const AUTH_DISABLED      = process.env.MEMENTO_AUTH_DISABLED === "true";
/** agent identity binding 도입 전 legacy API key의 기존 agentId 주장을 임시 허용. */
export const ALLOW_LEGACY_UNBOUND_AGENT_SCOPE = process.env.MEMENTO_ALLOW_LEGACY_UNBOUND_AGENT_SCOPE !== "false";
const SESSION_TTL_MINUTES              = envInt("SESSION_TTL_MINUTES", 43200, { min: 1 });
export const SESSION_TTL_MS            = SESSION_TTL_MINUTES * 60 * 1000;
/** 접근 토큰 수명. OAUTH_ACCESS_TOKEN_TTL_SECONDS 미설정 시 세션 수명과 같다 */
const OAUTH_ACCESS_TOKEN_TTL_OVERRIDE  = envFloat("OAUTH_ACCESS_TOKEN_TTL_SECONDS", null, { min: 1, fallback: true });
export const OAUTH_TOKEN_TTL_SECONDS   = OAUTH_ACCESS_TOKEN_TTL_OVERRIDE !== null
  ? Math.floor(OAUTH_ACCESS_TOKEN_TTL_OVERRIDE)
  : SESSION_TTL_MINUTES * 60;
/** 갱신 토큰 수명. 세션 수명의 2배 */
export const OAUTH_REFRESH_TTL_SECONDS = SESSION_TTL_MINUTES * 60 * 2;

/**
 * 예약 agentId 처리 방식. 호출 시점의 MEMENTO_RESERVED_AGENT_IDS를 읽는다.
 * @returns {"warn"|"enforce"}
 */
export function reservedAgentIdsMode() {
  return envEnum("MEMENTO_RESERVED_AGENT_IDS", ["warn", "enforce"], "warn");
}
reservedAgentIdsMode();

/**
 * 의미 쓰기 관문(WriteGate) 스위치. 호출 시점의 MEMENTO_WRITE_GATE를 읽는다.
 * off이면 진입점별 기본 단계만 수행한다(WriteGate의 LEGACY_STEPS).
 * @returns {boolean}
 */
export function writeGateEnabled() {
  return envEnum("MEMENTO_WRITE_GATE", ["on", "off"], "on") === "on";
}
writeGateEnabled();

/**
 * 민감 정보 탐지 방식. 호출 시점의 MEMENTO_SENSITIVE_SCAN을 읽는다.
 * mask는 탐지한 값을 가리고(저신뢰 탐지는 경고 없이, 그 밖은 규칙 이름 경고) hard gate 키는 고신뢰 탐지에서 거부한다.
 * reject는 모든 키가 고신뢰 탐지에서 거부한다. off는 레거시 규칙만 본문에 적용한다.
 * MEMENTO_WRITE_GATE=off이면 이 값과 관계없이 off로 본다(sensitiveScanEffectiveMode).
 * @returns {"mask"|"reject"|"off"}
 */
export function sensitiveScanMode() {
  return envEnum("MEMENTO_SENSITIVE_SCAN", ["mask", "reject", "off"], "mask");
}
sensitiveScanMode();

/**
 * 저장 경로가 적용하는 민감 정보 탐지 방식. 관문 스위치가 off이면 MEMENTO_SENSITIVE_SCAN과 관계없이 off다.
 * @returns {"mask"|"reject"|"off"}
 */
export function sensitiveScanEffectiveMode() {
  return writeGateEnabled() ? sensitiveScanMode() : "off";
}

/**
 * Redis가 준비되지 않았을 때 scope=session 쓰기를 PostgreSQL 작업 기억 행으로 받을지 여부.
 * 호출 시점의 MEMENTO_WM_PG_FALLBACK을 읽는다.
 * @returns {boolean}
 */
export function wmPgFallbackEnabled() {
  return envEnum("MEMENTO_WM_PG_FALLBACK", ["on", "off"], "on") === "on";
}
wmPgFallbackEnabled();

/**
 * 키 하나가 가질 수 있는 작업 기억 행 수의 상한(대체 경로). 호출 시점의 MEMENTO_WM_FALLBACK_MAX_ROWS를
 * 읽으며 1 미만이거나 정수가 아니면 기본값이다.
 * @returns {number}
 */
export function wmFallbackMaxRows() {
  return envInt("MEMENTO_WM_FALLBACK_MAX_ROWS", 2000, { min: 1, fallback: true });
}
wmFallbackMaxRows();

/**
 * content_hash 중복 판정 범위. 호출 시점의 MEMENTO_DEDUP_SCOPE를 읽는다.
 * workspace는 키와 workspace 단위로, key는 키 단위로 같은 본문을 하나로 본다.
 * @returns {"workspace"|"key"}
 */
export function dedupScope() {
  return envEnum("MEMENTO_DEDUP_SCOPE", ["workspace", "key"], "workspace");
}
dedupScope();

/**
 * recall 순위 후 예산 선택 스위치. 호출 시점의 MEMENTO_RANK_BEFORE_BUDGET을 읽는다.
 * on이면 예산 절단 없는 검색 후보에 연결 파편을 합쳐 최종 점수를 매긴 뒤 토큰 예산 안에서 고르고,
 * off이면 검색 계층이 검색 순서대로 예산을 자른 뒤 연결 파편을 합친다.
 * @returns {boolean}
 */
export function rankBeforeBudgetEnabled() {
  return envEnum("MEMENTO_RANK_BEFORE_BUDGET", ["on", "off"], "on") === "on";
}
rankBeforeBudgetEnabled();

/**
 * 만료 파편 GC 처리량 스위치. 호출 시점의 MEMENTO_GC_THROUGHPUT을 읽는다.
 * on이면 주기당 삭제 상한(MEMENTO_GC_MAX_DELETE_PER_CYCLE)까지 청크를 반복하고, off이면
 * MEMORY_CONFIG.gc.maxDeletePerCycle(50)건을 한 번에 지운다.
 * @returns {boolean}
 */
export function gcThroughputEnabled() {
  return envEnum("MEMENTO_GC_THROUGHPUT", ["on", "off"], "on") === "on";
}
gcThroughputEnabled();

/** 만료 GC 주기당 삭제 상한의 기본값. 30일 일평균 파편 유입(약 1900건)의 두 배 이상이다. */
export const DEFAULT_GC_MAX_DELETE_PER_CYCLE = 4000;
/** 만료 GC 한 주기의 시간 예산 기본값(ms) */
export const DEFAULT_GC_TIME_BUDGET_MS       = 60000;

/**
 * 만료 GC 주기당 삭제 상한. 호출 시점의 MEMENTO_GC_MAX_DELETE_PER_CYCLE을 읽으며 100 이상
 * 100000 이하의 정수가 아니면 기본값이다.
 * @returns {number}
 */
export function gcMaxDeletePerCycle() {
  return envInt("MEMENTO_GC_MAX_DELETE_PER_CYCLE", DEFAULT_GC_MAX_DELETE_PER_CYCLE, { min: 100, max: 100000, fallback: true });
}
gcMaxDeletePerCycle();

/**
 * 만료 GC 한 주기의 시간 예산(ms). 호출 시점의 MEMENTO_GC_TIME_BUDGET_MS를 읽으며 1000 이상
 * 600000 이하의 정수가 아니면 기본값이다.
 * @returns {number}
 */
export function gcTimeBudgetMs() {
  return envInt("MEMENTO_GC_TIME_BUDGET_MS", DEFAULT_GC_TIME_BUDGET_MS, { min: 1000, max: 600000, fallback: true });
}
gcTimeBudgetMs();

/**
 * context 주입 줄 주석 스위치. 호출 시점의 MEMENTO_CONTEXT_ANNOTATE를 읽는다.
 * on이면 기억 줄 끝에 " (YYYY-MM-DD, assertion)"을 붙이고, off이면 본문으로 줄이 끝난다.
 * @returns {boolean}
 */
export function contextAnnotateEnabled() {
  return envEnum("MEMENTO_CONTEXT_ANNOTATE", ["on", "off"], "on") === "on";
}
contextAnnotateEnabled();

/**
 * 파편 출처와 신뢰 등급 스위치. 호출 시점의 MEMENTO_PROVENANCE를 읽는다.
 * on이면 쓰기 관문이 생성 파편에 origin, observed_client, trust_tier를 싣고, 등급 1 이하 파편을
 * ANCHOR와 CORE 주입에서 빼며, recall 응답과 답 꾸러미, context 주입 줄 주석에 출처를 싣는다.
 * off이면 세 열을 쓰지도 읽지도 않는다.
 * @returns {boolean}
 */
export function provenanceEnabled() {
  return envEnum("MEMENTO_PROVENANCE", ["on", "off"], "on") === "on";
}
provenanceEnabled();

/**
 * 비차단 검토 대기열 스위치. 호출 시점의 MEMENTO_REVIEW_QUEUE를 읽는다.
 * on이면 쓰기 관문이 검토 규칙에 걸린 쓰기를 review_state='pending'으로 저장한다. 키의 검토 방식
 * 표지(review_off, review_all)가 없으면 flagged 방식이다. off는 새 쓰기에 표지를 다는 일만 멈춘다.
 * 검토 대기와 거절 파편의 가시성 술어(쓴 키에게만 보이고 주입과 승격에서 빠짐)와 30일 자동 거절은
 * 스위치와 무관하게 동작한다.
 * @returns {boolean}
 */
export function reviewQueueEnabled() {
  return envEnum("MEMENTO_REVIEW_QUEUE", ["on", "off"], "on") === "on";
}
reviewQueueEnabled();

/**
 * 콘솔 로그를 표준 오류로 보낼지 여부. 호출 시점의 MEMENTO_LOG_STDERR를 읽는다.
 * CLI는 명령 모듈을 불러오기 전에 이 값을 켜 두어 표준 출력을 명령 결과에만 쓴다.
 * @returns {boolean}
 */
export function logToStderr() {
  return envBool("MEMENTO_LOG_STDERR", false);
}
logToStderr();

/**
 * workspace 위반을 hard gate 대상에 넣을지 여부. 호출 시점의 MEMENTO_WORKSPACE_GATE를 읽는다.
 * @returns {boolean}
 */
export function workspaceGateEnforced() {
  return envBool("MEMENTO_WORKSPACE_GATE", false);
}

/**
 * /register 시간당 등록 상한. 호출 시점의 MEMENTO_DCR_MAX_PER_HOUR(기본 100, 0이면 상한 없음)를 읽는다.
 * @returns {number}
 */
export function dcrHourlyCap() {
  return envInt("MEMENTO_DCR_MAX_PER_HOUR", 100, { min: 0, fallback: true });
}
dcrHourlyCap();

/**
 * outbox 스위치. 호출 시점의 MEMENTO_OUTBOX를 읽는다.
 * off이면 enqueue가 행을 쓰지 않고 null을 돌려주며 작업자도 기동하지 않는다.
 * @returns {boolean}
 */
export function outboxEnabled() {
  return envEnum("MEMENTO_OUTBOX", ["on", "off"], "on") === "on";
}
outboxEnabled();

/**
 * 이 프로세스에서 outbox 작업자를 돌릴지 여부. 호출 시점의 MEMENTO_OUTBOX_WORKER를 읽는다.
 * off여도 기록은 계속되고, 대기 행은 작업자를 돌리는 다른 프로세스나 다시 켠 뒤의 작업자가 처리한다.
 * @returns {boolean}
 */
export function outboxWorkerEnabled() {
  return envEnum("MEMENTO_OUTBOX_WORKER", ["on", "off"], "on") === "on";
}
outboxWorkerEnabled();

/**
 * 훅 엔드포인트 스위치. 호출 시점의 MEMENTO_HOOK_ENDPOINTS를 읽는다.
 * off이면 POST /hooks/{client}/{event}가 404로 응답한다. 이미 outbox에 기록된 회고 이벤트는 계속 처리한다.
 * @returns {boolean}
 */
export function hookEndpointsEnabled() {
  return envEnum("MEMENTO_HOOK_ENDPOINTS", ["on", "off"], "on") === "on";
}
hookEndpointsEnabled();

/**
 * CLI 원격 모드의 MCP 서버 주소와 API 키. 호출 시점의 MEMENTO_CLI_REMOTE, MEMENTO_CLI_KEY를 읽는다.
 * 명령 인자 --remote, --key가 있으면 그 값이 우선한다(호출자가 정한다).
 * @returns {{ remote: string|null, key: string|null }}
 */
export function cliRemoteSettings() {
  return {
    remote: process.env.MEMENTO_CLI_REMOTE || null,
    key   : process.env.MEMENTO_CLI_KEY || null
  };
}

/**
 * outbox 이벤트 하나의 점유 횟수 상한(기본 12, 1 이상 100 이하, 그 밖은 기본값).
 * 상한에 이른 이벤트의 실패는 dead-letter로 기록한다.
 * @returns {number}
 */
export function outboxMaxAttempts() {
  return envInt("MEMENTO_OUTBOX_MAX_ATTEMPTS", 12, { min: 1, max: 100, fallback: true });
}
outboxMaxAttempts();

/**
 * 완료한 outbox 행의 보존 일수(기본 7, 1 이상 3650 이하, 그 밖은 기본값).
 * @returns {number}
 */
export function outboxRetentionDays() {
  return envInt("MEMENTO_OUTBOX_RETENTION_DAYS", 7, { min: 1, max: 3650, fallback: true });
}
outboxRetentionDays();

/**
 * 처리기가 없는 topic의 대기 행을 dead-letter로 옮기기까지의 일수(기본 7, 1 이상 3650 이하, 그 밖은 기본값).
 * 전달 예정 시각(available_at)부터 센다.
 * @returns {number}
 */
export function outboxUnhandledDays() {
  return envInt("MEMENTO_OUTBOX_UNHANDLED_DAYS", 7, { min: 1, max: 3650, fallback: true });
}
outboxUnhandledDays();
export const LOG_DIR            = process.env.LOG_DIR || "./logs";

export const ALLOWED_ORIGINS    = new Set(parseEnvList(process.env.ALLOWED_ORIGINS));

export const ADMIN_ALLOWED_ORIGINS = new Set(parseEnvList(process.env.ADMIN_ALLOWED_ORIGINS));

/** 관리 인증 실패 지연 스위치. 호출 시점의 환경변수를 읽는다. 기본 off. */
export function adminAuthBackoffMode() {
  return process.env.MEMENTO_ADMIN_AUTH_BACKOFF === "on" ? "on" : "off";
}

/** Redis 설정 */
export const REDIS_ENABLED      = process.env.REDIS_ENABLED === "true" || false;
export const REDIS_SENTINEL_ENABLED = process.env.REDIS_SENTINEL_ENABLED === "true" || false;
export const REDIS_HOST         = process.env.REDIS_HOST || "localhost";
export const REDIS_PORT         = envInt("REDIS_PORT", 6379, { min: 1, max: 65535 });
export const REDIS_PASSWORD     = process.env.REDIS_PASSWORD || undefined;
export const REDIS_DB           = envInt("REDIS_DB", 0, { min: 0 });
/** Redis session write failure 시 in-memory fallback을 막는 명시적 보안 opt-in. */
export const REDIS_SESSION_FAIL_CLOSED = process.env.MEMENTO_REDIS_SESSION_FAIL_CLOSED === "true";

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
export const CACHE_DB_TTL       = envInt("CACHE_DB_TTL", 300, { min: 0 }); // 5분
export const CACHE_SESSION_TTL  = envInt("CACHE_SESSION_TTL", SESSION_TTL_MS / 1000, { min: 0 }); // 세션과 동일

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
  if (process.env.EMBEDDING_DIMENSIONS) return envInt("EMBEDDING_DIMENSIONS", Number.NaN, { min: 1 });
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
export const EMBEDDING_TIMEOUT_MS  = envInt("EMBEDDING_TIMEOUT_MS", 8000, { min: 1 });
/** per-call AbortSignal이 전체 절대 데드라인이므로 재시도 기본 0 (타임아웃 중첩 무력화 방지) */
export const EMBEDDING_MAX_RETRIES = envInt("EMBEDDING_MAX_RETRIES", 0, { min: 0 });
export const EMBEDDING_CONCURRENCY = envInt("EMBEDDING_CONCURRENCY", 6, { min: 1 });
export const EMBEDDING_SEM_WAIT_MS = envInt("EMBEDDING_SEM_WAIT_MS", 3000, { min: 0 });

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
export const LLM_CONCURRENCY_WAIT_MS = envInt("LLM_CONCURRENCY_WAIT_MS", 30000, { min: 0 });

const DEFAULT_LLM_CONCURRENCY = {
  "ollama"                                                                  : 16,
  "openai|https://token-plan-sgp.xiaomimimo.com/v1|mimo-v2-pro"            : 8,
  "gemini-cli"                                                              : 1,
  "agy-cli"                                                                 : 1,
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
export const LLM_CB_FAILURE_THRESHOLD = envInt("LLM_CB_FAILURE_THRESHOLD", 5, { min: 1 });
export const LLM_CB_OPEN_DURATION_MS  = envInt("LLM_CB_OPEN_DURATION_MS", 60000, { min: 0 });
export const LLM_CB_FAILURE_WINDOW_MS = envInt("LLM_CB_FAILURE_WINDOW_MS", 60000, { min: 1 });

/** LLM timeout 튜닝 */
const LLM_PROVIDER_TIMEOUT_MS_RAW = process.env.LLM_PROVIDER_TIMEOUT_MS;
export const LLM_PROVIDER_TIMEOUT_CONFIGURED = LLM_PROVIDER_TIMEOUT_MS_RAW !== undefined && LLM_PROVIDER_TIMEOUT_MS_RAW !== "";
export const LLM_PROVIDER_TIMEOUT_MS         = envInt("LLM_PROVIDER_TIMEOUT_MS", 60_000, { min: 0 });
export const LLM_CHAIN_TIMEOUT_MS            = envInt("LLM_CHAIN_TIMEOUT_MS", 0, { min: 0 });

/** Token usage cap (enforcement) */
export const LLM_TOKEN_BUDGET_INPUT      = envInt("LLM_TOKEN_BUDGET_INPUT", null, { min: 0 });
export const LLM_TOKEN_BUDGET_OUTPUT     = envInt("LLM_TOKEN_BUDGET_OUTPUT", null, { min: 0 });
export const LLM_TOKEN_BUDGET_WINDOW_SEC = envInt("LLM_TOKEN_BUDGET_WINDOW_SEC", 86400, { min: 1 });

/** NLI 서비스 설정 (미설정 시 in-process ONNX 모델 로드) */
export const NLI_SERVICE_URL    = process.env.NLI_SERVICE_URL || "";
export const NLI_TIMEOUT_MS     = envInt("NLI_TIMEOUT_MS", 5000, { min: 1 });

/**
 * Case event 검증 결과(verification_passed/failed)를 증거 파편 importance에 역전파할지 여부.
 * 기본 off. true로 설정하면 CaseRewardBackprop.backprop이 실제 UPDATE를 수행하고,
 * false면 호출 자체가 no-op으로 처리되어 DB·메트릭 영향이 없다.
 */
export const CASE_BACKPROP_ENABLED = process.env.MEMENTO_CASE_BACKPROP_ENABLED === "true";

/** Reranker 설정
 *
 * 인프로세스 리랭커는 기본 비활성이다. 기본 모델
 * Xenova/ms-marco-MiniLM-L-6-v2는 영어 MS MARCO 전용 교차 인코더로 한국어
 * 학습 데이터가 없다. 임베딩을 다국어 모델(bge-m3)로 바꾼 뒤 측정하면,
 * 이 리랭커를 끄는 쪽이 격리 모드 Recall@5 67%→88%, 코퍼스 모드 Recall@1
 * 74%→83.5%, MRR 0.827→0.881로 모든 지표에서 낫고 지연도 561ms→123ms로
 * 줄어든다. 상류 벡터 순위가 정확해지자 그 위에서 순위를 다시 쓰는 것이
 * 순손실로 바뀌었다.
 *
 * 되돌릴 수 없는 이유는 상위 30건 중 15건만 남기는 하드 컷이다. 정답이 여기서
 * 잘리면 하류 어떤 보정도 복구하지 못한다.
 *
 * 영어 코퍼스에서는 이득일 수 있으므로 켜는 경로는 남긴다.
 *   MEMENTO_RERANKER_ENABLED=true  — 인프로세스 리랭커 사용
 *   RERANKER_URL=<주소>            — 외부 리랭커 서비스 사용 (별도 스위치 불필요)
 *
 * RERANKER_MODEL 지원값:
 *   minilm  — Xenova/ms-marco-MiniLM-L-6-v2 (기본값, ~80MB, 영어 전용)
 *   bge-m3  — onnx-community/bge-reranker-v2-m3-ONNX (q4, ~280MB, 다국어)
 *             현재 장비에서 30건 재정렬에 7.1초. 인프로세스로는 쓸 수 없다.
 */
export const RERANKER_URL        = process.env.RERANKER_URL || "";
/** 인프로세스 리랭커 명시 활성 스위치. 외부 리랭커를 쓰면 이 값과 무관하게 동작한다. */
export const RERANKER_ENABLED    = process.env.MEMENTO_RERANKER_ENABLED === "true";
export const RERANKER_TIMEOUT_MS = envInt("RERANKER_TIMEOUT_MS", 5000, { min: 1 });
export const RERANKER_MODEL      = (process.env.RERANKER_MODEL || "minilm").toLowerCase();
/** external 리랭커 3연속 실패 시 정책: "skip"(쿨다운 진입·원점수 유지, 기본) | "inprocess"(ONNX 전환, opt-in) */
export const RERANKER_EXTERNAL_FALLBACK    = (process.env.RERANKER_EXTERNAL_FALLBACK || "skip").toLowerCase();
/** skip 정책에서 쿨다운 유지 시간(ms). 이 창 동안 external 호출을 생략하고 원점수를 반환한다. */
export const RERANKER_EXTERNAL_COOLDOWN_MS = envInt("RERANKER_EXTERNAL_COOLDOWN_MS", 60000, { min: 0 });

/** Fragment 쿼터 기본값 */
export const FRAGMENT_DEFAULT_LIMIT = envInt("FRAGMENT_DEFAULT_LIMIT", 5000, { min: 1 });

/** API 키 생성 기본값 */
export const DEFAULT_DAILY_LIMIT    = envInt("DEFAULT_DAILY_LIMIT", 10000, { min: 1 });
export const DEFAULT_FRAGMENT_LIMIT = envInt("DEFAULT_FRAGMENT_LIMIT", null, { min: 1 });
export const DEFAULT_PERMISSIONS    = parseEnvList(process.env.DEFAULT_PERMISSIONS || "read,write");

/** Quota 정밀(FOR UPDATE) 검사를 트리거하는 한도 임박 마진 (remaining 이 이 값 이하일 때만 락) */
export const QUOTA_NEAR_LIMIT_MARGIN = envInt("QUOTA_NEAR_LIMIT_MARGIN", 10, { min: 0 });

/** 데이터베이스 설정 (PostgreSQL) - POSTGRES_* 우선, DB_* 호환 */
export const DB_HOST            = process.env.POSTGRES_HOST || process.env.DB_HOST || "";
export const DB_PORT            = envInt("POSTGRES_PORT", null, { min: 1, max: 65535 }) ?? envInt("DB_PORT", 5432, { min: 1, max: 65535 });
export const DB_NAME            = process.env.POSTGRES_DB || process.env.DB_NAME || "";
export const DB_USER            = process.env.POSTGRES_USER || process.env.DB_USER || "";
export const DB_PASSWORD        = process.env.POSTGRES_PASSWORD || process.env.DB_PASSWORD || "";
export const DB_MAX_CONNECTIONS = envInt("DB_MAX_CONNECTIONS", 20, { min: 2 });
export const DB_IDLE_TIMEOUT_MS = envInt("DB_IDLE_TIMEOUT_MS", 30000, { min: 0 });
export const DB_CONN_TIMEOUT_MS = envInt("DB_CONN_TIMEOUT_MS", 10000, { min: 0 });
export const DB_QUERY_TIMEOUT   = envInt("DB_QUERY_TIMEOUT", 30000, { min: 0 });

/** GET /health/ready의 DB 확인 상한(ms). 와치독 curl 상한 5초보다 짧아야 한다. */
export const HEALTH_READY_DB_TIMEOUT_MS = envInt("MEMENTO_HEALTH_READY_DB_TIMEOUT_MS", 2000, { min: 100, max: 4500, fallback: true });
/** SIGTERM/SIGINT 종료 절차 전체 상한(ms). 0이면 상한 없음. 워커 배수 상한 30초보다 길고 systemd 기본 정지 상한 90초보다 짧다. */
export const SHUTDOWN_DEADLINE_MS = envInt("MEMENTO_SHUTDOWN_DEADLINE_MS", 60000, { min: 0, fallback: true });

/** 설정 값 문제가 있을 때 기동을 멈출지 여부(종료 코드 78). 기본은 경고만 남긴다. */
export const CONFIG_STRICT = envBool("MEMENTO_CONFIG_STRICT", false);

/**
 * 사용처가 호출 시점에 읽는 변수. 사용처는 같은 도우미와 같은 인자로 읽고,
 * 여기서는 모듈 적재 때 한 번 읽어 값 문제를 기동 검사 목록에 올린다.
 */
export const DEFAULT_SCORE_UPDATE_BATCH      = 200;
export const DEFAULT_SESSION_KEY_RECHECK_MS  = 30_000;
export const DEFAULT_DB_STATEMENT_TIMEOUT_MS = 30000;
export const DEFAULT_DB_LOCK_RETRY_MAX       = 3;
export const MAX_DB_LOCK_RETRY_MAX           = 10;
envInt("MEMENTO_SCORE_UPDATE_BATCH", DEFAULT_SCORE_UPDATE_BATCH, { min: 0, fallback: true });
envInt("MEMENTO_DB_LOCK_RETRY_MAX", DEFAULT_DB_LOCK_RETRY_MAX, { min: 0, max: MAX_DB_LOCK_RETRY_MAX, fallback: true });
envInt("MEMENTO_SESSION_KEY_RECHECK_MS", DEFAULT_SESSION_KEY_RECHECK_MS, { min: 0, fallback: true });
envInt("DB_STATEMENT_TIMEOUT_MS", DEFAULT_DB_STATEMENT_TIMEOUT_MS, { min: 0 });
envEnum("MEMENTO_SEMANTIC_THRESHOLD_MODE", ["inner", "outer"], "inner");
envEnum("MEMENTO_LLM_CLI_TOOL_APPROVAL", ["none", "all"], "none");

/**
 * 사용처가 값을 직접 비교하는 스위치. 사용처의 해석은 그대로 두고, 값이 있으면서 문서에 적힌 값이
 * 아닌 경우만 기동 검사 목록에 올린다. 세 번째 인자는 그 경우 사용처가 적용하는 값이다.
 */
envEnum("MEMENTO_SESSION_ID_POLICY", ["warn", "enforce"], "warn");
envEnum("MEMENTO_ADMIN_AUTH_BACKOFF", ["on", "off"], "off");
envEnum("MEMENTO_REMEMBER_DUPLICATE_GUARD", ["true", "false"], "false");
envEnum("MEMENTO_API_KEY_DELETE_GUARD", ["true", "false"], "true");
envEnum("MEMENTO_TOOL_ARGS_VALIDATION", ["off", "warn", "enforce"], "enforce", { emptyOnly: true });
envEnum("MEMENTO_OAUTH_REDIRECT_CHECK", ["warn", "enforce"], "warn");
envEnum("MEMENTO_CORS_MODE", ["reflect", "observe", "allowlist"], "observe");
envEnum("MEMENTO_FRAME_OPTIONS", ["deny"], "off");
envEnum("MEMENTO_SSE_QUERY_KEY", ["allow", "deny"], "allow");

/**
 * true와 false만 값으로 정한 논리 스위치. 사용처의 비교는 그대로 두고, 두 값이 아닌 값은 기동 검사 목록에 올린다.
 * 두 번째 인자는 그 경우 사용처가 적용하는 값이다.
 */
for (const name of [
  "MEMENTO_REMEMBER_ATOMIC", "MEMENTO_WORKSPACE_GATE", "MEMENTO_TOOL_ARGS_ALLOW_UNKNOWN",
  "ENABLE_RECONSOLIDATION", "ENABLE_SPREADING_ACTIVATION", "UPDATE_REQUIRE_SIGNED_TAG",
  "MEMENTO_AUTH_DISABLED", "REDIS_ENABLED", "REDIS_SENTINEL_ENABLED", "MEMENTO_REDIS_SESSION_FAIL_CLOSED",
  "EMBEDDING_SUPPORTS_DIMS_PARAM", "MEMENTO_RERANKER_ENABLED", "MEMENTO_CASE_BACKPROP_ENABLED",
  "UPDATE_CHECK_DISABLED", "ENABLE_OPENAPI", "MCP_ALLOW_AUTO_DCR_REGISTER", "MCP_STRICT_ORIGIN"
]) envBool(name, false);
envBool("CACHE_ENABLED", REDIS_ENABLED);
for (const name of [
  "MEMENTO_ALLOW_LEGACY_UNBOUND_AGENT_SCOPE", "LLM_CONCURRENCY_ENABLED", "MCP_REJECT_NONAPIKEY_OAUTH"
]) envBool(name, true);

/**
 * 스케줄러·워커 같은 백그라운드 작업이 동시에 점유할 수 있는 Primary 풀 연결 상한.
 * 기본값은 DB_MAX_CONNECTIONS 의 40% 이며, 나머지는 요청 경로(remember/recall/health) 몫으로
 * 남긴다. 상한을 넘는 백그라운드 획득은 실패하지 않고 FIFO 큐에서 슬롯이 빌 때까지 기다린다.
 */
export const DB_BACKGROUND_MAX_CONNECTIONS = (() => {
  const fallback  = Math.max(1, Math.floor(DB_MAX_CONNECTIONS * 0.4));
  const parsed    = Number.parseInt(process.env.DB_BACKGROUND_MAX_CONNECTIONS ?? "", 10);
  const requested = Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
  const ceiling   = Math.max(1, DB_MAX_CONNECTIONS - 1);
  return Math.min(ceiling, requested);
})();

/** 백그라운드 슬롯 대기 상한(ms). 넘기면 해당 작업만 실패하고 다음 회차에 재시도한다. */
export const DB_BACKGROUND_WAIT_MAX_MS = (() => {
  const parsed = Number.parseInt(process.env.DB_BACKGROUND_WAIT_MAX_MS ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 120000;
})();

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
export const RATE_LIMIT_WINDOW_MS    = envInt("RATE_LIMIT_WINDOW_MS", 60_000, { min: 1 });
export const RATE_LIMIT_MAX_REQUESTS = envInt("RATE_LIMIT_MAX_REQUESTS", 120, { min: 1 });
export const RATE_LIMIT_PER_IP       = envInt("RATE_LIMIT_PER_IP", 30, { min: 1 });
export const RATE_LIMIT_PER_KEY      = envInt("RATE_LIMIT_PER_KEY", 100, { min: 1 });

/**
 * 신뢰 가능한 리버스 프록시 hop 수.
 * 미설정 시(undefined) X-Forwarded-For 첫 항목을 사용 — 기존 동작 보존.
 * 0 설정 시 XFF 무시. N≥1 설정 시 XFF 체인의 우측에서 N번째 항목 채택.
 */
export const TRUST_PROXY_HOPS = process.env.TRUST_PROXY_HOPS !== undefined
  ? envInt("TRUST_PROXY_HOPS", 0, { min: 0 })
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
export const UPDATE_CHECK_INTERVAL_HOURS = envFloat("UPDATE_CHECK_INTERVAL_HOURS", 24, { min: 0 });

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
 * api_keys 조회 실패로 인증을 판정하지 못한 MCP 요청의 응답 상태.
 * 401(기본)은 키 무효와 같은 응답을, 503은 Retry-After와 함께 일시 장애 응답을 보낸다.
 */
export const AUTH_STORE_UNAVAILABLE_STATUS = Number(envEnum("MEMENTO_AUTH_STORE_UNAVAILABLE_STATUS", ["401", "503"], "401"));

/**
 * MCP 세션 ID 수신 처리 방식. 호출 시점의 MEMENTO_SESSION_ID_POLICY를 읽는다.
 * warn(기본)은 쿼리스트링 수신과 서버 발급 형식이 아닌 ID의 복구를 기록만 하고 통과시킨다.
 * enforce는 쿼리 ID에 400, 서버 발급 형식이 아닌 ID의 복구에 404로 응답한다.
 *
 * @returns {"warn"|"enforce"}
 */
export function sessionIdPolicy() {
  return process.env.MEMENTO_SESSION_ID_POLICY === "enforce" ? "enforce" : "warn";
}

/**
 * OAuth Dynamic Client Registration 자동 등록 허용 (기본 false)
 *
 * false(기본): /authorize에서 미등록 client_id의 자동 등록 차단 → invalid_client 반환
 * true: 기존 자동 등록 허용 (개발/테스트 환경 전용)
 */
export const ALLOW_AUTO_DCR_REGISTER = process.env.MCP_ALLOW_AUTO_DCR_REGISTER === "true";

/** SSE 연결 설정 */
export const SSE_HEARTBEAT_INTERVAL_MS   = envInt("SSE_HEARTBEAT_INTERVAL_MS", 25000, { min: 1000 });
export const SSE_MAX_HEARTBEAT_FAILURES  = envInt("SSE_MAX_HEARTBEAT_FAILURES", 10, { min: 1 });
export const SSE_RETRY_MS                = envInt("SSE_RETRY_MS", 5000, { min: 0 });

/** 장기 세션 idle reflect 설정 */
export const IDLE_REFLECT_HOURS          = envFloat("MCP_IDLE_REFLECT_HOURS", 24, { min: 0 });

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

/**
 * remember 중복 적중 시 기존 파편을 고치지 않고 상태만 알릴지 여부. 기본 false.
 * 호출 시점의 환경 값을 읽는다.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
export function isRememberDuplicateGuardEnabled(env = process.env) {
  return env.MEMENTO_REMEMBER_DUPLICATE_GUARD === "true";
}

const SCORE_MIN_DELTA_ENV_NAMES = new Set(["MEMENTO_DECAY_MIN_DELTA", "MEMENTO_UTILITY_MIN_DELTA"]);

/**
 * 감쇠, utility 갱신의 최소 변화량 원본 값. 통합 실행마다 다시 읽으므로 호출 시점의 값을 돌려준다.
 *
 * @param {string} name MEMENTO_DECAY_MIN_DELTA 또는 MEMENTO_UTILITY_MIN_DELTA
 * @returns {string|undefined}
 */
export function scoreMinDeltaEnv(name) {
  if (!SCORE_MIN_DELTA_ENV_NAMES.has(name)) throw new RangeError(`지원하지 않는 최소 변화량 환경 변수: ${name}`);
  return process.env[name];
}
