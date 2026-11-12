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
import { countLiveFragments, countGroupLiveFragments } from "../memory/read/quotaQueries.js";
import { recordAuthStoreError, recordApiKeyLookup } from "../metrics.js";
import { KEY_POLICY_FIELDS, isValidPermissionList, PERMISSION_LIST_MESSAGE } from "./key-policy.js";
import { NOT_WM_ROW, deleteWorkingMemoryRowsOfKey } from "../memory/WorkingMemorySql.js";
import { queryWithLifecycle } from "./key-schema-state.js";
import { getGroupAccess } from "./group-access.js";
import { hashKey, newKeyMaterial } from "./key-material.js";
import {
  evaluateKeyCredential, evaluateKeyState, keyLastUsedIntervalMs, KEY_SECRET_SOURCE, KeyLifecycleConflictError
} from "./key-lifecycle.js";
import { beginScoped, queryScoped, ROW_SUBJECT } from "../tools/row-scope.js";

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
 * API 키의 권한 변경. 같은 문장에서 행 잠금 아래 읽은 변경 전 권한을 함께 돌려준다.
 * @param {string} keyId
 * @param {string[]} permissions  허용 값: read, write와 표지 권한(trusted_origin, anchor, review_off, review_all). isValidPermissionList 규칙
 * @returns {Promise<{ permissions: string[], before: string[] }>}
 */
export async function updatePermissions(keyId, permissions) {
  if (!isValidPermissionList(permissions)) {
    throw new Error(PERMISSION_LIST_MESSAGE);
  }
  const pool = getPrimaryPool();
  const { rowCount, rows } = await pool.query(
    `WITH prev AS (
       SELECT id, permissions
       FROM   ${SCHEMA}.api_keys
       WHERE  id = $2
       FOR UPDATE
     )
     UPDATE ${SCHEMA}.api_keys k
     SET    permissions = $1
     FROM   prev
     WHERE  k.id = prev.id
     RETURNING prev.permissions AS prev_permissions, k.permissions`,
    [permissions, keyId]
  );
  if (!rowCount) throw new Error("Key not found");
  return { permissions: rows[0].permissions, before: rows[0].prev_permissions };
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
    const { rowCount } = await queryScoped(pool,
      `DELETE FROM ${SCHEMA}.api_keys WHERE id = $1`,
      [id], ROW_SUBJECT.ADMIN
    );
    if (!rowCount) throw new Error("Key not found");
    return;
  }

  const client = await pool.connect();
  try {
    await beginScoped(pool, client, { subject: ROW_SUBJECT.ADMIN });
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

  const { groupKeyIds, groupGrants, groupShareScopes } = await getGroupAccess(key.id);

  return { valid: true, keyId: key.id, name: key.name ?? null, groupKeyIds, groupGrants, groupShareScopes, permissions: key.permissions, fragmentLimit: key.fragment_limit, defaultWorkspace: key.default_workspace ?? null, defaultMode: key.default_mode ?? null, allowedCidrs: key.allowed_cidrs ?? null };
}

/**
 * 키의 현재가 아닌 비밀 행의 겹침 종료 시각(최근 20개). 지난 시각보다 먼저 만든 세션과 OAuth 토큰을 끝내는 데 쓴다
 * (key-lifecycle.isAccessRetired). 별칭 k가 api_keys다.
 */
const SECRET_RETIREMENTS_SQL = `ARRAY(SELECT s.valid_until FROM ${SCHEMA}.api_key_secrets s WHERE s.key_id = k.id AND s.key_hash <> k.key_hash
                AND s.valid_until IS NOT NULL ORDER BY s.valid_until DESC LIMIT 20) AS secret_retirements`;

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
      { sql: `SELECT k.id, k.name, k.key_prefix, k.permissions, k.status, k.default_workspace, k.default_mode, k.expires_at, k.revoked_at, k.allowed_cidrs, ${SECRET_RETIREMENTS_SQL}
              FROM ${SCHEMA}.api_keys k WHERE k.id = $1`, params: [id] },
      { sql: `SELECT ${KEY_BY_ID_COLUMNS} FROM ${SCHEMA}.api_keys WHERE id = $1`, params: [id] }
    );

    if (!rows.length)                return { valid: false };
    const key     = rows[0];
    const verdict = evaluateKeyState(key, Date.now());
    if (!verdict.valid)              return verdict;

    const { groupKeyIds, groupGrants, groupShareScopes } = await getGroupAccess(key.id);
    return { valid: true, keyId: key.id, name: key.name ?? null, groupKeyIds, groupGrants, groupShareScopes, permissions: key.permissions, defaultWorkspace: key.default_workspace ?? null, defaultMode: key.default_mode ?? null, allowedCidrs: key.allowed_cidrs ?? null, secretRetirements: key.secret_retirements ?? [] };
  } catch (err) {
    recordAuthStoreError("validate_by_id");
    logError(`[ApiKey] key lookup by id failed (code=${err.code ?? "none"})`, err);
    return { valid: false, reason: "store_unavailable" };
  }
}

/**
 * 키 상태에 실을 그룹 접근. 그룹 조회가 실패해도 키 상태(폐기, 비활성 판정)는 돌려줘야 하므로 실패하면 빈 객체다.
 * 그때 세션은 저장된 그룹 목록을 그대로 쓴다(key-identity.identityFromKeyState).
 *
 * @param {string} keyId
 * @returns {Promise<{ groupKeyIds?: string[], groupGrants?: object }>}
 */
