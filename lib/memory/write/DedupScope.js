/**
 * content_hash 중복 판정 범위
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 같은 본문(content_hash)을 하나의 파편으로 보는 범위를 정한다.
 *   workspace  키(마스터는 key_id NULL)와 workspace(NULL과 ''는 같은 칸) 단위
 *   key        키 단위
 * 전역 파편(workspace NULL)은 모든 workspace에서 보이므로 workspace 범위에서도 같은 본문으로 본다.
 *
 * 범위는 유일 색인 네 개와 맞물린다. 키 범위 색인(uq_frag_hash_per_key, uq_frag_hash_master)과
 * workspace 범위 색인(uq_frag_hash_ws_per_key, uq_frag_hash_ws_master)은 운영 단계에서 만들고
 * 지우므로 어느 조합이든 있을 수 있다. 쓰기 경로는 실제로 있는 유효 색인을 읽어
 *   - 키 범위 색인이 있으면 판정 범위를 키 범위로 둔다(그 색인이 다른 workspace의 같은 본문을 막는다)
 *   - ON CONFLICT 대상은 있는 색인 중 범위가 넓은 쪽으로 고른다
 * 색인 상태는 짧게 기억하고, 색인과 맞지 않는 오류(42P10, 판정 색인의 23505)를 받으면 다시 읽는다.
 */

import { SCHEMA }     from "../schema.js";
import { dedupScope } from "../../config.js";
import { logWarn }    from "../../logger.js";

export const DEDUP_SCOPES = Object.freeze({ WORKSPACE: "workspace", KEY: "key" });

/** 중복 판정 유일 색인. legacy는 키 범위(migration-031), scoped는 workspace 범위(migration-050)다. */
export const DEDUP_INDEXES = Object.freeze({
  keyLegacy   : "uq_frag_hash_per_key",
  masterLegacy: "uq_frag_hash_master",
  keyScoped   : "uq_frag_hash_ws_per_key",
  masterScoped: "uq_frag_hash_ws_master"
});

export const DEDUP_INDEX_NAMES = Object.freeze(Object.values(DEDUP_INDEXES));

/** 색인 상태를 다시 읽기까지의 시간. 운영 단계의 색인 변경이 이 시간 안에 반영된다. */
export const DEDUP_INDEX_STATE_TTL_MS = 60_000;

/** 색인별 ON CONFLICT 추론 대상. 색인 정의와 같은 열, 식, 술어다. */
const CONFLICT_TARGETS = Object.freeze({
  [DEDUP_INDEXES.keyLegacy]   : "(key_id, content_hash) WHERE key_id IS NOT NULL",
  [DEDUP_INDEXES.masterLegacy]: "(content_hash) WHERE key_id IS NULL",
  [DEDUP_INDEXES.keyScoped]   : "(key_id, content_hash, (COALESCE(workspace, ''))) WHERE key_id IS NOT NULL",
  [DEDUP_INDEXES.masterScoped]: "(content_hash, (COALESCE(workspace, ''))) WHERE key_id IS NULL"
});

const INDEX_STATE_SQL = `SELECT c.relname AS name
   FROM pg_index i
   JOIN pg_class c ON c.oid = i.indexrelid
  WHERE c.relnamespace = '${SCHEMA}'::regnamespace
    AND c.relname = ANY($1::text[])
    AND i.indisvalid`;

/**
 * 키 경로(키 보유 또는 마스터)에 해당하는 두 색인 이름.
 *
 * @param {string|null} keyId
 * @returns {{legacy: string, scoped: string}}
 */
function pathIndexes(keyId) {
  return keyId == null
    ? { legacy: DEDUP_INDEXES.masterLegacy, scoped: DEDUP_INDEXES.masterScoped }
    : { legacy: DEDUP_INDEXES.keyLegacy,    scoped: DEDUP_INDEXES.keyScoped };
}

/**
 * 실제로 적용할 판정 범위. 키 범위 색인이 있으면 설정과 무관하게 키 범위다.
 *
 * @param {string}      configured - MEMENTO_DEDUP_SCOPE 값
 * @param {Set<string>} present    - 유효한 판정 색인 이름
 * @param {string|null} keyId
 * @returns {"workspace"|"key"}
 */
export function effectiveDedupScope(configured, present, keyId) {
  if (present.has(pathIndexes(keyId).legacy)) return DEDUP_SCOPES.KEY;
  return configured === DEDUP_SCOPES.KEY ? DEDUP_SCOPES.KEY : DEDUP_SCOPES.WORKSPACE;
}

