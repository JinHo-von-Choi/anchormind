/**
 * 스위치 대장
 *
 * 기능 스위치(불리언과 기능 개폐를 정하는 열거)의 이름, 문서 기본값, 용도, 분류를 한곳에 둔다.
 * describeSwitches(env)는 주어진 환경에서 스위치마다 실제 적용되는 값을 돌려준다. 판독 규칙은
 * 사용처와 같다. 불리언과 열거의 원시값 분류는 lib/config.js의 envBool, envEnum과 같은 함수
 * (lib/env-parse.js)를 쓰고, 사용처가 다르게 해석하는 경우(대소문자, 공백, 잘못된 값의 적용값)는
 * 항목의 속성으로 적는다.
 *
 * 키, 토큰, 주소를 담는 변수는 넣지 않는다. 잘못된 원본 값은 결과에 담지 않는다.
 * 다른 모듈은 lib/env-parse.js만 가져온다.
 *
 * 항목 속성
 *   name        환경 변수 이름
 *   kind        "boolean" | "enum" | "off-disables"
 *               off-disables: 리터럴 "off"만 끄고 그 밖의 모든 값과 미설정은 켜짐이며 잘못된 값이 없다
 *   default     미설정일 때의 값. boolean은 true/false, enum은 문자열
 *   values      enum의 문서 값 목록
 *   off         enum에서 꺼짐으로 보는 값. 없으면 상태는 "mode"
 *   invalid     잘못된 값일 때 사용처가 적용하는 값. 없으면 default. "fatal"은 기동 실패
 *   ci          true이면 사용처가 대소문자를 구분하지 않고 읽는다
 *   trim        true이면 사용처가 앞뒤 공백을 지우고 읽는다
 *   strictBlank true이면 빈 문자열을 미설정이 아니라 잘못된 값으로 읽는다
 *   emptyOnly   enum에서 true이면 빈 문자열만 미설정이고 공백만 있는 값은 잘못된 값이다
 *   follows     기본값이 다른 불리언 스위치의 값이고, "true"이면 그 값과 무관하게 켜진다
 *   exception   기본값이 켜짐이 아닌 이유의 분류
 *   category    분류
 *   purpose     한 줄 용도
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { classifyBool, classifyEnum } from "../lib/env-parse.js";

/** 사용처가 `=== "true"`로 읽는 불리언 */
const boolOff = (name, category, purpose, extra = {}) =>
  ({ name, kind: "boolean", default: false, category, purpose, ...extra });

/** 사용처가 `!== "false"`로 읽는 불리언 */
const boolOn = (name, category, purpose, extra = {}) =>
  ({ name, kind: "boolean", default: true, category, purpose, ...extra });

/** 열거 */
const enumOf = (name, values, def, category, purpose, extra = {}) =>
  ({ name, kind: "enum", values, default: def, category, purpose, ...extra });

/** 사용처가 `(값 ?? "true") === "true"`로 읽는 불리언. 빈 값과 잘못된 값은 꺼짐이다 */
const boolOnStrict = (name, category, purpose) =>
  boolOn(name, category, purpose, { strictBlank: true, invalid: false });

/** 사용처가 대소문자를 구분하지 않고 읽는 symbolic 불리언 */
/** 사용처가 `=== "off"` 또는 `!== "off"`로 읽는 스위치. 리터럴 off만 끄고 그 밖의 값은 모두 켜짐으로 유효하다 */
const offDisables = (name, category, purpose) =>
  ({ name, kind: "off-disables", values: ["on", "off"], default: "on", off: ["off"], category, purpose });

const symbolicFlag = (name, purpose) => boolOff(name, "symbolic", purpose, { ci: true });

