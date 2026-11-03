// iron-laws: ignore-file[IL-307] null·false·빈 값은 입력 없음이나 조건 불충족을 뜻하는 정상 결과다
/**
 * 키 정책 조회: symbolic hard gate, allowed_workspaces, 외부 전송 정책, 앵커 판정 상태, workspace 별칭
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * 기억 도메인(쓰기 관문, 읽기 허가, 앵커 판정)과 LLM 외부 전송 관문이 키 행에서 읽는 정책 값이다.
 * 관리 API와 CLI가 정책을 바꾸면 lib/keys/invalidation.js가 이 캐시를 함께 지운다.
 */

import { getPrimaryPool }    from "../tools/db.js";
import { logError, logWarn } from "../logger.js";
import { SCHEMA }            from "../memory/schema.js";
import { countLiveAnchors }  from "../memory/read/quotaQueries.js";

/**
 * symbolic_hard_gate 조회 결과 캐시.
 * keyId → { value: boolean, expiresAt: number }
 * TTL: 30초. DB 장애 또는 잦은 SELECT 방지.
 */
const _hardGateCache = new Map();
const HARD_GATE_CACHE_TTL_MS = 30_000;

/**
 * 주어진 key_id의 symbolic_hard_gate 플래그 반환.
 * 캐시 hit 시 0 쿼리. miss 시 1 쿼리 후 30초 TTL 캐시 적재.
 * 존재하지 않는 key_id는 false를 반환하고, DB 오류는 호출자에게 전파한다.
 *
 * @param {string|null} keyId - API 키 UUID. null이면 false 반환 (master 제외).
 * @returns {Promise<boolean>}
 */