async function groupAccessOrNothing(keyId) {
  try {
    return await getGroupAccess(keyId);
  } catch (err) {
    logWarn(`[ApiKey] group access lookup failed for key state (code=${err.code ?? "none"}): ${err.message}`);
    return {};
  }
}

/**
 * 세션 재확인용 키 상태 조회.
 * 행이 없으면 exists=false. 조회 오류는 호출자에게 던진다.
 * 수명 스키마가 있으면 폐기 시각, 만료 시각, 허용 대역, 회전 퇴역 시각을 함께 돌려준다.
 * 기본 workspace와 그룹 접근(읽을 수 있는 키 목록, 다른 멤버 파편에 대한 쓰기 권한)도 함께 읽어
 * 열린 세션이 키 설정과 그룹 멤버십 변경을 재확인 주기 안에 따라가게 한다.
 *
 * @param {string} keyId
 * @returns {Promise<{ exists: boolean, status: string|null, permissions: string[]|null,
 *                     defaultWorkspace?: string|null, groupKeyIds?: string[], groupGrants?: object,
 *                     revokedAt?: Date|null, expiresAt?: Date|null, allowedCidrs?: string[]|null, secretRetirements?: Date[] }>}
 */
export async function getKeyAuthState(keyId) {
  const { rows, lifecycle } = await queryWithLifecycle(
    getPrimaryPool(),
    { sql: `SELECT k.status, k.permissions, k.default_workspace, k.revoked_at, k.expires_at, k.allowed_cidrs, ${SECRET_RETIREMENTS_SQL}
            FROM ${SCHEMA}.api_keys k WHERE k.id = $1`, params: [keyId] },
    { sql: `SELECT status, permissions, default_workspace FROM ${SCHEMA}.api_keys WHERE id = $1`, params: [keyId] }
  );
  if (!rows.length) return { exists: false, status: null, permissions: null };
  const state = {
    exists          : true,
    status          : rows[0].status,
    permissions     : rows[0].permissions ?? null,
    defaultWorkspace: rows[0].default_workspace ?? null,
    ...await groupAccessOrNothing(keyId)
  };
  if (!lifecycle) return state;
  return {
    ...state,
    revokedAt        : rows[0].revoked_at ?? null,
    expiresAt        : rows[0].expires_at ?? null,
    allowedCidrs     : rows[0].allowed_cidrs ?? null,
    secretRetirements: rows[0].secret_retirements ?? []
  };
}

/**
 * keyId가 읽을 수 있는 키 id 배열(자기 키와, 같은 그룹에서 read·share 권한으로 읽게 된 키).
 * 그룹 미소속 시 [keyId] 단독 반환. keyId가 없으면 null 반환.
 *
 * @param {string|null} keyId
 * @returns {Promise<string[]|null>}
 */
export async function getGroupKeyIds(keyId) {
  if (!keyId) return null;
  return (await getGroupAccess(keyId)).groupKeyIds;
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
  /** fragment_limit은 migration-077 전 설치에서도 읽히도록 행을 jsonb로 읽는다. 사용량은 상한이 있는 그룹만 센다. */
  const { rows } = await pool.query(`
    SELECT g.id, g.name, g.description, g.created_at,
           COUNT(m.key_id)::int AS member_count,
           (to_jsonb(g) ->> 'fragment_limit')::int AS fragment_limit
    FROM   ${SCHEMA}.api_key_groups g
    LEFT JOIN ${SCHEMA}.api_key_group_members m ON m.group_id = g.id
    GROUP BY g.id
    ORDER BY g.created_at DESC
  `);
  for (const row of rows) {
    row.fragment_count = row.fragment_limit == null ? null : await countGroupLiveFragments(pool, row.id);
  }
  return rows;
}

/**
 * 그룹 파편 상한을 바꾼다. null은 상한 없음이다. 새 상한이 멤버 키 전체의 현재 파편 수보다 작으면 바꾸지 않고
 * belowUsage를 돌려준다. 그룹이 없으면 null이다.
 *
 * @param {string}      groupId
 * @param {number|null} limit
 * @returns {Promise<{ groupId: string, previous: number|null, fragment_limit: number|null, used: number, belowUsage?: true }|null>}
 */
export async function updateGroupFragmentLimit(groupId, limit) {
  const pool = getPrimaryPool();
  const { rows: [group] } = await pool.query(
    `SELECT id, fragment_limit FROM ${SCHEMA}.api_key_groups WHERE id = $1`, [groupId]
  );
  if (!group) return null;
  const used = await countGroupLiveFragments(pool, groupId);
  const base = { groupId: String(group.id), previous: group.fragment_limit, used };
  if (limit !== null && limit < used) return { ...base, fragment_limit: group.fragment_limit, belowUsage: true };
  await pool.query(`UPDATE ${SCHEMA}.api_key_groups SET fragment_limit = $1 WHERE id = $2`, [limit, groupId]);
  return { ...base, fragment_limit: limit };
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

export async function removeKeyFromGroup(keyId, groupId) {
  const pool         = getPrimaryPool();
  const { rowCount } = await pool.query(`
    DELETE FROM ${SCHEMA}.api_key_group_members
    WHERE group_id = $1 AND key_id = $2
  `, [groupId, keyId]);
  return { keyId, groupId, removed: rowCount > 0 };
}
