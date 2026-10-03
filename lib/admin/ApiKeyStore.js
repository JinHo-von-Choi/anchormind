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

import { getPrimaryPool }                                        from "../tools/db.js";
import { logError, logWarn }                                     from "../logger.js";
import { DEFAULT_DAILY_LIMIT, DEFAULT_FRAGMENT_LIMIT, DEFAULT_PERMISSIONS } from "../config.js";
import { SCHEMA } from "../memory/schema.js";
import { countLiveFragments } from "../memory/read/quotaQueries.js";
import { recordAuthStoreError, recordApiKeyLookup } from "../metrics.js";
import { KEY_POLICY_FIELDS, isValidPermissionList, PERMISSION_LIST_MESSAGE } from "./key-policy.js";
import { NOT_WM_ROW, deleteWorkingMemoryRowsOfKey } from "../memory/WorkingMemorySql.js";
import { queryWithLifecycle } from "./key-schema-state.js";
import { hashKey, newKeyMaterial } from "./key-material.js";
import {
  evaluateKeyCredential, evaluateKeyState, keyLastUsedIntervalMs, KEY_SECRET_SOURCE, KeyLifecycleConflictError
} from "./key-lifecycle.js";

/**
 * symbolic_hard_gate 조회 결과 캐시.
 * keyId → { value: boolean, expiresAt: number }
 * TTL: 30초. DB 장애 또는 잦은 SELECT 방지.
 */
const _hardGateCache = new Map();
const HARD_GATE_CACHE_TTL_MS = 30_000;

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
 * @param {string[]} permissions  허용 값: read, write, trusted_origin(read 또는 write와 함께)
 * @returns {Promise<{ permissions: string[] }>}
 */
