/**
 * provenance - 파편 출처와 신뢰 등급 판정
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 파편의 출처 세 열을 정한다.
 *   origin           클라이언트가 주장한 출처(ORIGINS). 서버 진입점(가져오기, 분할, 자동 회고)은 정해진 값
 *   observed_client  서버가 관측한 클라이언트 이름(initialize의 clientInfo.name)과 쓰기 진입점 이름
 *   trust_tier       0 격리, 1 낮음, 2 보통, 3 높음. 주장 출처의 등급과 키 상한 중 작은 값
 *
 * 키 상한은 키 권한 목록의 trusted_origin 표지(lib/rbac.js)가 있거나 마스터 키이면 3, 그 밖은 2다.
 * 저장값이 NULL인 기존 행은 2로 해석하며 일괄 백필하지 않는다. 등급 1 이하는 ANCHOR와 CORE 주입에서
 * 빠진다. assertion_status(verified 포함)는 등급 판정에 쓰지 않으며, 갱신(amend)은 등급을 바꾸지 않는다.
 *
 * DB, 설정, 환경 변수에 닿지 않는 순수 함수만 둔다.
 */

import { trustedOriginGranted } from "../rbac.js";

/** fragments.origin이 가질 수 있는 값 */
export const ORIGINS = Object.freeze([
  "user_stated", "agent_inferred", "tool_output", "external_content", "consolidation", "import"
]);

/** 신뢰 등급 */
export const TRUST_TIER = Object.freeze({ QUARANTINED: 0, LOW: 1, NORMAL: 2, HIGH: 3 });

/** 주장이 없거나 저장값이 NULL일 때의 등급 */
export const DEFAULT_TRUST_TIER = TRUST_TIER.NORMAL;

/** ANCHOR와 CORE 주입에 들어가는 최소 등급 */
export const MIN_INJECTABLE_TIER = TRUST_TIER.NORMAL;

/** 출처별 주장 등급. 키 상한이 이 값을 더 낮출 수 있다. */
export const ORIGIN_TIERS = Object.freeze({
  user_stated     : TRUST_TIER.HIGH,
  agent_inferred  : TRUST_TIER.NORMAL,
  tool_output     : TRUST_TIER.NORMAL,
  external_content: TRUST_TIER.LOW,
  consolidation   : TRUST_TIER.NORMAL,
  import          : TRUST_TIER.NORMAL
});

/** 클라이언트의 origin 주장을 받는 쓰기 진입점 */
export const CLAIM_ENTRIES = Object.freeze(["remember", "batch_remember"]);

/** 서버가 출처를 정하는 쓰기 진입점. 클라이언트 주장을 쓰지 않는다. */
export const ENTRY_ORIGINS = Object.freeze({
  admin_import     : "import",
  cli_import       : "import",
  consolidate_split: "consolidation",
  auto_reflect     : "consolidation"
});

/** MCP 클라이언트 없이 서버나 운영 도구가 쓰는 진입점. 관측 클라이언트 이름이 없으면 internal로 적는다. */
const INTERNAL_ENTRIES = new Set([...Object.keys(ENTRY_ORIGINS), "cli_remember"]);

/** 관측 클라이언트 이름의 최대 길이 */
export const CLIENT_NAME_MAX = 64;

/** 출처 열 이름. INSERT 열 순서와 같다. */
export const PROVENANCE_COLUMNS = Object.freeze(["origin", "observed_client", "trust_tier"]);

const ORIGIN_SET          = new Set(ORIGINS);
const CLIENT_NAME_INVALID = /[^A-Za-z0-9 ._:+-]+/g;
const SQL_COLUMN          = /^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*$/;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isOrigin(value) {
  return typeof value === "string" && ORIGIN_SET.has(value);
}

/**
 * 알려진 출처 값만 돌려준다.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function originLabel(value) {
  return isOrigin(value) ? value : null;
}

/**
 * 진입점과 클라이언트 주장으로 저장할 출처를 정한다. 서버 진입점은 정해진 값, 주장을 받는 진입점은
 * 주장 값, 그 밖은 null이다. 주장 값의 허용 여부는 호출자가 먼저 확인한다.
 *
 * @param {string} entry
 * @param {unknown} claim
 * @returns {string|null}
 */
