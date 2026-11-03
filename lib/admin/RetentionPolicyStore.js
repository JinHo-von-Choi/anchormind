/**
 * Admin: 키·workspace별 파편 보존 정책 저장소(key_retention_policies, migration-078)
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * 정책 하나는 (키, workspace 또는 키 전체)와 최대 보존 일수다. 삭제는 정리 주기의 retention_expire 단계
 * (lib/memory/consolidate/RetentionGC.js)가 한다.
 */

import { getPrimaryPool } from "../tools/db.js";
import { SCHEMA }         from "../memory/schema.js";

/** 보존 일수 범위. 표의 CHECK와 같다. */
export const RETENTION_MAX_AGE_DAYS = Object.freeze({ min: 1, max: 36_500 });

/** 입력 오류 */
export class RetentionPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "RetentionPolicyError";
  }
}

/**
 * 입력 { workspace, max_age_days }를 검사한다. max_age_days가 null이면 정책을 지우라는 뜻이다.
 *
 * @param {unknown} body
 * @returns {{ workspace: string|null, maxAgeDays: number|null }}
 */
export function normalizeRetentionInput(body) {
  if (!body || typeof body !== "object") throw new RetentionPolicyError("body must be an object");
  const raw = body.workspace ?? null;
  if (raw !== null && (typeof raw !== "string" || raw.trim() === "" || raw.length > 128)) {
    throw new RetentionPolicyError("workspace must be null (all workspaces) or a 1-128 character name");
  }
  const days = body.max_age_days;
  if (days !== null && (!Number.isInteger(days) || days < RETENTION_MAX_AGE_DAYS.min || days > RETENTION_MAX_AGE_DAYS.max)) {
    throw new RetentionPolicyError(`max_age_days must be null (remove) or an integer ${RETENTION_MAX_AGE_DAYS.min}-${RETENTION_MAX_AGE_DAYS.max}`);
  }
  return { workspace: raw === null ? null : raw.trim(), maxAgeDays: days };
}

/**
 * 키의 보존 정책 목록. 키 전체 정책이 먼저다.
 *
 * @param {string} keyId
 * @returns {Promise<Array<{ workspace: string|null, max_age_days: number, updated_at: string }>>}
 */
export async function listRetentionPolicies(keyId) {
  const { rows } = await getPrimaryPool().query(
    `SELECT workspace, max_age_days, updated_at FROM ${SCHEMA}.key_retention_policies
      WHERE key_id = $1 ORDER BY workspace NULLS FIRST`,
    [keyId]
  );
  return rows;
}

/**
 * 정책을 넣거나 바꾼다. maxAgeDays가 null이면 지운다. 바뀌기 전 일수(없으면 null)를 함께 돌려준다.
 *
 * @param {string} keyId
 * @param {{ workspace: string|null, maxAgeDays: number|null }} input
 * @returns {Promise<{ workspace: string|null, previous: number|null, max_age_days: number|null }>}
 */
export async function setRetentionPolicy(keyId, { workspace, maxAgeDays }) {
  const pool = getPrimaryPool();
  const { rows: [before] } = await pool.query(
    `SELECT max_age_days FROM ${SCHEMA}.key_retention_policies
      WHERE key_id = $1 AND COALESCE(workspace, '') = COALESCE($2::text, '')`,
    [keyId, workspace]
  );
  if (maxAgeDays === null) {
    await pool.query(
      `DELETE FROM ${SCHEMA}.key_retention_policies WHERE key_id = $1 AND COALESCE(workspace, '') = COALESCE($2::text, '')`,
      [keyId, workspace]
    );
  } else {
    await pool.query(
      `INSERT INTO ${SCHEMA}.key_retention_policies (key_id, workspace, max_age_days)
       VALUES ($1, $2, $3)
       ON CONFLICT (key_id, COALESCE(workspace, ''))
       DO UPDATE SET max_age_days = EXCLUDED.max_age_days, updated_at = NOW()`,
      [keyId, workspace, maxAgeDays]
    );
  }
  return { workspace, previous: before?.max_age_days ?? null, max_age_days: maxAgeDays };
}