export const SWITCHES = Object.freeze([
  /* 인증과 접근 */
  boolOff("MEMENTO_AUTH_DISABLED", "인증", "인증을 끄고 모든 요청을 master 권한으로 처리한다(개발과 시험 전용)"),
  boolOn("MEMENTO_ALLOW_LEGACY_UNBOUND_AGENT_SCOPE", "인증", "agent 식별 결합 이전 키의 agentId 주장을 허용한다"),
  enumOf("MEMENTO_RESERVED_AGENT_IDS", ["warn", "enforce"], "warn", "인증", "예약 agentId 사용을 경고로 두거나 거부한다"),
  enumOf("MEMENTO_ADMIN_AUTH_BACKOFF", ["on", "off"], "off", "인증", "관리 인증 연속 실패 뒤 응답을 지연한다", { off: ["off"] }),
  boolOn("MEMENTO_API_KEY_DELETE_GUARD", "인증", "저장 자료가 있는 API 키의 삭제를 막는다"),
  boolOff("MEMENTO_REDIS_SESSION_FAIL_CLOSED", "인증", "Redis 세션 저장 실패 시 메모리 대체 없이 요청을 실패시킨다"),
  enumOf("MEMENTO_SESSION_ID_POLICY", ["warn", "enforce"], "warn", "인증", "세션 ID 수신 규칙 위반을 기록만 하거나 거부한다"),
  enumOf("MEMENTO_OAUTH_REDIRECT_CHECK", ["warn", "enforce"], "warn", "인증", "OAuth 오류 응답의 리다이렉트 대상 확인을 기록만 하거나 거부한다"),
  enumOf("MEMENTO_CORS_MODE", ["reflect", "observe", "allowlist"], "observe", "네트워크", "허용 Origin 목록이 없을 때의 교차 출처 응답 방식"),
  enumOf("MEMENTO_FRAME_OPTIONS", ["deny"], "off", "네트워크", "응답에 X-Frame-Options DENY를 붙인다", { off: ["off"] }),
  enumOf("MEMENTO_SSE_QUERY_KEY", ["allow", "deny"], "allow", "네트워크", "SSE 쿼리스트링 키 수신을 허용하거나 거부한다"),
  boolOff("MCP_STRICT_ORIGIN", "네트워크", "허용 목록에 없는 Origin의 요청을 거부한다"),
  boolOff("MCP_ALLOW_AUTO_DCR_REGISTER", "인증", "미등록 client_id의 자동 등록을 허용한다"),
  boolOn("MCP_REJECT_NONAPIKEY_OAUTH", "인증", "API 키가 아닌 OAuth 토큰 인증을 거부한다"),
  boolOff("ENABLE_OPENAPI", "네트워크", "GET /openapi.json 엔드포인트를 연다"),

  /* 입력 검증과 쓰기 경로 */
  enumOf("MEMENTO_TOOL_ARGS_VALIDATION", ["off", "warn", "enforce"], "warn", "쓰기 경로", "tools/call 인자를 inputSchema와 대조하는 방식", { off: ["off"], invalid: "enforce", emptyOnly: true }),
  boolOff("MEMENTO_TOOL_ARGS_ALLOW_UNKNOWN", "쓰기 경로", "inputSchema에 없는 인자를 위반으로 보지 않는다"),
  boolOff("MEMENTO_REMEMBER_ATOMIC", "쓰기 경로", "remember의 한도 확인과 저장을 한 트랜잭션으로 묶는다"),
  boolOff("MEMENTO_REMEMBER_DUPLICATE_GUARD", "쓰기 경로", "remember 중복 적중 시 기존 파편을 고치지 않고 상태만 알린다"),
  boolOff("MEMENTO_WORKSPACE_GATE", "쓰기 경로", "workspace가 없는 파편의 저장을 거부한다"),
  enumOf("MEMENTO_WRITE_GATE", ["on", "off"], "on", "쓰기 경로", "의미 쓰기 진입점이 쓰기 관문의 전체 단계를 거친다", { off: ["off"] }),
  enumOf("MEMENTO_SENSITIVE_SCAN", ["mask", "reject", "off"], "mask", "쓰기 경로", "쓰기 값의 비밀과 개인정보를 가리고(mask) 고신뢰 탐지는 전 키 거부(reject)하거나 기존 4개 규칙만 적용한다(off)", { off: ["off"] }),

  /* 저장소와 캐시 */
  boolOff("REDIS_ENABLED", "저장소", "Redis를 쓴다(L1 검색, 세션, 캐시)"),
  boolOff("REDIS_SENTINEL_ENABLED", "저장소", "Redis Sentinel 모드로 연결한다"),
  { name: "CACHE_ENABLED", kind: "boolean", default: false, follows: "REDIS_ENABLED", category: "저장소", purpose: "쿼리 결과 캐시를 쓴다(기본은 REDIS_ENABLED 값)" },

  /* 검색 */
  boolOff("MEMENTO_RERANKER_ENABLED", "검색", "인프로세스 교차 인코더 리랭커를 쓴다", { exception: "실험" }),
  boolOn("MEMENTO_QUERY_PROFILE_ENABLED", "검색", "질의 의도별 검색 프로파일을 적용한다"),
  boolOn("MEMENTO_KEYWORD_SEMANTIC_FALLBACK", "검색", "keywords만 있는 recall에 시맨틱 보조 검색을 더한다"),
  boolOn("MEMENTO_WORKSPACE_DECAY", "검색", "workspace가 다른 파편의 순위 점수를 낮춘다"),
  offDisables("MEMENTO_VECTOR_FORCE_INDEX", "검색", "벡터 검색에 인덱스 강제 planner 힌트를 쓴다"),
  boolOff("ENABLE_SPREADING_ACTIVATION", "검색", "recall의 contextText로 활성 확산 검색을 한다"),
  boolOff("MEMENTO_SYNTHETIC_QUERY_ENABLED", "검색", "파편 저장 시 LLM으로 합성 역질의를 만들어 색인한다"),
  boolOn("MEMENTO_SYNTHETIC_QUERY_SEARCH", "검색", "합성 역질의 벡터를 검색에 반영한다"),

  /* 기억 처리 */
  boolOff("ENABLE_RECONSOLIDATION", "기억 처리", "재공고화 엔진으로 링크 가중치와 대체를 갱신한다"),
  boolOff("MEMENTO_CASE_BACKPROP_ENABLED", "기억 처리", "케이스 검증 결과를 증거 파편 중요도에 역전파한다"),
  boolOn("MEMENTO_AUTO_PROMOTE_ANCHORS", "기억 처리", "정리 작업에서 자동 앵커 승격 단계를 실행한다", { trim: true, invalid: "fatal" }),
  boolOnStrict("MEMENTO_CONSOLIDATE_SPLIT_LONG", "기억 처리", "정리 작업에서 긴 파편 분할 단계를 실행한다"),
  boolOnStrict("MEMENTO_CONSOLIDATE_DETECT_CONTRADICT", "기억 처리", "정리 작업에서 모순 탐지 단계를 실행한다"),
  boolOff("MEMENTO_CONSOLIDATE_COMPRESS_OLD", "기억 처리", "정리 작업에서 오래된 파편 압축 단계를 실행한다"),
  boolOnStrict("MEMENTO_SPLIT_SUBJECT_GATE", "기억 처리", "분할 자식이 부모의 주어 앵커를 담지 못하면 폐기한다"),
  boolOnStrict("MEMENTO_SPLIT_MODALITY_GATE", "기억 처리", "분할 자식이 부모에 없던 양상을 도입하면 폐기한다"),
  enumOf("MEMENTO_PROACTIVE_RECALL_MODE", ["off", "auto", "legacy"], "auto", "기억 처리", "remember 직후 related 링크 자동 생성 방식", { off: ["off"] }),
  boolOnStrict("MEMENTO_FEEDBACK_SAMPLING", "기억 처리", "쓰기 응답에 tool_feedback 요청 힌트를 확률적으로 동봉한다"),
  boolOn("MEMENTO_SESSION_SEGMENT", "세션", "유휴와 수명 기준으로 세션 세그먼트를 회전한다"),
  boolOn("MEMENTO_ENABLE_KUROMOJI", "기억 처리", "일본어 형태소 분석기(kuromoji)를 로드한다"),

  /* symbolic */
  symbolicFlag("MEMENTO_SYMBOLIC_ENABLED", "symbolic 서브시스템 전체 개폐(마스터 스위치)"),
  symbolicFlag("MEMENTO_SYMBOLIC_SHADOW", "symbolic 결과를 기록만 하고 적용하지 않는다"),
  symbolicFlag("MEMENTO_SYMBOLIC_CLAIM_EXTRACTION", "remember 후처리에서 주장 추출을 실행한다"),
  symbolicFlag("MEMENTO_SYMBOLIC_EXPLAIN", "recall 응답에 설명 필드를 포함한다"),
  symbolicFlag("MEMENTO_SYMBOLIC_LINK_CHECK", "링크 무결성 권고 경로를 켠다"),
  symbolicFlag("MEMENTO_SYMBOLIC_POLARITY_CONFLICT", "극성 충돌 권고 경고를 기록한다"),
  symbolicFlag("MEMENTO_SYMBOLIC_POLICY_RULES", "정책 규칙 소프트 게이트를 적용한다"),
  symbolicFlag("MEMENTO_SYMBOLIC_CBR_FILTER", "케이스 회상에 symbolic 필터를 적용한다"),
  symbolicFlag("MEMENTO_SYMBOLIC_PROACTIVE_GATE", "자동 링크 생성에 극성 게이트를 적용한다"),

  /* LLM */
  boolOn("LLM_CONCURRENCY_ENABLED", "LLM", "LLM 호출 동시성 세마포어를 쓴다"),
  enumOf("MEMENTO_LLM_CLI_TOOL_APPROVAL", ["none", "all"], "none", "LLM", "CLI provider의 도구 실행 승인 제한을 푼다", { off: ["none"] }),

  /* 운영 */
  boolOff("MEMENTO_CONFIG_STRICT", "운영", "환경 변수 값 문제가 있으면 기동을 멈춘다"),
  boolOff("MEMENTO_LOG_STDERR", "운영", "콘솔 로그를 표준 오류로 보낸다(CLI는 serve를 뺀 명령에서 자동으로 켠다)"),
  boolOff("UPDATE_CHECK_DISABLED", "운영", "신규 버전 확인을 끈다"),
  boolOff("UPDATE_REQUIRE_SIGNED_TAG", "운영", "git 설치본 갱신에서 서명된 태그를 요구한다"),
  offDisables("MEMENTO_ADMIN_METRICS_SAMPLING", "운영", "관리 콘솔 메트릭 샘플링을 한다"),
  offDisables("MEMENTO_METRICS_DEFAULT", "운영", "prom-client 기본 메트릭(CPU, 메모리 등)을 수집한다")
]);

