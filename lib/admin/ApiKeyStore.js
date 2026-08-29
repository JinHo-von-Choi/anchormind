/**
 * Admin: API 키 저장소
 *
 * 작성자: 최진호
 * 작성일: 2026-03-03
 *
 * 보안 원칙:
 * - 원시 키(raw key)는 생성 시 단 1회만 반환, DB에는 SHA-256 해시만 저장
 * - key_prefix(앞 14자)는 UI 표시 전용
 * - incrementUsage는 fire-and-forget (인증 경로 지연 최소화)
 */

import { createHash, randomBytes }                              from "node:crypto";
import { getPrimaryPool }                                        from "../tools/db.js";
import { logError, logWarn }                                     from "../logger.js";
import { DEFAULT_DAILY_LIMIT, DEFAULT_FRAGMENT_LIMIT, DEFAULT_PERMISSIONS } from "../config.js";
import { SCHEMA } from "../memory/schema.js";
import { countLiveFragments } from "../memory/read/quotaQueries.js";

/**
 * symbolic_hard_gate 조회 결과 캐시.
 * keyId → { value: boolean, expiresAt: number }
 * TTL: 30초. DB 장애 또는 잦은 SELECT 방지.
 */
const _hardGateCache = new Map();
const HARD_GATE_CACHE_TTL_MS = 30_000;

/** SHA-256 해시 */
function hashKey(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * 새 원시 키 생성
 * 형식: mmcp_<8자 슬러그>_<32 hex chars>
 */
function generateRawKey(name) {
  const slug   = name.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase() || "key";
  const random = randomBytes(16).toString("hex");
  return `mmcp_${slug}_${random}`;
}

/** ─── 공개 API ────────────────────────────────────────── */

/**
 * 특정 API 키에 할당된 활성 파편 수 조회
 *
 * @param {string} keyId
 * @returns {Promise<number>}
 */
export async function getFragmentCount(keyId) {
  return countLiveFragments(getPrimaryPool(), keyId);
}

/**
 * API 키의 파편 할당량 상한 변경
 *
 * @param {string} keyId
 * @param {number|null} limit  null 이면 무제한
 * @returns {Promise<boolean>}
 */
export async function updateFragmentLimit(keyId, limit) {
  const pool          = getPrimaryPool();
  const { rowCount }  = await pool.query(
    `UPDATE ${SCHEMA}.api_keys SET fragment_limit = $1 WHERE id = $2`,
    [limit, keyId]
  );
  return rowCount > 0;
}

/**
 * API 키의 일일 호출 한도 변경
 * @param {string} keyId
 * @param {number} limit  양의 정수 (1 이상)
 * @returns {Promise<{ daily_limit: number }>}
 */
export async function updateDailyLimit(keyId, limit) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("daily_limit must be a positive integer");
  }
  const pool         = getPrimaryPool();
  const { rowCount, rows } = await pool.query(
    `UPDATE ${SCHEMA}.api_keys SET daily_limit = $1 WHERE id = $2
     RETURNING daily_limit`,
    [limit, keyId]
  );
  if (!rowCount) throw new Error("Key not found");
  return rows[0];
}

/**
 * API 키의 권한 변경
 * @param {string} keyId
 * @param {string[]} permissions  허용 값: read, write
 * @returns {Promise<{ permissions: string[] }>}
 */
export async function updatePermissions(keyId, permissions) {
  const valid = ["read", "write"];
  if (!Array.isArray(permissions) || !permissions.every(p => valid.includes(p))) {
    throw new Error("permissions must be an array of 'read' and/or 'write'");
  }
  const pool = getPrimaryPool();
  const { rowCount, rows } = await pool.query(
    `UPDATE ${SCHEMA}.api_keys SET permissions = $1 WHERE id = $2 RETURNING permissions`,
    [permissions, keyId]
  );
  if (!rowCount) throw new Error("Key not found");
  return rows[0];
}

/**
 * 전체 API 키 목록 조회 (원시 키 미포함)
 * @returns {Promise<Array>}
 */
export async function listApiKeys() {
  const pool        = getPrimaryPool();
  const { rows }    = await pool.query(`
    SELECT
      k.id,
      k.name,
      k.key_prefix,
      k.permissions,
      k.status,
      k.daily_limit,
      k.fragment_limit,
      k.last_used_at,
      k.created_at,
      k.default_workspace,
      COALESCE(u.call_count, 0) AS usage_today,
      (SELECT COUNT(*) FROM ${SCHEMA}.fragments f
       WHERE f.key_id = k.id AND f.valid_to IS NULL)::int AS fragment_count,
      COALESCE(
        (SELECT json_agg(json_build_object('id', g.id, 'name', g.name))
         FROM ${SCHEMA}.api_key_group_members m
         JOIN ${SCHEMA}.api_key_groups g ON g.id = m.group_id
         WHERE m.key_id = k.id),
        '[]'::json
      ) AS groups
    FROM  ${SCHEMA}.api_keys k
    LEFT JOIN ${SCHEMA}.api_key_usage u
      ON  u.key_id = k.id
      AND u.usage_date = CURRENT_DATE
    ORDER BY k.created_at DESC
  `);
  return rows;
}

