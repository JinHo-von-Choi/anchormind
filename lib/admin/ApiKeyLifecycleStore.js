/**
 * Admin: API 키 수명 변경 저장소(회전, 폐기, 수명 열 편집, 접근 검토)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 회전과 폐기는 키 행을 잠근 한 트랜잭션 안에서 api_keys와 api_key_secrets를 함께 바꾼다.
 *   회전  현재 해시가 비밀 표에 없으면 먼저 옮긴다. 키의 유효한 비밀 행 모두의 valid_until을 겹침 종료
 *         시각 이하로 정하고, 새 해시 행을 더한 뒤 api_keys.key_hash, key_prefix를 새 값으로 바꾼다.
 *         원시 키는 돌려줄 뿐 저장하지 않는다. 폐기한 키는 회전하지 않는다.
 *   폐기  revoked_at, revoked_by, revoke_reason을 쓰고 status를 inactive로 바꾸며, 비밀 행을 모두 revoked로
 *         바꾼다. 폐기는 되돌리지 않는다.
 */

import { getPrimaryPool }                  from "../tools/db.js";
import { logWarn }                         from "../logger.js";
import { SCHEMA }                          from "../memory/schema.js";
import { newKeyMaterial }                  from "./key-material.js";
import {
  KEY_LIFECYCLE_FIELDS, KEY_SECRET_STATUS, KeyLifecycleConflictError, rotationValidUntil
} from "./key-lifecycle.js";

/**
 * 한 연결의 트랜잭션 안에서 fn을 실행한다. 오류면 되돌리고 원 오류를 던진다.
 *
 * @template T
 * @param {(client: import("pg").PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function inKeyTransaction(fn) {
  const client = await getPrimaryPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr) =>
      logWarn(`[ApiKeyLifecycleStore] rollback failed: ${rollbackErr.message}`));
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 키 행을 잠그고 읽는다. 없으면 "Key not found"를 던진다.
 *
 * @param {import("pg").PoolClient} client
 * @param {string} keyId
 * @returns {Promise<object>}
 */
async function lockKey(client, keyId) {
  const { rows } = await client.query(
    `SELECT id, name, key_hash, key_prefix, created_at, revoked_at FROM ${SCHEMA}.api_keys WHERE id = $1 FOR UPDATE`,
    [keyId]
  );
  if (!rows.length) throw new Error("Key not found");
  return rows[0];
}

/**
 * 키를 회전한다.
 *
 * @param {string} keyId
 * @param {{ graceHours: number, now?: number }} options
 * @returns {Promise<{ id: string, name: string, key_prefix: string, raw_key: string, previous_valid_until: Date, retired_secrets: number }>}
 */
export async function rotateApiKey(keyId, { graceHours, now = Date.now() }) {
  return inKeyTransaction(async (client) => {
    const key = await lockKey(client, keyId);
    if (key.revoked_at) throw new KeyLifecycleConflictError("key_revoked", "Key is revoked");

    await client.query(
      `INSERT INTO ${SCHEMA}.api_key_secrets (key_hash, key_id, key_prefix, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key_hash) DO NOTHING`,
      [key.key_hash, key.id, key.key_prefix, key.created_at]
    );

    const validUntil = rotationValidUntil(now, graceHours);
    const retired    = await client.query(
      `UPDATE ${SCHEMA}.api_key_secrets
       SET    valid_until = CASE WHEN valid_until IS NULL OR valid_until > $2 THEN $2 ELSE valid_until END
       WHERE  key_id = $1 AND status = $3`,
      [key.id, validUntil, KEY_SECRET_STATUS.ACTIVE]
    );

    const { rawKey, hash, prefix } = newKeyMaterial(key.name);
    await client.query(
      `INSERT INTO ${SCHEMA}.api_key_secrets (key_hash, key_id, key_prefix) VALUES ($1, $2, $3)`,
      [hash, key.id, prefix]
    );
    await client.query(
      `UPDATE ${SCHEMA}.api_keys SET key_hash = $2, key_prefix = $3 WHERE id = $1`,
      [key.id, hash, prefix]
    );

    return {
      id                  : key.id,
      name                : key.name,
      key_prefix          : prefix,
      raw_key             : rawKey,
      previous_valid_until: validUntil,
      retired_secrets     : retired.rowCount
    };
  });
}