const BY_NAME = new Map(SWITCHES.map((spec) => [spec.name, spec]));

/**
 * 원시값을 사용처가 읽는 규칙에 맞게 다듬는다.
 *
 * @param {string|undefined} raw
 * @param {object} spec
 * @returns {string|undefined}
 */
function normalizeRaw(raw, spec) {
  if (raw === undefined) return undefined;
  let text = String(raw);
  if (spec.trim) text = text.trim();
  if (spec.ci)   text = text.toLowerCase();
  return text;
}

/**
 * 원시값 분류. strictBlank 항목은 빈 값을 미설정이 아니라 잘못된 값으로 본다.
 *
 * @param {string|undefined} text
 * @param {object} spec
 */
function classify(text, spec) {
  if (spec.strictBlank && text !== undefined && text.trim() === "") return { status: "invalid" };
  if (spec.kind === "off-disables") return text === "off" ? { status: "valid", value: "off" } : { status: "unset" };
  if (spec.kind === "boolean") return classifyBool(text);
  return classifyEnum(text, spec.values, { emptyOnly: Boolean(spec.emptyOnly) });
}

/**
 * 잘못된 값이 들어왔을 때 사용처가 적용하는 값.
 *
 * @param {object} spec
 * @param {boolean|string} def
 * @returns {boolean|string}
 */