export function claimedOrigin(entry, claim) {
  if (Object.hasOwn(ENTRY_ORIGINS, entry)) return ENTRY_ORIGINS[entry];
  if (!CLAIM_ENTRIES.includes(entry)) return null;
  return isOrigin(claim) ? claim : null;
}

/**
 * 출처의 주장 등급. 출처가 없으면 기본 등급이다.
 *
 * @param {string|null} origin
 * @returns {number}
 */
export function originTier(origin) {
  return isOrigin(origin) ? ORIGIN_TIERS[origin] : DEFAULT_TRUST_TIER;
}

/**
 * 0~3 정수가 아니면 null이다.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function tierOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= TRUST_TIER.QUARANTINED && n <= TRUST_TIER.HIGH ? n : null;
}

/**
 * 키의 등급 상한. trusted_origin 표지가 있거나 마스터 키이면 3, 그 밖은 2다.
 *
 * @param {{isMaster?: boolean, permissions?: string[]|null}} key
 * @returns {number}
 */
export function keyTrustCap({ isMaster = false, permissions = null } = {}) {
  return trustedOriginGranted(permissions, isMaster === true) ? TRUST_TIER.HIGH : TRUST_TIER.NORMAL;
}

/**
 * 저장할 신뢰 등급. 주장 출처의 등급과 키 상한 중 작은 값이며, 상한이 정수 0~3이 아니면 기본 상한(2)을 쓴다.
 *
 * @param {string|null} origin
 * @param {unknown} cap
 * @returns {number}
 */
export function resolveTrustTier(origin, cap) {
  const limit = typeof cap === "number" ? tierOrNull(cap) : null;
  return Math.min(originTier(origin), limit ?? DEFAULT_TRUST_TIER);
}

/**
 * 저장된 등급을 해석한다. NULL과 범위 밖의 값은 기본 등급(2)이다.
 *
 * @param {unknown} stored
 * @returns {number}
 */
export function effectiveTrustTier(stored) {
  return tierOrNull(stored) ?? DEFAULT_TRUST_TIER;
}

/**
 * ANCHOR와 CORE 주입 대상인지 본다. 등급 1 이하는 제외한다.
 *
 * @param {{trust_tier?: unknown}|null|undefined} fragment
 * @returns {boolean}
 */
export function isInjectable(fragment) {
  return effectiveTrustTier(fragment?.trust_tier) >= MIN_INJECTABLE_TIER;
}

/**
 * isInjectable과 같은 판정을 하는 SQL 술어. NULL은 2로 보아 포함한다.
 *
 * @param {string} column - 열 이름(별칭 하나 허용)
 * @returns {string}
 */
export function injectableTierSql(column) {
  if (!SQL_COLUMN.test(column)) throw new TypeError(`invalid column name: ${column}`);
  return `(${column} IS NULL OR ${column} >= ${MIN_INJECTABLE_TIER})`;
}

/**
 * 클라이언트 이름을 허용 문자(ASCII 영숫자, 공백, . _ : + -)로 줄이고 길이를 제한한다.
 * 허용하지 않는 문자(@, 제어문자, 비ASCII 포함)가 이어진 구간은 밑줄 하나로 바꾼다.
 *
 * @param {unknown} name
 * @returns {string|null} 비어 있으면 null
 */
export function sanitizeClientName(name) {
  if (typeof name !== "string") return null;
  const cleaned = name.trim().replace(CLIENT_NAME_INVALID, "_").slice(0, CLIENT_NAME_MAX).trim();
  return cleaned === "" ? null : cleaned;
}

/**
 * initialize 요청의 clientInfo.name. 그 밖의 요청이면 null이다.
 *
 * @param {object|null} msg - JSON-RPC 메시지
 * @returns {string|null}
 */
export function clientNameFromInitialize(msg) {
  if (msg?.method !== "initialize") return null;
  return sanitizeClientName(msg.params?.clientInfo?.name);
}