/**
 * ON CONFLICT만으로 판정 범위 전체를 잡지 못해 사전 조회가 필요한지 본다. 키 범위 색인이 있으면
 * 그 색인이 대상이고 판정 범위도 키 범위이므로 필요 없다.
 *
 * @param {Set<string>} present
 * @param {string|null} keyId
 * @returns {boolean}
 */
export function lookupRequired(present, keyId) {
  return !present.has(pathIndexes(keyId).legacy);
}

/**
 * ON CONFLICT 대상 색인. 키 범위 색인, workspace 범위 색인 순으로 고르고 둘 다 없으면 null이다.
 *
 * @param {Set<string>} present
 * @param {string|null} keyId
 * @returns {string|null}
 */
export function conflictIndex(present, keyId) {
  const { legacy, scoped } = pathIndexes(keyId);
  if (present.has(legacy)) return legacy;
  if (present.has(scoped)) return scoped;
  return null;
}

/**
 * INSERT의 ON CONFLICT 절. 대상 색인이 없으면 빈 문자열이고 사전 조회만으로 판정한다.
 * 충돌하면 기존 행의 importance는 큰 값, is_anchor는 OR로 합치고 접근 시각을 갱신한다.
 *
 * @param {Set<string>} present
 * @param {string|null} keyId
 * @returns {string}
 */
export function conflictClause(present, keyId) {
  const index = conflictIndex(present, keyId);
  if (index === null) return "";
  return `ON CONFLICT ${CONFLICT_TARGETS[index]} DO UPDATE SET
                importance  = GREATEST(${SCHEMA}.fragments.importance, EXCLUDED.importance),
                is_anchor   = ${SCHEMA}.fragments.is_anchor OR EXCLUDED.is_anchor,
                accessed_at = NOW()`;
}

/**
 * 색인과 같은 workspace 칸. NULL과 ''는 같은 칸이다.
 *
 * @param {string|null|undefined} workspace
 * @returns {string}
 */
export function workspaceKey(workspace) {
  return workspace == null ? "" : String(workspace);
}

/**
 * 같은 키, 같은 content_hash 행 중 요청 workspace에서 같은 본문으로 볼 행을 고른다.
 * 같은 workspace 행, 전역 행 순이고 키 범위에서는 그 밖의 workspace 행도 고른다.
 *
 * @param {Array<{id: string, workspace: (string|null)}>} rows
 * @param {string|null} workspace - 요청 workspace
 * @param {"workspace"|"key"} scope
 * @returns {{id: string, workspace: (string|null)}|null}
 */
export function pickDuplicate(rows, workspace, scope) {
  const target = workspaceKey(workspace);
  const exact  = rows.find(r => workspaceKey(r.workspace) === target);
  if (exact) return exact;
  const global = rows.find(r => r.workspace == null);
  if (global) return global;
  return scope === DEDUP_SCOPES.KEY ? (rows[0] ?? null) : null;
}

/**
 * batch 청크 안에서 같은 본문 항목을 하나로 접을 때의 키. 해시가 없으면 null(접지 않음).
 *
 * @param {{content_hash?: string, workspace?: (string|null)}} fragment
 * @param {"workspace"|"key"} scope
 * @returns {string|null}
 */
export function foldKey(fragment, scope) {
  const hash = fragment.content_hash;
  if (!hash) return null;
  return scope === DEDUP_SCOPES.KEY ? hash : `${workspaceKey(fragment.workspace)}\u0000${hash}`;
}

/**
 * batch 사전 조회 결과로 INSERT 없이 기존 파편 id를 돌려줄 항목을 가른다.
 * ON CONFLICT 대상 색인이 잡는 같은 칸 중복은 INSERT에 남겨 기존 병합(importance, is_anchor)을 따른다.
 * 대상 색인이 없으면 같은 칸 중복도 여기서 가른다.
 *
 * @param {Array<{index: number, fragment: Object}>} items
 * @param {Array<{id: string, workspace: (string|null), content_hash: string}>} rows
 * @param {"workspace"|"key"} scope
 * @param {string|null} arbiter - conflictIndex 결과
 * @returns {{hits: Array<{index: number, id: string}>, rest: Array<{index: number, fragment: Object}>}}
 */