/**
 * 키를 폐기한다.
 *
 * @param {string} keyId
 * @param {{ reason: string, actor: string }} options
 * @returns {Promise<{ id: string, name: string, status: string, revoked_at: Date, revoked_by: string, revoke_reason: string, revoked_secrets: number }>}
 */
export async function revokeApiKey(keyId, { reason, actor }) {
  return inKeyTransaction(async (client) => {
    const key = await lockKey(client, keyId);
    if (key.revoked_at) throw new KeyLifecycleConflictError("already_revoked", "Key is already revoked");

    const { rows } = await client.query(
      `UPDATE ${SCHEMA}.api_keys
       SET    revoked_at = NOW(), revoked_by = $2, revoke_reason = $3, status = 'inactive'
       WHERE  id = $1
       RETURNING id, name, status, revoked_at, revoked_by, revoke_reason`,
      [key.id, actor, reason]
    );
    const secrets = await client.query(
      `UPDATE ${SCHEMA}.api_key_secrets SET status = $2 WHERE key_id = $1 AND status <> $2`,
      [key.id, KEY_SECRET_STATUS.REVOKED]
    );
    return { ...rows[0], revoked_secrets: secrets.rowCount };
  });
}

/**
 * 수명 열(expires_at, description, owner, kind, allowed_cidrs) 변경. 전달된 필드만 한 문장으로 바꾸고,
 * 같은 문장에서 행 잠금 아래 읽은 변경 전 값을 함께 돌려준다.
 *
 * @param {string} keyId
 * @param {object} patch key-lifecycle.validateKeyLifecyclePatch를 통과한 값
 * @returns {Promise<{ before: object, after: object }>}
 */
export async function updateKeyLifecycle(keyId, patch) {
  const fields = KEY_LIFECYCLE_FIELDS.filter((field) => Object.hasOwn(patch, field));
  if (fields.length === 0) throw new Error("lifecycle patch has no fields");

  const columns     = KEY_LIFECYCLE_FIELDS.join(", ");
  const assignments = fields.map((field, i) => `${field} = $${i + 2}`).join(", ");
  const { rows }    = await getPrimaryPool().query(
    `WITH prev AS (
       SELECT id, ${columns}
       FROM   ${SCHEMA}.api_keys
       WHERE  id = $1
       FOR UPDATE
     )
     UPDATE ${SCHEMA}.api_keys k
     SET    ${assignments}
     FROM   prev
     WHERE  k.id = prev.id
     RETURNING ${KEY_LIFECYCLE_FIELDS.map((field) => `prev.${field} AS prev_${field}`).join(", ")},
               ${KEY_LIFECYCLE_FIELDS.map((field) => `k.${field}`).join(", ")}`,
    [keyId, ...fields.map((field) => patch[field])]
  );
  if (!rows.length) throw new Error("Key not found");

  const row = rows[0];
  return {
    before: Object.fromEntries(KEY_LIFECYCLE_FIELDS.map((field) => [field, row[`prev_${field}`] ?? null])),
    after : Object.fromEntries(KEY_LIFECYCLE_FIELDS.map((field) => [field, row[field] ?? null]))
  };
}

/**
 * 접근 검토 서명을 남긴다.
 *
 * @param {string} keyId
 * @param {string} actor
 * @returns {Promise<{ access_reviewed_at: Date, access_reviewed_by: string, previous_reviewed_at: Date|null }>}
 */
export async function recordAccessReview(keyId, actor) {
  const { rows } = await getPrimaryPool().query(
    `WITH prev AS (
       SELECT id, access_reviewed_at FROM ${SCHEMA}.api_keys WHERE id = $1 FOR UPDATE
     )
     UPDATE ${SCHEMA}.api_keys k
     SET    access_reviewed_at = NOW(), access_reviewed_by = $2
     FROM   prev
     WHERE  k.id = prev.id
     RETURNING k.access_reviewed_at, k.access_reviewed_by, prev.access_reviewed_at AS previous_reviewed_at`,
    [keyId, actor]
  );
  if (!rows.length) throw new Error("Key not found");
  return rows[0];
}