/**
 * 관측 클라이언트 표기. "클라이언트 이름/진입점 이름"이며 이름이 없으면 서버 진입점은 internal,
 * 그 밖은 unknown이다.
 *
 * @param {string} entry
 * @param {unknown} clientName
 * @returns {string}
 */
export function observedClient(entry, clientName) {
  const name = sanitizeClientName(clientName) ?? (INTERNAL_ENTRIES.has(entry) ? "internal" : "unknown");
  return `${name}/${entry}`;
}

/**
 * 서버가 주입한 호출 문맥에서 출처 판정 문맥을 만든다. 서버 내부 경로가 넘긴 _provenance가 있으면
 * 그 값을, 없으면 세션의 _clientName, _isMaster, _permissions를 쓴다.
 *
 * @param {object|null} params
 * @returns {{clientName: string|null, trustCap: number}}
 */
export function provenanceContext(params) {
  const passed = params?._provenance;
  if (passed && typeof passed === "object") {
    return {
      clientName: sanitizeClientName(passed.clientName),
      trustCap  : tierOrNull(typeof passed.trustCap === "number" ? passed.trustCap : null) ?? DEFAULT_TRUST_TIER
    };
  }
  return {
    clientName: sanitizeClientName(params?._clientName),
    trustCap  : keyTrustCap({ isMaster: params?._isMaster === true, permissions: params?._permissions ?? null })
  };
}

/**
 * 원본 파편들에서 만든 파생 파편의 키 상한. 원본 등급 중 가장 낮은 값이며, 등급을 모르는 원본
 * (조회되지 않은 id, undefined)은 낮음(1)으로 본다. 저장값 NULL은 2다.
 *
 * @param {Array<unknown>} parentTiers - 원본의 저장된 trust_tier(NULL 허용), 조회 실패는 undefined
 * @returns {number}
 */
export function derivedTrustCap(parentTiers) {
  if (!Array.isArray(parentTiers) || parentTiers.length === 0) return TRUST_TIER.LOW;
  return Math.min(...parentTiers.map(t => (t === undefined ? TRUST_TIER.LOW : effectiveTrustTier(t))));
}

/**
 * 생성 파편에 실을 출처 세 값. assertion_status는 판정에 쓰지 않는다.
 *
 * @param {{entry: string, claim?: unknown, clientName?: unknown, trustCap?: unknown}} input
 * @returns {{origin: string|null, observed_client: string, trust_tier: number}}
 */
export function provenanceStamp({ entry, claim = null, clientName = null, trustCap = DEFAULT_TRUST_TIER }) {
  const origin = claimedOrigin(entry, claim);
  return {
    origin,
    observed_client: observedClient(entry, clientName),
    trust_tier     : resolveTrustTier(origin, trustCap)
  };
}

/**
 * 파편이 출처 값을 가졌는지 본다. 관문이 MEMENTO_PROVENANCE=on에서 생성 파편에 싣는다.
 *
 * @param {object|null} fragment
 * @returns {boolean}
 */
export function hasProvenance(fragment) {
  return fragment != null && Object.hasOwn(fragment, "trust_tier");
}

/**
 * INSERT 문에 덧붙일 출처 열 조각. 출처 값이 없고 force가 아니면 빈 조각이라 문장이 바뀌지 않는다.
 *
 * @param {object} fragment
 * @param {number} startIndex - 첫 자리표시자 번호
 * @param {{force?: boolean}} [options] - 같은 문장의 다른 행이 출처 값을 가질 때 NULL로 채운다
 * @returns {{columns: string, placeholders: string, values: Array}}
 */
export function provenanceInsertParts(fragment, startIndex, { force = false } = {}) {
  if (!force && !hasProvenance(fragment)) return { columns: "", placeholders: "", values: [] };
  return {
    columns     : `, ${PROVENANCE_COLUMNS.join(", ")}`,
    placeholders: `, $${startIndex}, $${startIndex + 1}, $${startIndex + 2}::smallint`,
    values      : [
      fragment?.origin ?? null,
      fragment?.observed_client ?? null,
      tierOrNull(fragment?.trust_tier)
    ]
  };
}
