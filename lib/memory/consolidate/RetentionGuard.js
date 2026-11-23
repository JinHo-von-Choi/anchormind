/**
 * RetentionGuard — 자동 정리가 파편을 지우거나 닫거나 permanent를 해제해도 되는지 판정한다
 *
 * 작성자: 최진호
 * 작성일: 2026-11-23
 *
 * 보존 모드는 두 가지다. auto(기본)는 지금처럼 정리 주기와 저장 경로가 자동 판단으로 파편을 지우고 닫는다.
 * manual은 자동 판단으로는 지우지도 닫지도 않는다. importance 감쇠, EMA, 등급 승격 같은 순위 신호와 forget,
 * 관리자가 정한 보존 기간 만료(RetentionGC)는 manual에서도 그대로다.
 *
 * manual은 세 곳에서 켠다. 하나라도 manual이면 manual이다.
 *   전역      MEMENTO_RETENTION_MODE=manual, 또는 MEMENTO_RETENTION_AUTO_AFTER가 미래 시각(lib/config.js)
 *   키 전체   key_retention_policies의 workspace NULL 행이 auto_lifecycle=FALSE이거나 auto_resume_at이 미래
 *   workspace 같은 표의 workspace 행이 위와 같은 상태
 * key_id가 없는 파편(마스터 키로 쓴 파편)은 전역 설정만 따른다.
 *
 * 자동 경로는 지우거나 닫을 대상을 고르는 질의에 lifecycleGuardSql(별칭)을 붙이거나, 행 하나를 다룰 때
 * isAutoLifecycleAllowed(keyId, workspace)를 부른다. forget, 공통 삭제 문장, 삭제 뒤 정리에는 붙이지 않는다.
 *
 * 범위별 manual 행이 하나도 없으면 lifecycleGuardSql은 빈 문자열을 돌려줘 지금과 같은 SQL이 나간다. 그 유무는
 * 프로세스 안에 CACHE_MS 동안 담아 두고, 키 캐시 무효화(lib/keys/invalidation.js)가 함께 비운다.
 */

import { queryWithAgentVector } from "../../tools/db.js";
import { SCHEMA }               from "../schema.js";
import { retentionModeSetting } from "../../config.js";
import { logWarn }              from "../../logger.js";

/** 범위별 manual 행 유무를 담아 두는 시간(ms) */
export const CACHE_MS = 60_000;

/** migration-078(표) 또는 migration-084(열) 전 설치 */
const UNDEFINED_TABLE  = "42P01";
const UNDEFINED_COLUMN = "42703";

/** 건너뛴 이유 */
export const SKIP_REASONS = Object.freeze({
  MANUAL : "retention_manual",
  PENDING: "retention_resume_pending"
});

/** 정책 행 하나가 지금 manual인 조건(정책 표 별칭 rp) */
const MANUAL_ROW = "(rp.auto_lifecycle = FALSE OR (rp.auto_resume_at IS NOT NULL AND rp.auto_resume_at > NOW()))";

let cache = { at: 0, value: null };

/** 담아 둔 범위별 manual 행 유무를 지운다. */
export function invalidateRetentionCache() {
  cache = { at: 0, value: null };
}

/**
 * 범위별 manual 행이 하나라도 있는지. 세기가 실패하면 onError를 돌려준다. 기본은 true(있다고 보고 보존 쪽으로 판정)다.
 *
 * @param {{ now?: number, query?: Function, onError?: (boolean|null) }} [deps]
 * @returns {Promise<boolean|null>}
 */
export async function hasManualScopes({ now = Date.now(), query = defaultQuery, onError = true } = {}) {
  if (cache.value !== null && now - cache.at < CACHE_MS) return cache.value;
  let value;
  try {
    const { rows: [row] } = await query(
      `SELECT EXISTS (SELECT 1 FROM ${SCHEMA}.key_retention_policies rp WHERE ${MANUAL_ROW}) AS any`, []);
    value = row?.any === true;
  } catch (err) {
    if (err?.code === UNDEFINED_TABLE || err?.code === UNDEFINED_COLUMN) value = false;
    else {
      logWarn(`[RetentionGuard] manual scope lookup failed: ${err.message}`);
      return onError;
    }
  }
  cache = { at: now, value };
  return value;
}

function defaultQuery(sql, params) {
  return queryWithAgentVector("system", sql, params);
}

/**
 * 전역 판정. manual이면 이유를 함께 돌려준다.
 *
 * @param {number} [now]
 * @returns {{ manual: boolean, reason: (string|null) }}
 */
export function globalLifecycleState(now = Date.now()) {
  const s = retentionModeSetting(now);
  if (s.mode === "manual") return { manual: true, reason: SKIP_REASONS.MANUAL };
  if (s.pending)           return { manual: true, reason: SKIP_REASONS.PENDING };
  return { manual: false, reason: null };
}

/**
 * 파편 별칭(또는 별칭 없는 질의의 표 이름)을 받아, 그 파편의 범위에 manual 정책 행이 있다는 SQL 조건을 만든다.
 *
 * @param {string} alias 파편 별칭(예: f) 또는 별칭 없는 질의의 표 이름(SCHEMA.fragments)
 * @returns {string}
 */
