/**
 * 키 수명 스키마(migration-059) 유무에 따른 질의 선택
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 키 저장소의 질의는 수명 열과 api_key_secrets를 쓰는 판과 그 전 스키마의 판 두 벌이다. 수명 판이
 * 표나 열이 없어서 실패하면(42P01, 42703) 경고를 한 번 남기고 같은 요청을 이전 판으로 다시 실행한다.
 * 그 뒤 REPROBE_MS 동안은 이전 판만 쓰고, 간격이 지나면 수명 판을 다시 시도하므로 마이그레이션을
 * 나중에 적용해도 재시작 없이 반영된다. 그 밖의 오류는 그대로 던진다.
 */

import { logWarn } from "../logger.js";

/** 수명 스키마가 없다고 본 뒤 다시 시도하기까지의 간격(ms) */
export const LIFECYCLE_SCHEMA_REPROBE_MS = 60_000;

/** 수명 판만 참조하는 표와 열 이름 */
const LIFECYCLE_NAMES = Object.freeze([
  "api_key_secrets", "expires_at", "description", "owner", "kind", "allowed_cidrs", "last_used_ip_hash",
  "revoked_at", "revoked_by", "revoke_reason", "access_reviewed_at", "access_reviewed_by"
]);

const state = { status: "unknown", checkedAt: 0, warned: false };

/**
 * 수명 스키마가 없어서 난 오류인지.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isMissingLifecycleSchema(err) {
  const code = err?.code;
  if (code !== "42P01" && code !== "42703") return false;
  const message = String(err?.message ?? "");
  return LIFECYCLE_NAMES.some((name) => message.includes(name));
}

/**
 * 현재 수명 판을 시도할지.
 *
 * @param {number} now
 * @returns {boolean}
 */
function useLifecycle(now) {
  return state.status !== "absent" || now - state.checkedAt >= LIFECYCLE_SCHEMA_REPROBE_MS;
}

/**
 * 수명 판 질의를 실행하고, 스키마가 없으면 이전 판으로 다시 실행한다.
 *
 * @param {{ query: Function }} db       pool 또는 트랜잭션 연결
 * @param {{ sql: string, params: unknown[] }} lifecycle
 * @param {{ sql: string, params: unknown[] }|null} legacy  null이면 이전 판이 없다(오류를 던진다)
 * @param {number} [now]
 * @returns {Promise<{ rows: object[], rowCount: number, lifecycle: boolean }>}
 */
export async function queryWithLifecycle(db, lifecycle, legacy, now = Date.now()) {
  if (useLifecycle(now) || legacy === null) {
    try {
      const result = await db.query(lifecycle.sql, lifecycle.params);
      state.status = "present";
      return { rows: result.rows, rowCount: result.rowCount, lifecycle: true };
    } catch (err) {
      if (!isMissingLifecycleSchema(err) || legacy === null) throw err;
      state.status    = "absent";
      state.checkedAt = now;
      if (!state.warned) {
        state.warned = true;
        logWarn("[ApiKey] key lifecycle schema not found (migration 059 not applied); using the api_keys columns only");
      }
    }
  }
  const result = await db.query(legacy.sql, legacy.params);
  return { rows: result.rows, rowCount: result.rowCount, lifecycle: false };
}

/**
 * 수명 스키마 판정 상태.
 *
 * @returns {{ status: string, checkedAt: number }}
 */
export function lifecycleSchemaState() {
  return { status: state.status, checkedAt: state.checkedAt };
}

/** 판정 상태를 처음으로 되돌린다(시험용). */
export function resetLifecycleSchemaState() {
  state.status    = "unknown";
  state.checkedAt = 0;
  state.warned    = false;
}