export async function getSymbolicHardGate(keyId) {
  if (keyId == null) return false;

  const now    = Date.now();
  const cached = _hardGateCache.get(keyId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  try {
    const pool     = getPrimaryPool();
    const { rows } = await pool.query(
      `SELECT symbolic_hard_gate FROM ${SCHEMA}.api_keys WHERE id = $1`,
      [keyId]
    );
    const value = rows.length > 0 ? Boolean(rows[0].symbolic_hard_gate) : false;
    _hardGateCache.set(keyId, { value, expiresAt: now + HARD_GATE_CACHE_TTL_MS });
    return value;
  } catch (err) {
    logWarn(`[KeyPolicy] getSymbolicHardGate lookup failed for keyId=${keyId}: ${err.message}`);
    throw err;
  }
}

/**
 * 특정 key_id의 symbolic_hard_gate 캐시 항목을 무효화한다.
 * symbolic_hard_gate 변경 직후 즉시 반영이 필요할 때 호출.
 *
 * @param {string} keyId
 */
export function invalidateHardGateCache(keyId) {
  _hardGateCache.delete(keyId);
}

/**
 * allowed_workspaces 조회 결과 캐시.
 * keyId → { value: string[]|null, expiresAt: number }
 * TTL: 30초. DB 장애 또는 잦은 SELECT 방지.
 */
const _allowedWorkspacesCache        = new Map();
const ALLOWED_WORKSPACES_CACHE_TTL_MS = 30_000;

/**
 * 조회 실패를 나타내는 표식.
 *
 * null은 "허용 집합이 지정되지 않음", 즉 제한 없음이라는 확정 판정이다. 조회에
 * 실패해 아무것도 모르는 상태와 구분해야 한다.
 */
export const WORKSPACE_LOOKUP_FAILED = Symbol("workspace_lookup_failed");

/**
 * 주어진 key_id의 allowed_workspaces 배열 반환.
 * NULL이면 워크스페이스 제한 없음(무제한 허용)을 의미한다.
 * 존재하지 않는 key_id 또는 DB 오류 시 null 반환 (fail-open).
 *
 * @param {string|null} keyId - API 키 UUID. null이면 null 반환 (master key는 제한 없음).
 * @returns {Promise<string[]|null>}
 */
export async function getAllowedWorkspaces(keyId) {
  if (keyId == null) return null;

  const now    = Date.now();
  const cached = _allowedWorkspacesCache.get(keyId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  try {
    const pool     = getPrimaryPool();
    const { rows } = await pool.query(
      `SELECT allowed_workspaces FROM ${SCHEMA}.api_keys WHERE id = $1`,
      [keyId]
    );
    const value = rows.length > 0 ? (rows[0].allowed_workspaces ?? null) : null;
    _allowedWorkspacesCache.set(keyId, { value, expiresAt: now + ALLOWED_WORKSPACES_CACHE_TTL_MS });
    return value;
  } catch (err) {
    /**
     * 조회 실패를 무제한 허용으로 뭉개지 않는다. null은 "제한 없음"이라는 확정
     * 판정이고, 여기서는 판정 자체를 못 한 상태다. 둘을 같게 다루면 DB가
     * 흔들릴 때마다 격리가 풀린다.
     */
    logError(`[KeyPolicy] getAllowedWorkspaces 조회 실패 keyId=${keyId}: ${err.message}`);
    return WORKSPACE_LOOKUP_FAILED;
  }
}

/**
 * 특정 key_id의 allowed_workspaces 캐시 항목을 무효화한다.
 *
 * @param {string} keyId
 */
export function invalidateAllowedWorkspacesCache(keyId) {
  _allowedWorkspacesCache.delete(keyId);
}

/**
 * egress_policy 조회 결과 캐시.
 * keyId → { value: object|null, expiresAt: number }
 * TTL: 30초.
 */
const _egressPolicyCache        = new Map();
const EGRESS_POLICY_CACHE_TTL_MS = 30_000;

/**
 * 주어진 key_id의 외부 전송 정책(egress_policy) 원본 값을 반환한다. 검증은 호출자(lib/llm/EgressPolicy.js)가 한다.
 * 행 전체를 jsonb로 바꿔 꺼내므로 열이 아직 없는 설치(migration-055 이전)에서도 오류 없이 null이다.
 * 없는 키와 master(keyId=null)는 null이다. DB 오류는 캐시하지 않고 호출자에게 전파한다.
 *
 * @param {string|null|undefined} keyId
 * @returns {Promise<object|null>}
 */
export async function getEgressPolicy(keyId) {
  if (keyId == null) return null;

  const now    = Date.now();
  const cached = _egressPolicyCache.get(keyId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const { rows } = await getPrimaryPool().query(
    `SELECT to_jsonb(k) -> 'egress_policy' AS egress_policy FROM ${SCHEMA}.api_keys k WHERE k.id = $1`,
    [keyId]
  );
  const value = rows.length > 0 ? (rows[0].egress_policy ?? null) : null;
  _egressPolicyCache.set(keyId, { value, expiresAt: now + EGRESS_POLICY_CACHE_TTL_MS });
  return value;
}

/**
 * 특정 key_id의 egress_policy 캐시 항목을 무효화한다.
 *
 * @param {string} keyId
 */
export function invalidateEgressPolicyCache(keyId) {
  _egressPolicyCache.delete(keyId);
}

/**
 * 파편의 workspace가 키의 allowed_workspaces 허가 집합 내에 있는지 검증한다.
 * workspace 미기입, allowed_workspaces NULL(무제한), master key(keyId=null)는 통과로 취급한다.
 * allowed_workspaces가 빈 배열이면 어떤 workspace 주장도 허가 집합 밖으로 판정한다.
 * 위반이어도 저장을 거부하지 않고 validation_warnings에 실을 경고 객체를 반환한다.
 *
 * @param {string|null} keyId
 * @param {string|null} workspace
 * @returns {Promise<{ rule: string, severity: string, detail: string, ruleVersion: string }|null>}
 */
export async function checkWorkspaceAllowed(keyId, workspace) {
  if (!workspace) return null;

  const allowed = await getAllowedWorkspaces(keyId);
  if (allowed === WORKSPACE_LOOKUP_FAILED) {
    return {
      rule       : "workspaceLookupFailed",
      severity   : "high",
      detail     : "allowed_workspaces 조회에 실패해 workspace 허가 여부를 판정할 수 없다",
      ruleVersion: "v1"
    };
  }
  if (allowed === null)            return null;
  if (allowed.includes(workspace)) return null;

  return {
    rule       : "workspaceNotAllowed",
    severity   : "medium",
    detail     : `workspace '${workspace}' is outside the key's allowed_workspaces set`,
    ruleVersion: "v1"
  };
}

/**
 * 앵커 판정용 키 상태. 권한 목록과 그 키의 살아 있는(valid_to IS NULL) 앵커 수를 읽는다.
 * 앵커 지정 요청마다 부르며 캐시하지 않는다. 키 행이 없으면 null, 조회 오류는 호출자에게 던진다.
 *
 * @param {string} keyId
 * @returns {Promise<{ permissions: string[], anchorCount: number }|null>}
 */
export async function getAnchorState(keyId) {
  const pool     = getPrimaryPool();
  const { rows } = await pool.query(`SELECT permissions FROM ${SCHEMA}.api_keys WHERE id = $1`, [keyId]);
  if (!rows.length) return null;
  return { permissions: rows[0].permissions ?? [], anchorCount: await countLiveAnchors(pool, keyId) };
}


/**
 * workspace 별칭 조회 결과 캐시(key_workspace_aliases, migration-079).
 * keyId → { value: Map<alias, workspace>, expiresAt: number }
 */
const _workspaceAliasCache        = new Map();
const WORKSPACE_ALIAS_CACHE_TTL_MS = 30_000;

/** 정의되지 않은 표(migration-079 전) */
const UNDEFINED_TABLE = "42P01";

/**
 * 키의 workspace 별칭(별칭 → 정식 이름). 마스터(keyId null)와 별칭 없는 키는 빈 Map이다. 조회에 실패하면 경고를
 * 남기고 빈 Map을 돌려주며, 그 결과도 캐시 시간 동안 다시 쓴다. 별칭은 이름을 바꿀 뿐이고 허가 판정(allowed_workspaces)은 바꾼 이름으로 다시 하므로,
 * 실패해도 요청이 받은 이름 그대로 처리될 뿐 범위가 넓어지지 않는다.
 *
 * @param {string|null} keyId
 * @returns {Promise<Map<string, string>>}
 */
export async function getWorkspaceAliases(keyId) {
  if (keyId == null) return new Map();

  const now    = Date.now();
  const cached = _workspaceAliasCache.get(keyId);
  if (cached && cached.expiresAt > now) return cached.value;

  try {
    const { rows } = await getPrimaryPool().query(
      `SELECT alias, workspace FROM ${SCHEMA}.key_workspace_aliases WHERE key_id = $1`, [keyId]
    );
    const value = new Map(rows.map((r) => [r.alias, r.workspace]));
    _workspaceAliasCache.set(keyId, { value, expiresAt: now + WORKSPACE_ALIAS_CACHE_TTL_MS });
    return value;
  } catch (err) {
    if (err.code !== UNDEFINED_TABLE) logWarn(`[KeyPolicy] getWorkspaceAliases lookup failed for keyId=${keyId}: ${err.message}`);
    /** 실패도 같은 시간 동안 기억해 요청마다 다시 조회하지 않는다 */
    const value = new Map();
    _workspaceAliasCache.set(keyId, { value, expiresAt: now + WORKSPACE_ALIAS_CACHE_TTL_MS });
    return value;
  }
}

/**
 * 키 하나의 정책 캐시(hard gate, allowed_workspaces, 외부 전송 정책, workspace 별칭)를 모두 지운다.
 *
 * @param {string} keyId
 */
export function invalidateKeyPolicyCaches(keyId) {
  _hardGateCache.delete(keyId);
  _allowedWorkspacesCache.delete(keyId);
  _egressPolicyCache.delete(keyId);
  _workspaceAliasCache.delete(keyId);
}