/**
 * API 키 생성
 * raw_key 는 이 응답에서만 반환 — 이후 재조회 불가
 *
 * @param {{ name: string, permissions?: string[], daily_limit?: number }} opts
 * @returns {Promise<{ id, name, key_prefix, permissions, status, daily_limit, created_at, raw_key }>}
 */
export async function createApiKey({ name, permissions = DEFAULT_PERMISSIONS, daily_limit = DEFAULT_DAILY_LIMIT, fragment_limit = DEFAULT_FRAGMENT_LIMIT }) {
  const pool          = getPrimaryPool();
  const rawKey        = generateRawKey(name);
  const hash          = hashKey(rawKey);
  const prefix        = rawKey.slice(0, 14);

  const { rows }      = await pool.query(`
    INSERT INTO ${SCHEMA}.api_keys
      (name, key_hash, key_prefix, permissions, daily_limit, fragment_limit)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, name, key_prefix, permissions, status, daily_limit, fragment_limit, created_at
  `, [name, hash, prefix, permissions, daily_limit, fragment_limit]);

  return { ...rows[0], raw_key: rawKey };
}

/**
 * API 키 상태 변경 (active ↔ inactive)
 *
 * @param {string} id
 * @param {'active'|'inactive'} status
 */
export async function updateApiKeyStatus(id, status) {
  if (!["active", "inactive"].includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }

  const pool        = getPrimaryPool();
  const { rows }    = await pool.query(`
    UPDATE ${SCHEMA}.api_keys
    SET    status = $2
    WHERE  id     = $1
    RETURNING id, name, status
  `, [id, status]);

  if (!rows.length) throw new Error("Key not found");
  return rows[0];
}

/**
 * API 키 삭제 (+ cascade로 usage 행 삭제)
 *
 * @param {string} id
 */
export async function deleteApiKey(id) {
  const pool          = getPrimaryPool();
  const { rowCount }  = await pool.query(
    `DELETE FROM ${SCHEMA}.api_keys WHERE id = $1`,
    [id]
  );
  if (!rowCount) throw new Error("Key not found");
}

/**
 * API 키의 기본 워크스페이스 변경
 * @param {string} keyId
 * @param {string|null} workspace  null 이면 기본 workspace 해제
 * @returns {Promise<{ default_workspace: string|null }>}
 */
export async function updateWorkspace(keyId, workspace) {
  if (workspace !== null && (typeof workspace !== "string" || workspace.trim() === "")) {
    throw new Error("workspace must be a non-empty string or null");
  }
  const pool = getPrimaryPool();
  const { rowCount, rows } = await pool.query(
    `UPDATE ${SCHEMA}.api_keys SET default_workspace = $1 WHERE id = $2
     RETURNING default_workspace`,
    [workspace, keyId]
  );
  if (!rowCount) throw new Error("Key not found");
  return rows[0];
}

/**
 * 원시 키로 DB 인증 검증 (MCP 요청 인증 fallback용)
 *
 * @param {string} rawKey
 * @returns {Promise<{ valid: boolean, keyId?: string, name?: string, permissions?: string[], reason?: string }>}
 */
export async function validateApiKeyFromDB(rawKey) {
  const pool        = getPrimaryPool();
  const hash        = hashKey(rawKey);

  const { rows }    = await pool.query(`
    SELECT
      k.id,
      k.name,
      k.permissions,
      k.status,
      k.daily_limit,
      k.fragment_limit,
      k.default_workspace,
      k.default_mode,
      COALESCE(u.call_count, 0) AS usage_today
    FROM  ${SCHEMA}.api_keys k
    LEFT JOIN ${SCHEMA}.api_key_usage u
      ON  u.key_id = k.id
      AND u.usage_date = CURRENT_DATE
    WHERE k.key_hash = $1
  `, [hash]);

  if (!rows.length)                           return { valid: false };

  const key = rows[0];
  if (key.status !== "active")                return { valid: false, reason: "inactive" };
  if (key.usage_today >= key.daily_limit)     return { valid: false, reason: "limit_exceeded" };

  const groupKeyIds = await getGroupKeyIds(key.id);

  return { valid: true, keyId: key.id, name: key.name ?? null, groupKeyIds, permissions: key.permissions, fragmentLimit: key.fragment_limit, defaultWorkspace: key.default_workspace ?? null, defaultMode: key.default_mode ?? null };
}

/**
 * UUID(id)로 API 키 조회 (OAuth bound_key_id 경로 전용)
 * raw key 없이 keyId만으로 권한 정보를 조회한다.
 */