export function splitLookupHits(items, rows, scope, arbiter) {
  const byHash = new Map();
  for (const row of rows) {
    if (!byHash.has(row.content_hash)) byHash.set(row.content_hash, []);
    byHash.get(row.content_hash).push(row);
  }
  const hits = [];
  const rest = [];
  for (const item of items) {
    const pick     = pickDuplicate(byHash.get(item.fragment.content_hash) ?? [], item.fragment.workspace, scope);
    const sameCell = pick !== null && workspaceKey(pick.workspace) === workspaceKey(item.fragment.workspace);
    if (pick !== null && (arbiter === null || !sameCell)) hits.push({ index: item.index, id: pick.id });
    else rest.push(item);
  }
  return { hits, rest };
}

/**
 * 색인 상태를 다시 읽어야 하는 오류인지 본다. 42P10은 ON CONFLICT 대상 색인이 없어진 경우,
 * 판정 색인의 23505는 대상이 아닌 색인이 막은 경우다.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isDedupIndexError(err) {
  if (err?.code === "42P10") return true;
  return err?.code === "23505" && DEDUP_INDEX_NAMES.includes(err.constraint);
}

/**
 * 같은 키의 content_hash 일치 행을 읽는다. 판정 범위(workspace 또는 키)는 호출자가
 * pickDuplicate 또는 splitLookupHits로 고른다. 키 조건은 부분 유일 색인의 술어와 같은 꼴로 둔다.
 * insert, amend, batch_remember가 같은 질의를 쓴다.
 *
 * @param {(sql: string, params: unknown[]) => Promise<{rows: Object[]}>} run
 * @param {string|null} keyId
 * @param {string[]}    hashes
 * @param {string|null} [excludeId] - 결과에서 뺄 파편 id(amend 대상 자신)
 * @returns {Promise<Array<{id: string, workspace: (string|null), content_hash: string}>>}
 */
export async function findContentHashMatches(run, keyId, hashes, excludeId = null) {
  const params  = [hashes];
  const keyCond = keyId == null ? "IS NULL" : `= $${params.push(keyId)}`;
  const idCond  = excludeId == null ? "" : ` AND id <> $${params.push(excludeId)}`;
  const { rows } = await run(
    `SELECT id, workspace, content_hash FROM ${SCHEMA}.fragments
      WHERE content_hash = ANY($1::text[]) AND key_id ${keyCond}${idCond}`,
    params
  );
  return rows;
}

/**
 * 색인 상태 오류이면 기억한 색인 상태를 버린다. 오류는 그대로 돌려주어 호출자가 던진다.
 *
 * @param {unknown} err
 * @returns {unknown} 같은 오류
 */
export function noteDedupIndexError(err) {
  if (isDedupIndexError(err)) invalidateDedupIndexes();
  return err;
}

let cachedState = null;
let loggedNames = null;

/**
 * workspace 범위를 설정했는데 키 범위 색인이 남아 있으면 해당 경로의 판정이 키 범위로 동작하므로
 * 경고한다. 색인 구성이 바뀔 때만 기록한다.
 *
 * @param {Set<string>} present
 */
function logIndexChange(present) {
  const names = [...present].sort().join(", ");
  if (names === loggedNames) return;
  loggedNames = names;
  const legacy = [DEDUP_INDEXES.keyLegacy, DEDUP_INDEXES.masterLegacy].filter(n => present.has(n));
  if (legacy.length > 0 && dedupScope() === DEDUP_SCOPES.WORKSPACE) {
    logWarn(`[DedupScope] 키 범위 색인(${legacy.join(", ")})이 있어 해당 경로의 중복 판정은 키 범위로 동작한다. 판정 색인: ${names}`);
  }
}

/**
 * 유효한 판정 색인 이름 집합. DEDUP_INDEX_STATE_TTL_MS 동안 기억한다.
 *
 * @param {(sql: string, params: unknown[]) => Promise<{rows: Array<{name: string}>}>} run
 * @param {number} [now]
 * @returns {Promise<Set<string>>}
 */
export async function loadDedupIndexes(run, now = Date.now()) {
  if (cachedState && now - cachedState.loadedAt < DEDUP_INDEX_STATE_TTL_MS) return cachedState.present;
  const { rows } = await run(INDEX_STATE_SQL, [DEDUP_INDEX_NAMES]);
  const present  = new Set(rows.map(r => r.name));
  cachedState    = { present, loadedAt: now };
  logIndexChange(present);
  return present;
}

/** 기억한 색인 상태를 버린다. 다음 loadDedupIndexes가 다시 읽는다. */
export function invalidateDedupIndexes() {
  cachedState = null;
}