function appliedOnInvalid(spec, def) {
  if (spec.invalid === undefined || spec.invalid === "fatal") return def;
  return spec.invalid;
}

/**
 * 스위치 하나의 상태를 계산한다. follows 항목의 기준 스위치는 resolve로 얻는다.
 *
 * @param {object} spec
 * @param {Record<string, string|undefined>} env
 * @param {(name: string) => boolean|string} resolve
 */
function describeOne(spec, env, resolve) {
  const def      = spec.follows ? resolve(spec.follows) : spec.default;
  const parsed   = classify(normalizeRaw(env[spec.name], spec), spec);
  const invalid  = parsed.status === "invalid";
  let   value    = def;
  if (parsed.status === "valid")  value = parsed.value;
  if (invalid)                    value = appliedOnInvalid(spec, def);
  if (spec.follows && value === false) value = def;
  return finishState(spec, def, value, invalid);
}

/**
 * 계산한 값에서 표시용 상태 객체를 만든다. 원본 문자열은 담지 않는다.
 */
function finishState(spec, def, value, invalid) {
  const fatal = invalid && spec.invalid === "fatal";
  let   state = "mode";
  if (fatal)                               state = "invalid";
  else if (spec.kind === "boolean")        state = value ? "on" : "off";
  else if (spec.off)                       state = spec.off.includes(value) ? "off" : "on";
  const problem = invalid ? (spec.kind === "boolean" ? "not_boolean" : "not_in_enum") : null;
  return {
    name       : spec.name,
    kind       : spec.kind,
    category   : spec.category,
    purpose    : spec.purpose,
    exception  : spec.exception ?? null,
    default    : String(def),
    value      : fatal ? "invalid" : String(value),
    state,
    nonDefault : !fatal && value !== def,
    invalid,
    problem
  };
}