export async function validateApiKeyById(id) {
  if (!id) return { valid: false };
  try {
    const pool     = getPrimaryPool();
    const { rows } = await pool.query(`
      SELECT id, name, key_prefix, permissions, status, default_workspace, default_mode
      FROM ${SCHEMA}.api_keys
      WHERE id = $1
    `, [id]);

    if (!rows.length)                return { valid: false };
    const key = rows[0];
    if (key.status !== "active")     return { valid: false, reason: "inactive" };

    const groupKeyIds = await getGroupKeyIds(key.id);
    return { valid: true, keyId: key.id, name: key.name ?? null, groupKeyIds, permissions: key.permissions, defaultWorkspace: key.default_workspace ?? null, defaultMode: key.default_mode ?? null };
  } catch {
    return { valid: false };
  }
}

/**
 * keyId로 그룹 멤버 keyIds 배열 조회 (raw key 없이).
 * 그룹 미소속 시 [keyId] 단독 반환. 키 자체가 없으면 null 반환.
 *
 * @param {string|null} keyId
 * @returns {Promise<string[]|null>}
 */
export async function getGroupKeyIds(keyId) {
  if (!keyId) return null;
  const pool = getPrimaryPool();
  const { rows } = await pool.query(`
    SELECT DISTINCT m2.key_id
    FROM   ${SCHEMA}.api_key_group_members m1
    JOIN   ${SCHEMA}.api_key_group_members m2 ON m1.group_id = m2.group_id
    WHERE  m1.key_id = $1
  `, [keyId]);
  return rows.length > 0 ? rows.map(r => r.key_id) : [keyId];
}

/**
 * 사용량 증가 — fire-and-forget (인증 경로 지연 방지)
 *
 * @param {string} keyId
 */
export function incrementUsage(keyId) {
  const pool = getPrimaryPool();

  pool.query(`
    INSERT INTO ${SCHEMA}.api_key_usage (key_id, usage_date, call_count)
    VALUES ($1, CURRENT_DATE, 1)
    ON CONFLICT (key_id, usage_date)
    DO UPDATE SET call_count = api_key_usage.call_count + 1
  `, [keyId]).catch(err =>
    logError("[ApiKey] increment usage error:", err)
  );

  pool.query(
    `UPDATE ${SCHEMA}.api_keys SET last_used_at = NOW() WHERE id = $1`,
    [keyId]
  ).catch(err =>
    logError("[ApiKey] last_used_at update error:", err)
  );
}

/** ─── 그룹 API ────────────────────────────────────────── */

export async function listKeyGroups() {
  const pool     = getPrimaryPool();
  const { rows } = await pool.query(`
    SELECT g.id, g.name, g.description, g.created_at,
           COUNT(m.key_id)::int AS member_count
    FROM   ${SCHEMA}.api_key_groups g
    LEFT JOIN ${SCHEMA}.api_key_group_members m ON m.group_id = g.id
    GROUP BY g.id
    ORDER BY g.created_at DESC
  `);
  return rows;
}

export async function createKeyGroup({ name, description = null }) {
  const pool     = getPrimaryPool();
  const { rows } = await pool.query(`
    INSERT INTO ${SCHEMA}.api_key_groups (name, description)
    VALUES ($1, $2)
    RETURNING id, name, description, created_at
  `, [name, description]);
  return rows[0];
}

export async function deleteKeyGroup(id) {
  const pool         = getPrimaryPool();
  const { rowCount } = await pool.query(
    `DELETE FROM ${SCHEMA}.api_key_groups WHERE id = $1`,
    [id]
  );
  if (!rowCount) throw new Error("Group not found");
}

export async function addKeyToGroup(keyId, groupId) {
  const pool = getPrimaryPool();
  await pool.query(`
    INSERT INTO ${SCHEMA}.api_key_group_members (group_id, key_id)
    VALUES ($1, $2)
    ON CONFLICT (group_id, key_id) DO NOTHING
  `, [groupId, keyId]);
  return { keyId, groupId, added: true };
}

export async function removeKeyFromGroup(keyId, groupId) {
  const pool         = getPrimaryPool();
  const { rowCount } = await pool.query(`
    DELETE FROM ${SCHEMA}.api_key_group_members
    WHERE group_id = $1 AND key_id = $2
  `, [groupId, keyId]);
  return { keyId, groupId, removed: rowCount > 0 };
}

export async function getGroupMembers(groupId) {
  const pool     = getPrimaryPool();
  const { rows } = await pool.query(`
    SELECT k.id, k.name, k.key_prefix, k.status, m.joined_at
    FROM   ${SCHEMA}.api_key_group_members m
    JOIN   ${SCHEMA}.api_keys k ON k.id = m.key_id
    WHERE  m.group_id = $1
    ORDER BY m.joined_at ASC
  `, [groupId]);
  return rows;
}

/**
 * 주어진 key_id의 symbolic_hard_gate 플래그 반환.
 * 캐시 hit 시 0 쿼리. miss 시 1 쿼리 후 30초 TTL 캐시 적재.
 * 존재하지 않는 key_id 또는 DB 오류 시 false 반환 (fail-open).
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
    logWarn(`[ApiKeyStore] getSymbolicHardGate fail-open for keyId=${keyId}: ${err.message}`);
    return false;
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
    logError(`[ApiKeyStore] getAllowedWorkspaces 조회 실패 keyId=${keyId}: ${err.message}`);
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