export function manualScopeExistsSql(alias) {
  return `EXISTS (SELECT 1 FROM ${SCHEMA}.key_retention_policies rp
                   WHERE rp.key_id = ${alias}.key_id
                     AND (rp.workspace IS NULL OR rp.workspace = ${alias}.workspace)
                     AND ${MANUAL_ROW})`;
}

/**
 * 자동 경로가 대상을 고르는 질의의 WHERE 끝에 붙일 조건. 앞에 " AND "가 붙어 있다.
 *   전역 manual       " AND FALSE"(대상 없음)
 *   범위 manual 없음  ""(지금과 같은 SQL)
 *   그 밖             " AND NOT EXISTS(...)"
 *
 * @param {string} alias
 * @param {{ now?: number, query?: Function }} [deps]
 * @returns {Promise<string>}
 */
export async function lifecycleGuardSql(alias, deps = {}) {
  if (globalLifecycleState(deps.now).manual) return " AND FALSE";
  if (!(await hasManualScopes(deps))) return "";
  return ` AND NOT ${manualScopeExistsSql(alias)}`;
}

/**
 * 행 하나를 자동 경로가 지우거나 닫아도 되는지.
 *
 * @param {string|null} keyId
 * @param {string|null} workspace
 * @param {{ now?: number, query?: Function }} [deps]
 * @returns {Promise<boolean>}
 */
export async function isAutoLifecycleAllowed(keyId, workspace, deps = {}) {
  return (await retentionModeFor(keyId, workspace, deps)) === null;
}

/** 조회 실패를 manual로 보는 기본값(정리 경로용) */
const FAIL_AS_MANUAL = Object.freeze({ mode: "manual", source: "key" });

/**
 * 범위의 보존 모드. auto이면 null, manual이면 { mode: "manual", source }를 돌려준다.
 * source는 global, key, workspace 가운데 하나다. 조회가 실패하면 onError를 돌려준다. 기본은 manual(source key)로,
 * 정리 경로가 보존 쪽으로 판정하게 한다. 응답에 모드를 알리는 경로는 onError: null을 줘 조회 실패를 알리지 않는다.
 *
 * @param {string|null} keyId
 * @param {string|null} workspace
 * @param {{ now?: number, query?: Function, onError?: (Object|null) }} [deps]
 * @returns {Promise<{ mode: "manual", source: "global"|"key"|"workspace" }|null>}
 */
export async function retentionModeFor(keyId, workspace, { now = Date.now(), query = defaultQuery, onError = FAIL_AS_MANUAL } = {}) {
  if (globalLifecycleState(now).manual) return { mode: "manual", source: "global" };
  if (!keyId) return null;
  const scoped = await hasManualScopes({ now, query, onError: null });
  if (scoped === null) return onError;
  if (!scoped) return null;
  try {
    const { rows } = await query(
      `SELECT rp.workspace FROM ${SCHEMA}.key_retention_policies rp
        WHERE rp.key_id = $1 AND (rp.workspace IS NULL OR rp.workspace = $2) AND ${MANUAL_ROW}`,
      [keyId, workspace ?? null]);
    if (rows.length === 0) return null;
    return { mode: "manual", source: rows.some(r => r.workspace === null) ? "key" : "workspace" };
  } catch (err) {
    if (err?.code === UNDEFINED_TABLE || err?.code === UNDEFINED_COLUMN) return null;
    logWarn(`[RetentionGuard] scope lookup failed: ${err.message}`);
    return onError;
  }
}

/**
 * 관리 통계용 요약. 전역이 auto이고 범위별 manual 행이 없으면 null이다(통계 응답에 싣지 않는다).
 *
 * @param {{ now?: number, query?: Function }} [deps]
 * @returns {Promise<{ globalMode: string, pending: boolean, autoAfter: (string|null), manualScopes: number,
 *                     manualFragments: (number|null), earliestResumeAt: (string|null) }|null>}
 */
export async function retentionSummary({ now = Date.now(), query = defaultQuery } = {}) {
  const s       = retentionModeSetting(now);
  const scoped  = await hasManualScopes({ now, query, onError: false });
  if (s.effective === "auto" && !scoped) return null;
  let manualScopes = 0, manualFragments = null, earliestResumeAt = null;
  if (scoped) {
    try {
      const { rows: [row] } = await query(
        `SELECT count(*)::int AS scopes,
                min(rp.auto_resume_at) FILTER (WHERE rp.auto_resume_at > NOW()) AS resume_at,
                (SELECT count(*)::int FROM ${SCHEMA}.fragments f
                  WHERE f.valid_to IS NULL AND ${manualScopeExistsSql("f")}) AS fragments
           FROM ${SCHEMA}.key_retention_policies rp
          WHERE ${MANUAL_ROW}`, []);
      manualScopes     = row?.scopes ?? 0;
      manualFragments  = row?.fragments ?? 0;
      earliestResumeAt = row?.resume_at ? new Date(row.resume_at).toISOString() : null;
    } catch (err) {
      logWarn(`[RetentionGuard] summary failed: ${err.message}`);
    }
  }
  return {
    globalMode: s.mode,
    pending   : s.pending,
    autoAfter : s.autoAfter !== null ? new Date(s.autoAfter).toISOString() : null,
    manualScopes,
    manualFragments,
    earliestResumeAt
  };
}