export async function updatePermissions(keyId, permissions) {
  if (!isValidPermissionList(permissions)) {
    throw new Error(PERMISSION_LIST_MESSAGE);
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
 * 목록 질의. lifecycle이 true이면 수명 열과 회전 겹침 종료 시각(아직 유효한 이전 비밀의 가장 늦은
 * valid_until)을 함께 읽는다.
 *
 * @param {boolean} lifecycle
 * @returns {string}
 */
function listKeysSql(lifecycle) {
  const extra = lifecycle
    ? `k.expires_at, k.description, k.owner, k.kind, k.allowed_cidrs, k.revoked_at, k.revoked_by, k.revoke_reason,
      k.access_reviewed_at, k.access_reviewed_by,
      (SELECT max(s.valid_until) FROM ${SCHEMA}.api_key_secrets s
       WHERE s.key_id = k.id AND s.status = 'active' AND s.key_hash <> k.key_hash AND s.valid_until > NOW()) AS rotation_overlap_until,`
    : "";
  return `
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
      k.default_mode,
      k.allowed_workspaces,
      k.symbolic_hard_gate,
      to_jsonb(k) -> 'egress_policy' AS egress_policy,
      ${extra}
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
  `;
}

/**
 * 전체 API 키 목록 조회 (원시 키 미포함)
 * @returns {Promise<Array>}
 */
export async function listApiKeys() {
  const { rows } = await queryWithLifecycle(
    getPrimaryPool(),
    { sql: listKeysSql(true),  params: [] },
    { sql: listKeysSql(false), params: [] }
  );
  return rows;
}

/** createApiKey가 받는 수명 열 */
const CREATE_LIFECYCLE_FIELDS = Object.freeze(["expires_at", "description", "owner", "kind", "allowed_cidrs"]);

/**
 * API 키 생성
 * raw_key 는 이 응답에서만 반환하며 다시 조회할 수 없다.
 * api_keys 행과 api_key_secrets 행을 한 문장으로 쓴다. 수명 스키마가 없는 DB에서는 수명 열 없이
 * api_keys 행만 쓰며, 이때 수명 열 값이 오면 거부한다.
 *
 * @param {{ name: string, permissions?: string[], daily_limit?: number, fragment_limit?: number|null,
 *           expires_at?: string|null, description?: string|null, owner?: string|null, kind?: string|null,
 *           allowed_cidrs?: string[]|null }} opts  수명 열은 validateKeyLifecyclePatch를 통과한 값
 * @returns {Promise<{ id, name, key_prefix, permissions, status, daily_limit, created_at, raw_key }>}
 */
export async function createApiKey({ name, permissions = DEFAULT_PERMISSIONS, daily_limit = DEFAULT_DAILY_LIMIT, fragment_limit = DEFAULT_FRAGMENT_LIMIT, ...lifecycle }) {
  const { rawKey, hash, prefix } = newKeyMaterial(name);
  const values   = CREATE_LIFECYCLE_FIELDS.map((field) => lifecycle[field] ?? null);
  const returned = "id, name, key_prefix, permissions, status, daily_limit, fragment_limit, created_at";

  const { rows } = await queryWithLifecycle(getPrimaryPool(), {
    sql: `
    WITH k AS (
      INSERT INTO ${SCHEMA}.api_keys
        (name, key_hash, key_prefix, permissions, daily_limit, fragment_limit, ${CREATE_LIFECYCLE_FIELDS.join(", ")})
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING ${returned}, key_hash, ${CREATE_LIFECYCLE_FIELDS.join(", ")}
    ), s AS (
      INSERT INTO ${SCHEMA}.api_key_secrets (key_hash, key_id, key_prefix, created_at)
      SELECT key_hash, id, key_prefix, created_at FROM k
    )
    SELECT ${returned}, ${CREATE_LIFECYCLE_FIELDS.join(", ")} FROM k`,
    params: [name, hash, prefix, permissions, daily_limit, fragment_limit, ...values]
  }, values.every((v) => v === null) ? {
    sql: `
    INSERT INTO ${SCHEMA}.api_keys
      (name, key_hash, key_prefix, permissions, daily_limit, fragment_limit)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING ${returned}`,
    params: [name, hash, prefix, permissions, daily_limit, fragment_limit]
  } : null);

  return { ...rows[0], raw_key: rawKey };
}

/**
 * API 키 상태 변경 (active ↔ inactive). 폐기한 키(revoked_at)는 다시 활성화하지 않는다.
 *
 * @param {string} id
 * @param {'active'|'inactive'} status
 */
export async function updateApiKeyStatus(id, status) {
  if (!["active", "inactive"].includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }

  const pool        = getPrimaryPool();
  const { rows, lifecycle } = await queryWithLifecycle(pool, {
    sql: `
    UPDATE ${SCHEMA}.api_keys
    SET    status = $2
    WHERE  id     = $1
      AND  (revoked_at IS NULL OR $2 <> 'active')
    RETURNING id, name, status`,
    params: [id, status]
  }, {
    sql: `
    UPDATE ${SCHEMA}.api_keys
    SET    status = $2
    WHERE  id     = $1
    RETURNING id, name, status`,
    params: [id, status]
  });

  if (rows.length) return rows[0];
  if (lifecycle) {
    const { rows: found } = await pool.query(`SELECT revoked_at FROM ${SCHEMA}.api_keys WHERE id = $1`, [id]);
    if (found.length && found[0].revoked_at) throw new KeyLifecycleConflictError("key_revoked", "Key is revoked");
  }
  throw new Error("Key not found");
}

/**
 * API 키가 저장 자료를 가지고 있어 삭제할 수 없을 때의 오류.
 * 파편이나 링크 재공고화 이력이 남은 키는 비활성화(status=inactive)로 운영한다.
 */
export class ApiKeyInUseError extends Error {
  /**
   * @param {{ fragments: number, reconsolidations: number }} usage
   */
  constructor(usage) {
    super("Key has stored data");
    this.name             = "ApiKeyInUseError";
    this.code             = "key_in_use";
    this.fragments        = usage.fragments;
    this.reconsolidations = usage.reconsolidations;
  }
}

/**
 * 키 삭제 전 저장 자료 확인 여부. 기본 true, "false"면 확인 없이 삭제한다.
 *
 * @returns {boolean}
 */
export function isApiKeyDeleteGuardEnabled() {
  return process.env.MEMENTO_API_KEY_DELETE_GUARD !== "false";
}

/**
 * API 키 삭제 (+ cascade로 usage 행 삭제)
 *
 * 확인이 켜져 있으면 키 행을 잠근 뒤 그 키의 파편(유효, 닫힘 모두. 작업 기억 행은 제외)과
 * 링크 재공고화 이력을 세고, 하나라도 있으면 ApiKeyInUseError를 던진다. 키 행 잠금은 같은 키로
 * 들어오는 파편 INSERT의 외래 키 확인과 직렬화되므로 확인과 삭제 사이에 파편이
 * 새로 생기지 않는다. 키를 지우기 전에 그 키의 작업 기억 행을 먼저 지워 key_id가 비어 남는
 * 행이 없게 한다.
 *
 * @param {string} id
 */
export async function deleteApiKey(id) {
  const pool = getPrimaryPool();
  if (!isApiKeyDeleteGuardEnabled()) {
    await deleteWorkingMemoryRowsOfKey(pool, id);
    const { rowCount } = await pool.query(
      `DELETE FROM ${SCHEMA}.api_keys WHERE id = $1`,
      [id]
    );
    if (!rowCount) throw new Error("Key not found");
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: keyRows } = await client.query(
      `SELECT id FROM ${SCHEMA}.api_keys WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!keyRows.length) throw new Error("Key not found");

    const { rows: [usage] } = await client.query(
      `SELECT (SELECT count(*) FROM ${SCHEMA}.fragments             WHERE key_id = $1 AND ${NOT_WM_ROW})::int AS fragments,
              (SELECT count(*) FROM ${SCHEMA}.link_reconsolidations WHERE key_id = $1)::int AS reconsolidations`,
      [id]
    );
    if (usage.fragments > 0 || usage.reconsolidations > 0) {
      throw new ApiKeyInUseError(usage);
    }

    await deleteWorkingMemoryRowsOfKey(client, id);
    await client.query(`DELETE FROM ${SCHEMA}.api_keys WHERE id = $1`, [id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(rollbackErr =>
      logWarn(`[ApiKeyStore] deleteApiKey rollback failed: ${rollbackErr.message}`));
    throw err;
  } finally {
    client.release();
  }
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

/** 정책 편집 응답과 감사 비교에 항상 싣는 열. 그 밖의 정책 열(egress_policy)은 바꿀 때만 읽는다. */
const BASE_POLICY_COLUMNS = Object.freeze(["default_mode", "allowed_workspaces", "symbolic_hard_gate"]);

/**
 * API 키 정책 열(default_mode, allowed_workspaces, symbolic_hard_gate, egress_policy) 변경.
 * 전달된 필드만 한 문장으로 갱신하고, 같은 문장에서 행 잠금 아래 읽은 변경 전 값을 함께 돌려준다.
 * egress_policy는 요청에 있을 때만 읽고 쓰므로, 열이 아직 없는 설치(migration-055 이전)에서도
 * 다른 세 열의 편집은 그대로 동작한다.
 *
 * @param {string} keyId
 * @param {{ default_mode?: string|null, allowed_workspaces?: string[]|null, symbolic_hard_gate?: boolean, egress_policy?: object|null }} patch
 *        key-policy.js의 validateKeyPolicyPatch를 통과한 값
 * @returns {Promise<{ before: object, after: object }>}
 */
export async function updateKeyPolicy(keyId, patch) {
  const fields = KEY_POLICY_FIELDS.filter((field) => Object.hasOwn(patch, field));
  if (fields.length === 0) throw new Error("policy patch has no fields");

  const columns     = [...new Set([...BASE_POLICY_COLUMNS, ...fields])];
  const assignments = fields.map((field, i) => `${field} = $${i + 2}`).join(", ");
  const pool        = getPrimaryPool();
  const { rows }    = await pool.query(
    `WITH prev AS (
       SELECT id, ${columns.join(", ")}
       FROM   ${SCHEMA}.api_keys
       WHERE  id = $1
       FOR UPDATE
     )
     UPDATE ${SCHEMA}.api_keys k
     SET    ${assignments}
     FROM   prev
     WHERE  k.id = prev.id
     RETURNING ${columns.map((c) => `prev.${c} AS prev_${c}`).join(", ")},
               ${columns.map((c) => `k.${c}`).join(", ")}`,
    [keyId, ...fields.map((field) => patch[field])]
  );
  if (!rows.length) throw new Error("Key not found");

  const row    = rows[0];
  const before = {};
  const after  = {};
  for (const column of columns) {
    before[column] = row[`prev_${column}`] ?? null;
    after[column]  = row[column] ?? null;
  }
  return { before, after };
}

/**
 * 원시 키로 DB 인증 검증 (MCP 요청 인증 fallback용)
 *
 * @param {string} rawKey
 * @returns {Promise<{ valid: boolean, keyId?: string, name?: string, permissions?: string[], allowedCidrs?: string[]|null, reason?: string }>}
 */
export async function validateApiKeyFromDB(rawKey) {
  try {
    return await lookupApiKeyByHash(hashKey(rawKey));
  } catch (err) {
    recordAuthStoreError("validate_raw_key");
    logError(`[ApiKey] key lookup failed (code=${err.code ?? "none"})`, err);
    throw err;
  }
}

/** 원시 키 판정에 쓰는 키 열 */
const KEY_DECISION_COLUMNS = `
      k.id,
      k.name,
      k.permissions,
      k.status,
      k.daily_limit,
      k.fragment_limit,
      k.default_workspace,
      k.default_mode,`;

/**
 * 원시 키 조회(수명 판). api_key_secrets의 해시 행을 먼저 쓰고, 그 해시가 비밀 표에 없을 때만
 * api_keys.key_hash 행을 쓴다(이중 읽기). 두 출처는 한 문장 안에서 서로 배타다.
 */
const LOOKUP_BY_HASH_SQL = `
    SELECT ${KEY_DECISION_COLUMNS}
      k.expires_at,
      k.revoked_at,
      k.allowed_cidrs,
      c.source      AS secret_source,
      c.status      AS secret_status,
      c.valid_until AS secret_valid_until,
      COALESCE(u.call_count, 0) AS usage_today
    FROM (
      SELECT s.key_id, '${KEY_SECRET_SOURCE.SECRET}' AS source, s.status, s.valid_until
      FROM   ${SCHEMA}.api_key_secrets s
      WHERE  s.key_hash = $1
      UNION ALL
      SELECT l.id, '${KEY_SECRET_SOURCE.LEGACY}', NULL::text, NULL::timestamptz
      FROM   ${SCHEMA}.api_keys l
      WHERE  l.key_hash = $1
        AND  NOT EXISTS (SELECT 1 FROM ${SCHEMA}.api_key_secrets x WHERE x.key_hash = $1)
    ) c
    JOIN ${SCHEMA}.api_keys k ON k.id = c.key_id
    LEFT JOIN ${SCHEMA}.api_key_usage u
      ON  u.key_id = k.id
      AND u.usage_date = CURRENT_DATE
    LIMIT 1
  `;

/** 원시 키 조회(기본 판: 수명 스키마가 없는 DB) */
const LEGACY_LOOKUP_BY_HASH_SQL = `
    SELECT ${KEY_DECISION_COLUMNS}
      COALESCE(u.call_count, 0) AS usage_today
    FROM  ${SCHEMA}.api_keys k
    LEFT JOIN ${SCHEMA}.api_key_usage u
      ON  u.key_id = k.id
      AND u.usage_date = CURRENT_DATE
    WHERE k.key_hash = $1
  `;

/**
 * key_hash로 키와 오늘 사용량을 조회해 판정한다.
 *
 * @param {string} hash
 * @returns {Promise<{ valid: boolean, keyId?: string, name?: string, permissions?: string[], reason?: string }>}
 */
async function lookupApiKeyByHash(hash) {
  const { rows } = await queryWithLifecycle(
    getPrimaryPool(),
    { sql: LOOKUP_BY_HASH_SQL,        params: [hash] },
    { sql: LEGACY_LOOKUP_BY_HASH_SQL, params: [hash] }
  );
  if (!rows.length) return { valid: false };

  const key = { secret_source: KEY_SECRET_SOURCE.LEGACY, ...rows[0] };
  recordApiKeyLookup(key.secret_source);
  const verdict = evaluateKeyCredential(key, Date.now());
  if (!verdict.valid) return verdict;

  const groupKeyIds = await getGroupKeyIds(key.id);

  return { valid: true, keyId: key.id, name: key.name ?? null, groupKeyIds, permissions: key.permissions, fragmentLimit: key.fragment_limit, defaultWorkspace: key.default_workspace ?? null, defaultMode: key.default_mode ?? null, allowedCidrs: key.allowed_cidrs ?? null };
}

/** id 조회 열(기본 판) */
const KEY_BY_ID_COLUMNS = "id, name, key_prefix, permissions, status, default_workspace, default_mode";

/**
 * UUID(id)로 API 키 조회 (OAuth bound_key_id 경로 전용)
 * raw key 없이 keyId만으로 권한 정보를 조회한다. 폐기, 비활성, 만료 키는 사유와 함께 무효다.
 * 조회 자체가 실패하면 reason "store_unavailable"로 키 무효와 구분한다.
 */
export async function validateApiKeyById(id) {
  if (!id) return { valid: false };
  try {
    const { rows } = await queryWithLifecycle(
      getPrimaryPool(),
      { sql: `SELECT ${KEY_BY_ID_COLUMNS}, expires_at, revoked_at, allowed_cidrs FROM ${SCHEMA}.api_keys WHERE id = $1`, params: [id] },
      { sql: `SELECT ${KEY_BY_ID_COLUMNS} FROM ${SCHEMA}.api_keys WHERE id = $1`, params: [id] }
    );

    if (!rows.length)                return { valid: false };
    const key     = rows[0];
    const verdict = evaluateKeyState(key, Date.now());
    if (!verdict.valid)              return verdict;

    const groupKeyIds = await getGroupKeyIds(key.id);
    return { valid: true, keyId: key.id, name: key.name ?? null, groupKeyIds, permissions: key.permissions, defaultWorkspace: key.default_workspace ?? null, defaultMode: key.default_mode ?? null, allowedCidrs: key.allowed_cidrs ?? null };
  } catch (err) {
    recordAuthStoreError("validate_by_id");
    logError(`[ApiKey] key lookup by id failed (code=${err.code ?? "none"})`, err);
    return { valid: false, reason: "store_unavailable" };
  }
}

/**
 * 세션 재확인용 키 상태 조회.
 * 행이 없으면 exists=false. 조회 오류는 호출자에게 던진다.
 * 수명 스키마가 있으면 폐기 시각, 만료 시각, 허용 대역을 함께 돌려준다.
 *
 * @param {string} keyId
 * @returns {Promise<{ exists: boolean, status: string|null, permissions: string[]|null,
 *                     revokedAt?: Date|null, expiresAt?: Date|null, allowedCidrs?: string[]|null }>}
 */
export async function getKeyAuthState(keyId) {
  const { rows, lifecycle } = await queryWithLifecycle(
    getPrimaryPool(),
    { sql: `SELECT status, permissions, revoked_at, expires_at, allowed_cidrs FROM ${SCHEMA}.api_keys WHERE id = $1`, params: [keyId] },
    { sql: `SELECT status, permissions FROM ${SCHEMA}.api_keys WHERE id = $1`, params: [keyId] }
  );
  if (!rows.length) return { exists: false, status: null, permissions: null };
  const state = { exists: true, status: rows[0].status, permissions: rows[0].permissions ?? null };
  if (!lifecycle) return state;
  return { ...state, revokedAt: rows[0].revoked_at ?? null, expiresAt: rows[0].expires_at ?? null, allowedCidrs: rows[0].allowed_cidrs ?? null };
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

/** keyId별 마지막 사용 기록 시각(ms). 간격 안의 요청은 마지막 사용 열을 다시 쓰지 않는다. */
const lastUsedWrittenAt   = new Map();
const LAST_USED_CACHE_MAX = 10_000;

/** 마지막 사용 기록 간격 상태를 비운다(시험용). */
export function resetLastUsedThrottle() {
  lastUsedWrittenAt.clear();
}

/**
 * 이 요청에서 마지막 사용 열을 쓸지 정하고, 쓰면 시각을 기록한다.
 *
 * @param {string} keyId
 * @param {number} now
 * @returns {boolean}
 */
function claimLastUsedWrite(keyId, now) {
  const interval = keyLastUsedIntervalMs();
  const last     = lastUsedWrittenAt.get(keyId);
  if (interval > 0 && last !== undefined && now - last < interval) return false;
  lastUsedWrittenAt.delete(keyId);
  lastUsedWrittenAt.set(keyId, now);
  if (lastUsedWrittenAt.size > LAST_USED_CACHE_MAX) lastUsedWrittenAt.delete(lastUsedWrittenAt.keys().next().value);
  return true;
}

/**
 * 사용량 증가 — fire-and-forget (인증 경로 지연 방지)
 * 일일 사용량은 요청마다 더한다. 마지막 사용 시각과 주소 지문(last_used_ip_hash)은 한 문장으로,
 * 키마다 MEMENTO_KEY_LAST_USED_INTERVAL_SEC(기본 60초)에 한 번만 쓴다.
 *
 * @param {string} keyId
 * @param {string|null} [clientIpHash]  요청 주소 지문(key-lifecycle.hashClientIp). 없으면 이전 값을 둔다
 */
export function incrementUsage(keyId, clientIpHash = null) {
  const pool = getPrimaryPool();

  pool.query(`
    INSERT INTO ${SCHEMA}.api_key_usage (key_id, usage_date, call_count)
    VALUES ($1, CURRENT_DATE, 1)
    ON CONFLICT (key_id, usage_date)
    DO UPDATE SET call_count = api_key_usage.call_count + 1
  `, [keyId]).catch(err =>
    logError("[ApiKey] increment usage error:", err)
  );

  if (!claimLastUsedWrite(keyId, Date.now())) return;
  queryWithLifecycle(
    pool,
    { sql: `UPDATE ${SCHEMA}.api_keys SET last_used_at = NOW(), last_used_ip_hash = COALESCE($2, last_used_ip_hash) WHERE id = $1`, params: [keyId, clientIpHash] },
    { sql: `UPDATE ${SCHEMA}.api_keys SET last_used_at = NOW() WHERE id = $1`, params: [keyId] }
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
    logWarn(`[ApiKeyStore] getSymbolicHardGate lookup failed for keyId=${keyId}: ${err.message}`);
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