/**
 * 주어진 환경에서 레지스트리의 모든 스위치가 실제로 적용되는 상태를 돌려준다.
 * 입력 객체는 읽기만 하고 레지스트리에 없는 변수는 보지 않는다.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {Array<{ name: string, kind: string, category: string, purpose: string, exception: string|null,
 *   default: string, value: string, state: "on"|"off"|"mode"|"invalid", nonDefault: boolean,
 *   invalid: boolean, problem: string|null }>}
 */
export function describeSwitches(env) {
  const memo    = new Map();
  const resolve = (name) => {
    if (!memo.has(name)) {
      const spec  = BY_NAME.get(name);
      const state = describeOne(spec, env, resolve);
      memo.set(name, spec.kind === "boolean" ? state.value === "true" : state.value);
    }
    return memo.get(name);
  };
  return SWITCHES.map((spec) => describeOne(spec, env, resolve));
}

/**
 * 상태 목록의 개수와 기본과 다른 스위치 이름.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ total: number, on: number, off: number, mode: number, nonDefaultCount: number,
 *   nonDefault: string[], invalid: string[] }}
 */
export function summarizeSwitches(env) {
  const states = describeSwitches(env);
  const count  = (state) => states.filter((s) => s.state === state).length;
  const diff   = states.filter((s) => s.nonDefault);
  return {
    total          : states.length,
    on             : count("on"),
    off            : count("off"),
    mode           : count("mode"),
    nonDefaultCount: diff.length,
    nonDefault     : diff.map((s) => s.name),
    invalid        : states.filter((s) => s.invalid).map((s) => s.name)
  };
}

/** 목록에 적을 값: 불리언은 on/off, 열거는 그 값 */
const shown = (s) => (s.kind === "boolean" ? s.state : s.value);

/**
 * 기동 로그 한 줄. 개수와 기본과 다른 스위치의 이름과 on, off 또는 열거 값만 담는다.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
export function switchSummaryLine(env) {
  const states = describeSwitches(env);
  const sum    = summarizeSwitches(env);
  const diff   = states.filter((s) => s.nonDefault).map((s) => `${s.name}=${shown(s)}`);
  const bad    = states.filter((s) => s.invalid).map((s) => s.name);
  const parts  = [
    `[Startup] switches: total=${sum.total} on=${sum.on} off=${sum.off} mode=${sum.mode}`,
    `nonDefault=${sum.nonDefaultCount}${diff.length ? ` (${diff.join(", ")})` : ""}`,
    `invalid=${bad.length}${bad.length ? ` (${bad.join(", ")})` : ""}`
  ];
  return parts.join(" ");
}

const TABLE_HEAD = ["스위치", "적용 값", "기본값", "상태", "기본과 다름", "분류", "예외 분류", "용도"];

/** 표 칸 안에서 줄과 칸을 깨는 문자를 지운다 */
const cell = (text) => String(text).replace(/\|/g, "/").replace(/\r?\n/g, " ");

/**
 * 상태 목록을 마크다운 표로 만든다. 열 구분선은 최소 형식이다.
 *
 * @param {ReturnType<typeof describeSwitches>} states
 * @returns {string}
 */
export function formatSwitchTable(states) {
  const rows = states.map((s) => {
    let diff = s.nonDefault ? "예" : "아니오";
    if (s.invalid) diff = "값 오류";
    return [s.name, s.value, s.default, s.state, diff, s.category, s.exception ?? "", s.purpose];
  });
  const line = (cols) => `| ${cols.map(cell).join(" | ")} |`;
  return [line(TABLE_HEAD), `|${"-|".repeat(TABLE_HEAD.length)}`, ...rows.map(line)].join("\n");
}

/** 현재 프로세스 환경 기준 요약. 관리 API와 기동 로그가 쓴다. */
export const currentSwitchSummary = () => summarizeSwitches(process.env);

/** 현재 프로세스 환경 기준 기동 로그 줄 */
export const currentSwitchLine = () => switchSummaryLine(process.env);
