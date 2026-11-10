/**
 * Lineage - 파생 파편의 계보와 근거 상태
 *
 * 작성자: 최진호
 * 작성일: 2026-11-10
 *
 * 파생 파편(분할 자식, reflect 교훈)은 fragment_lineage에 원본을 기록한다(migration-081). 원본이 철회되면
 * 자식의 support_state를 바꾼다. 철회와 구조 변경을 나눈다.
 *
 *   철회       forget(revoked), assertionStatus=rejected(revoked), 사용자 대체 supersedes(revoked),
 *              본문을 바꾼 amend(stale)
 *   구조 변경  분할로 원본이 닫힘, 정리 단계의 중복 대체와 압축, 만료 삭제. 자식에 전파하지 않는다
 *
 * revoked와 stale 자식은 context 주입에서 빠지고 recall에는 상태와 함께 나온다. 지우지는 않는다.
 * 한 단계만 따라간다. 분할은 분할 자식을 다시 나누지 않고, 교훈은 다른 파편의 원본이 되지 않는다.
 */

import { SCHEMA }         from "../schema.js";
import { keyScopeScalar } from "../keyScope.js";

/** fragment_lineage.relation 값 */
export const LINEAGE_RELATIONS = Object.freeze({ SPLIT: "split", LESSON: "lesson" });

/** fragments.support_state 값 */
export const SUPPORT_STATES = Object.freeze({
  REVOKED       : "revoked",
  STALE         : "stale",
  PARENT_MISSING: "parent_missing"
});

/** context 주입에서 빼는 근거 상태 */
export const UNSUPPORTED_STATES = Object.freeze([SUPPORT_STATES.REVOKED, SUPPORT_STATES.STALE]);

/** support_reason 값 */
export const SUPPORT_REASONS = Object.freeze({
  PARENT_FORGOTTEN : "parent_forgotten",
  PARENT_REJECTED  : "parent_rejected",
  PARENT_SUPERSEDED: "parent_superseded",
  PARENT_AMENDED   : "parent_amended",
  PARENT_MISSING   : "parent_missing"
});

/** 상태의 강도. 약한 상태가 강한 상태를 덮지 않는다. */
const STRENGTH = Object.freeze({ [SUPPORT_STATES.PARENT_MISSING]: 1, [SUPPORT_STATES.STALE]: 2, [SUPPORT_STATES.REVOKED]: 3 });

/**
 * 주입 가능한 근거 상태인지 본다. NULL과 parent_missing은 주입한다.
 *
 * @param {{support_state?: unknown}|null|undefined} fragment
 * @returns {boolean}
 */
export function isSupported(fragment) {
  return !UNSUPPORTED_STATES.includes(fragment?.support_state);
}

/**
 * isSupported와 같은 판정을 하는 SQL 술어.
 *
 * @param {string} [alias] - 표 별칭. 없으면 열 이름만 쓴다
 * @returns {string}
 */
export function supportedSql(alias = "") {
  if (alias !== "" && !/^[a-z_][a-z0-9_]*$/.test(alias)) throw new TypeError(`invalid alias: ${alias}`);
  const col = alias ? `${alias}.support_state` : "support_state";
  return `(${col} IS NULL OR ${col} NOT IN ('${UNSUPPORTED_STATES.join("', '")}'))`;
}

/**
 * 계보 행을 기록한다. 같은 (자식, 원본, 관계)는 한 번만 남는다.
 *
 * @param {(sql: string, params: Array) => Promise<{rowCount?: number}>} query
 * @param {Array<{childId: string, parentId: string, relation: string, parentContentHash?: string|null}>} rows
 * @returns {Promise<number>} 새로 기록한 행 수
 */
export async function insertLineage(query, rows) {
  const valid = (rows ?? []).filter(r => r?.childId && r?.parentId && r.childId !== r.parentId
    && Object.values(LINEAGE_RELATIONS).includes(r.relation));
  if (valid.length === 0) return 0;
  const result = await query(
    `INSERT INTO ${SCHEMA}.fragment_lineage (child_id, parent_id, relation, parent_content_hash)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
     ON CONFLICT (child_id, parent_id, relation) DO NOTHING`,
    [valid.map(r => r.childId), valid.map(r => r.parentId), valid.map(r => r.relation),
      valid.map(r => r.parentContentHash ?? null)]
  );
  return result?.rowCount ?? 0;
}

/**
 * 원본 id 목록의 자식에 근거 상태를 단다. 원본 자신은 바꾸지 않으며, 이미 같거나 더 강한 상태인 자식은 그대로 둔다.
 *
 * @param {(sql: string, params: Array) => Promise<{rows?: Array<{id: string}>}>} query
 * @param {string[]} parentIds
 * @param {string}   state  - SUPPORT_STATES 값
 * @param {string}   reason - SUPPORT_REASONS 값
 * @returns {Promise<string[]>} 상태를 바꾼 자식 id
 */
export async function markChildren(query, parentIds, state, reason) {
  const ids = [...new Set((parentIds ?? []).filter(Boolean))];
  if (ids.length === 0 || !Object.hasOwn(STRENGTH, state)) return [];
  const result = await query(markChildrenSql(), [ids, state, reason, weakerStates(state)]);
  return (result?.rows ?? []).map(r => r.id);
}

/**
 * 이미 지워진 원본의 자식만 revoked로 바꾼다. 삭제 연쇄를 끈 forget 경로처럼 지운 행을 따로 돌려받지 못하는
 * 호출자가 쓴다. 아직 남은 원본(권한이나 보호로 지우지 못한 파편)의 자식은 바꾸지 않는다.
 *
 * @param {(sql: string, params: Array) => Promise<{rows?: Array<{id: string}>}>} query
 * @param {string[]} parentIds - 삭제를 시도한 원본 id
 * @returns {Promise<string[]>} 상태를 바꾼 자식 id
 */
export async function revokeChildrenOfDeleted(query, parentIds) {
  const ids = [...new Set((parentIds ?? []).filter(Boolean))];
  if (ids.length === 0) return [];
  const { rows } = await query(
    `SELECT p.id FROM unnest($1::text[]) AS p(id)
      WHERE NOT EXISTS (SELECT 1 FROM ${SCHEMA}.fragments f WHERE f.id = p.id)`,
    [ids]
  );
  const gone = (rows ?? []).map(r => r.id);
  return markChildren(query, gone, SUPPORT_STATES.REVOKED, SUPPORT_REASONS.PARENT_FORGOTTEN);
}

/**
 * markChildren의 문장. $1 원본 id 배열, $2 상태, $3 사유, $4 덮을 수 있는 이전 상태 배열.
 *
 * @returns {string}
 */
export function markChildrenSql() {
  return `UPDATE ${SCHEMA}.fragments c
             SET support_state = $2, support_reason = $3, support_changed_at = NOW()
           WHERE c.id IN (SELECT l.child_id FROM ${SCHEMA}.fragment_lineage l WHERE l.parent_id = ANY($1::text[]))
             AND NOT (c.id = ANY($1::text[]))
             AND (c.support_state IS NULL OR c.support_state = ANY($4::text[]))
         RETURNING c.id`;
}

/**
 * 주어진 상태보다 약한 상태 목록.
 *
 * @param {string} state
 * @returns {string[]}
 */
export function weakerStates(state) {
  const level = STRENGTH[state] ?? 0;
  return Object.keys(STRENGTH).filter(s => STRENGTH[s] < level);
}

/**
 * 계보의 원본으로 쓸 수 있는 파편과 그 content_hash. 같은 키(keyId가 null이면 키 범위 없음)의 파편만 돌려준다.
 *
 * @param {(sql: string, params: Array) => Promise<{rows?: Array<{id: string, content_hash: string|null}>}>} query
 * @param {string[]} ids
 * @param {string|null} keyId
 * @returns {Promise<Map<string, string|null>>}
 */
export async function knownParents(query, ids, keyId) {
  const list = [...new Set((ids ?? []).filter(Boolean))];
  if (list.length === 0) return new Map();
  const params = [list];
  const scope  = keyScopeScalar(params, "key_id", keyId);
  const { rows } = await query(`SELECT id, content_hash FROM ${SCHEMA}.fragments WHERE id = ANY($1::text[])${scope}`, params);
  return new Map((rows ?? []).map(r => [r.id, r.content_hash ?? null]));
}

/**
 * 파편 id들의 원본 계보. recall이 자식의 근거 상태와 원본 id를 함께 보이는 데 쓴다.
 *
 * @param {(sql: string, params: Array) => Promise<{rows?: Array<Object>}>} query
 * @param {string[]} childIds
 * @returns {Promise<Map<string, Array<{parent_id: string, relation: string}>>>}
 */
export async function loadParents(query, childIds) {
  const ids = [...new Set((childIds ?? []).filter(Boolean))];
  const out = new Map();
  if (ids.length === 0) return out;
  const { rows } = await query(
    `SELECT child_id, parent_id, relation FROM ${SCHEMA}.fragment_lineage
      WHERE child_id = ANY($1::text[]) ORDER BY child_id, created_at, parent_id`,
    [ids]
  );
  for (const r of rows ?? []) {
    if (!out.has(r.child_id)) out.set(r.child_id, []);
    out.get(r.child_id).push({ parent_id: r.parent_id, relation: r.relation });
  }
  return out;
}
