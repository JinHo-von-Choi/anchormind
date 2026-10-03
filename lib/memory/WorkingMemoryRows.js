/**
 * WorkingMemoryRows - PostgreSQL 작업 기억 행
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * Redis가 준비되지 않았을 때 scope=session 쓰기를 fragments의 작업 기억 행으로 받는다.
 * 행은 source=wm-fallback, ttl_tier=short, session_id 지정으로 기록하고 valid_to를 기록
 * 시각으로 채워 조회 대상(valid_to IS NULL)에서 뺀다. recall, 통합, 할당량 집계, 내보내기에는
 * 나타나지 않고 이 모듈의 읽기만 행을 본다. content_hash는 세션 범위로 달리 계산해 같은 본문의
 * 영구 파편과 서로 중복 판정되지 않는다.
 *
 * 읽기는 생성 24시간 이내의 행만 보며(Redis 경로의 키 수명과 같다), 정리는 24시간이 지난
 * 행을 지운다. 세션당 보관량은 Redis 경로와 같은 토큰 상한과 행 수 상한으로 줄인다.
 *
 * 세션 사이 구분은 session_id가 하고, 같은 세션 안의 에이전트 구분은 content_hash의 범위
 * (세션과 에이전트)가 한다. 세션이 같아도 에이전트가 다르면 같은 본문이 별도 행이다.
 *
 * 이 모듈은 읽기와 삭제만 한다. 행 기록은 WriteGate를 거친 값으로 FragmentWriter.insert가 한다.
 * 시계는 now(밀리초)로 주입할 수 있다.
 */

import * as db from "../tools/db.js";
import { logWarn }              from "../logger.js";
import { SCHEMA }               from "./schema.js";
import { WM_FALLBACK_SOURCE }   from "./WorkingMemorySql.js";
import { keyScopeNullable }     from "./keyScope.js";

export { WM_FALLBACK_SOURCE };

/** Redis 경로의 키 수명과 같은 보관 시간(초) */
export const WM_TTL_SECONDS = 86400;

/** 세션당 보관 토큰 상한. Redis 경로와 공유한다 */
export const WM_MAX_TOKENS = 500;

/** 세션당 보관 행 수 상한. 보호 항목이 쌓여도 행 수는 이 값을 넘지 않는다 */
export const WM_MAX_ROWS = 100;

/** 정리가 한 문장에서 지우는 행 수 */
export const WM_SWEEP_CHUNK = 100;

/** 정리가 한 번 실행에서 반복하는 문장 수 상한 */
export const WM_SWEEP_MAX_CHUNKS = 50;

/** 정리 문장의 잠금 대기 상한 */
const SWEEP_LOCK_TIMEOUT = "3s";

/** 토큰 상한을 넘을 때 제거 대상에서 빼는 중요도 하한(초과) */
const PROTECTED_IMPORTANCE = 0.8;

const COLUMNS = "id, content, type, topic, agent_id, workspace, key_id, importance, estimated_tokens, created_at";

/**
 * 읽기가 보는 가장 오래된 생성 시각.
 *
 * @param {number} [now] - 기준 시각(밀리초)
 * @returns {string} ISO 시각
 */
export function workingMemoryCutoff(now = Date.now()) {
  return new Date(now - WM_TTL_SECONDS * 1000).toISOString();
}

/**
 * 관문을 거친 파편을 작업 기억 행으로 바꾼다. 같은 객체를 고쳐 관문 통과 표식을 유지한다.
 *
 * @param {Object} fragment - WriteGate가 돌려준 파편 후보(session_id 지정)
 * @param {number} [now]    - 기준 시각(밀리초)
 * @returns {Object} 같은 객체
 */
export function markWorkingMemoryRow(fragment, now = Date.now()) {
  const stamp = new Date(now).toISOString();
  fragment.source          = WM_FALLBACK_SOURCE;
  fragment.ttl_tier        = "short";
  fragment.is_anchor       = false;
  fragment.idempotency_key = null;
  fragment.valid_from      = stamp;
  fragment.valid_to        = stamp;
  fragment.hash_scope      = `wm:${fragment.session_id}:${fragment.agent_id}`;
  return fragment;
}

/**
 * 기동 로그에 남기는 작업 기억 저장소 설명.
 *
 * @param {{redisEnabled: boolean, fallbackEnabled: boolean}} state
 * @returns {string}
 */
export function describeWorkingMemoryBackend({ redisEnabled, fallbackEnabled }) {
  if (redisEnabled && fallbackEnabled) {
    return "[Startup] 작업 기억: Redis, Redis가 준비되지 않은 동안 PostgreSQL 작업 기억 행으로 대체(DB에 있어 모든 프로세스가 공유)";
  }
  if (redisEnabled) {
    return "[Startup] 작업 기억: Redis만 사용(MEMENTO_WM_PG_FALLBACK=off), Redis가 준비되지 않은 동안 scope=session 쓰기는 저장되지 않음";
  }
  if (fallbackEnabled) {
    return "[Startup] 작업 기억: PostgreSQL 작업 기억 행(Redis 사용 안 함, DB에 있어 모든 프로세스가 공유)";
  }
  return "[Startup] 작업 기억: 없음(Redis 사용 안 함, MEMENTO_WM_PG_FALLBACK=off), scope=session 쓰기는 저장되지 않음";
}

/**
 * content_hash의 입력 문자열. hash_scope가 있으면 본문 앞에 붙여 범위마다 다른 해시를 만든다.
 *
 * @param {{content: string, hash_scope?: string}} fragment
 * @returns {string}
 */
export function contentHashInput(fragment) {
  return fragment.hash_scope ? `${fragment.hash_scope}\n${fragment.content}` : fragment.content;
}

/** 미저장 사유. 대체 경로가 꺼져 있거나, 켜져 있어도 쓰기를 받지 못한 경우 */
export const WM_NONE_REASON = Object.freeze({ FALLBACK_OFF: "fallback_off", WRITE_UNAVAILABLE: "write_unavailable" });

/** 대체 경로로 간 사유. Redis가 준비되지 않았거나, 준비됐지만 쓰기에 실패한 경우 */
export const WM_FALLBACK_CAUSE = Object.freeze({ NOT_READY: "redis_not_ready", WRITE_FAILED: "redis_write_failed" });

/**
 * 저장 경로에 대한 응답 힌트. Redis 경로는 힌트가 없다.
 *
 * @param {"redis"|"postgres-fallback"|"none"} backend
 * @param {string} [reason] - backend가 none이면 WM_NONE_REASON, postgres-fallback이면 WM_FALLBACK_CAUSE
 * @returns {Array<{signal: string, suggestion: string, trigger: string}>}
 */
export function workingMemoryHints(backend, reason = WM_NONE_REASON.FALLBACK_OFF) {
  if (backend === "postgres-fallback") {
    const cause = reason === WM_FALLBACK_CAUSE.WRITE_FAILED
      ? "Redis에 쓰지 못해"
      : "Redis가 준비되지 않아";
    return [{
      signal    : "working_memory_fallback",
      suggestion: `${cause} 세션 한정 기억을 PostgreSQL 작업 기억 행으로 저장했다. ` +
                  "context와 reflect가 같은 행을 읽으며 생성 24시간 뒤 정리된다.",
      trigger   : "context"
    }];
  }
  if (backend === "none") {
    const cause = reason === WM_NONE_REASON.WRITE_UNAVAILABLE
      ? "작업 기억 대체 경로가 켜져 있지만 쓰기를 받지 못해"
      : "Redis가 준비되지 않았고 작업 기억 대체 경로가 꺼져 있어";
    return [{
      signal    : "working_memory_unavailable",
      suggestion: `${cause} 세션 한정 기억을 저장하지 못했다. 유지하려면 scope를 permanent로 저장한다.`,
      trigger   : "remember"
    }];
  }
  return [];
}

/**
 * 행을 Redis 작업 기억 항목과 같은 모양으로 바꾼다.
 *
 * @param {Object} row
 * @returns {Object}
 */
export function rowToWorkingMemoryItem(row) {
  return {
    id              : row.id,
    content         : row.content,
    type            : row.type,
    topic           : row.topic,
    agent_id        : row.agent_id,
    workspace       : row.workspace ?? null,
    key_id          : row.key_id ?? null,
    importance      : row.importance || 0.5,
    estimated_tokens: row.estimated_tokens || Math.ceil((row.content || "").length / 4),
    added_at        : new Date(row.created_at).getTime()
  };
}

/**
 * Redis 항목과 작업 기억 행 항목을 합친다. id가 같거나 같은 에이전트, 키의 같은 본문이면
 * 먼저 온 항목만 남기고, 결과는 added_at 오름차순이다.
 *
 * @param {Object[]} redisItems
 * @param {Object[]} rowItems
 * @returns {Object[]}
 */
export function mergeWorkingMemoryItems(redisItems, rowItems) {
  if (rowItems.length === 0) return redisItems;
  const seenIds   = new Set();
  const seenTexts = new Set();
  const merged    = [];
  for (const item of [...redisItems, ...rowItems]) {
    const textKey = `${item.agent_id}\n${item.key_id ?? ""}\n${item.content}`;
    if (seenIds.has(item.id) || seenTexts.has(textKey)) continue;
    seenIds.add(item.id);
    seenTexts.add(textKey);
    merged.push(item);
  }
  return merged.sort((a, b) => (a.added_at ?? 0) - (b.added_at ?? 0));
}

/**
 * 보관 상한을 넘는 항목 중 제거할 위치를 고른다. 오래된 것부터 보고, 토큰 합이 상한 이하가
 * 될 때까지 중요도가 보호 기준을 넘지 않는 항목을 제거한다. 그 뒤에도 행 수가 상한을 넘으면
 * 남은 항목 중 오래된 것부터 제거한다.
 *
 * @param {Array<{importance?: number, estimated_tokens?: number}>} items - 오래된 순
 * @param {{maxTokens?: number, maxRows?: number}} [limits]
 * @returns {Set<number>} 제거할 항목의 위치
 */
export function selectBudgetEvictionIndices(items, { maxTokens = WM_MAX_TOKENS, maxRows = Infinity } = {}) {
  let total = items.reduce((sum, it) => sum + (it.estimated_tokens || 0), 0);
  const out = new Set();

  for (let i = 0; i < items.length && total > maxTokens; i++) {
    if ((items[i].importance || 0) > PROTECTED_IMPORTANCE) continue;
    total -= (items[i].estimated_tokens || 0);
    out.add(i);
  }

  let remaining = items.length - out.size;
  for (let i = 0; i < items.length && remaining > maxRows; i++) {
    if (out.has(i)) continue;
    out.add(i);
    remaining--;
  }
  return out;
}

/**
 * 세션의 작업 기억 행을 오래된 순으로 읽는다. 실패하면 경고를 남기고 빈 목록을 돌려준다.
 *
 * @param {string} sessionId
 * @param {{now?: number}} [opts]
 * @returns {Promise<Object[]>}
 */
export async function listWorkingMemoryRows(sessionId, { now } = {}) {
  if (!sessionId) return [];
  try {
    const { rows } = await db.queryWithAgentVector("system",
      `SELECT ${COLUMNS} FROM ${SCHEMA}.fragments
        WHERE session_id = $1
          AND source     = $2
          AND valid_to IS NOT NULL
          AND created_at > $3::timestamptz
        ORDER BY created_at ASC, id ASC`,
      [sessionId, WM_FALLBACK_SOURCE, workingMemoryCutoff(now)]
    );
    return rows.map(rowToWorkingMemoryItem);
  } catch (err) {
    logWarn(`[WorkingMemoryRows] list failed: ${err.message}`);
    return [];
  }
}

/**
 * 지정한 id의 작업 기억 행만 지운다. 다른 세션의 행과 영구 파편은 지우지 않는다.
 *
 * @param {string}   sessionId
 * @param {string[]} ids
 * @returns {Promise<number>} 지운 행 수
 */
export async function evictWorkingMemoryRows(sessionId, ids) {
  if (!sessionId || ids.length === 0) return 0;
  try {
    const result = await db.queryWithAgentVector("system",
      `DELETE FROM ${SCHEMA}.fragments
        WHERE session_id = $1
          AND source     = $2
          AND valid_to IS NOT NULL
          AND id = ANY($3::text[])`,
      [sessionId, WM_FALLBACK_SOURCE, ids],
      "write"
    );
    return result.rowCount;
  } catch (err) {
    logWarn(`[WorkingMemoryRows] evict failed: ${err.message}`);
    return 0;
  }
}

/**
 * 세션의 작업 기억 행을 모두 지운다.
 *
 * @param {string} sessionId
 * @returns {Promise<number>} 지운 행 수
 */
export async function clearWorkingMemoryRows(sessionId) {
  if (!sessionId) return 0;
  try {
    const result = await db.queryWithAgentVector("system",
      `DELETE FROM ${SCHEMA}.fragments
        WHERE session_id = $1
          AND source     = $2
          AND valid_to IS NOT NULL`,
      [sessionId, WM_FALLBACK_SOURCE],
      "write"
    );
    return result.rowCount;
  } catch (err) {
    logWarn(`[WorkingMemoryRows] clear failed: ${err.message}`);
    return 0;
  }
}

/**
 * 세션의 보관량을 상한 안으로 줄인다.
 *
 * @param {string} sessionId
 * @param {{now?: number}} [opts]
 * @returns {Promise<number>} 지운 행 수
 */
export async function enforceWorkingMemoryRowBudget(sessionId, { now } = {}) {
  const items   = await listWorkingMemoryRows(sessionId, { now });
  const indices = selectBudgetEvictionIndices(items, { maxTokens: WM_MAX_TOKENS, maxRows: WM_MAX_ROWS });
  return evictWorkingMemoryRows(sessionId, [...indices].map(i => items[i].id));
}

/**
 * 한 키의 작업 기억 행을 최대 maxRows개로 줄인다. 행 수를 먼저 세고 상한 이하면 지우지 않는다.
 * 넘는 만큼만 오래된 행부터 지운다. 키가 없는 요청(master)은 key_id가 비어 있는 행끼리 한
 * 묶음이다. 새 행을 쓰기 전에 부르면 쓰고 난 뒤의 행 수가 maxRows 이하다.
 *
 * @param {string|null} keyId
 * @param {number}      maxRows - 지우지 않고 남길 행 수(0 이상)
 * @returns {Promise<number>} 지운 행 수
 */
export async function trimWorkingMemoryRowsOfKey(keyId, maxRows) {
  try {
    const keep      = Math.max(0, maxRows);
    const params    = [WM_FALLBACK_SOURCE];
    const keyClause = keyScopeNullable(params, "key_id", keyId);
    const scope     = `source = $1 AND valid_to IS NOT NULL${keyClause}`;

    const { rows: [counted] } = await db.queryWithAgentVector("system",
      `SELECT count(*)::int AS n FROM ${SCHEMA}.fragments WHERE ${scope}`,
      params
    );
    const excess = (counted?.n ?? 0) - keep;
    if (excess <= 0) return 0;

    const result = await db.queryWithAgentVector("system",
      `DELETE FROM ${SCHEMA}.fragments
        WHERE id IN (
          SELECT id FROM ${SCHEMA}.fragments
           WHERE ${scope}
           ORDER BY created_at ASC, id ASC
           LIMIT $${params.length + 1}
        )`,
      [...params, excess],
      "write"
    );
    return result.rowCount;
  } catch (err) {
    logWarn(`[WorkingMemoryRows] key cap trim failed: ${err.message}`);
    return 0;
  }
}

/**
 * 보관 시간이 지난 작업 기억 행을 모든 세션에서 지운다. 유지보수 주기에서 부른다.
 * 문장 하나가 chunk개씩 지우고 한 번에 최대 maxChunks개 문장을 실행하며, 문장마다 별도
 * 트랜잭션에서 잠금 대기 상한을 건다. 실패하면 경고를 남기고 그때까지 지운 수를 돌려주므로
 * 호출한 유지보수는 이어서 진행한다.
 *
 * @param {{now?: number, chunk?: number, maxChunks?: number}} [opts]
 * @returns {Promise<number>} 지운 행 수
 */
export async function deleteExpiredWorkingMemoryRows({ now, chunk = WM_SWEEP_CHUNK, maxChunks = WM_SWEEP_MAX_CHUNKS } = {}) {
  const cutoff = workingMemoryCutoff(now);
  let deleted  = 0;
  try {
    for (let i = 0; i < maxChunks; i++) {
      const removed = await db.withTransaction(db.getPrimaryPool(), async (client) => {
        await client.query(`SET LOCAL lock_timeout = '${SWEEP_LOCK_TIMEOUT}'`);
        const result = await client.query(
          `DELETE FROM ${SCHEMA}.fragments
            WHERE id IN (
              SELECT id FROM ${SCHEMA}.fragments
               WHERE source = $1
                 AND valid_to IS NOT NULL
                 AND session_id IS NOT NULL
                 AND created_at < $2::timestamptz
               ORDER BY created_at
               LIMIT $3
                 FOR UPDATE SKIP LOCKED
            )`,
          [WM_FALLBACK_SOURCE, cutoff, chunk]
        );
        return result.rowCount;
      });
      deleted += removed;
      if (removed < chunk) break;
    }
  } catch (err) {
    logWarn(`[WorkingMemoryRows] expired sweep stopped after ${deleted} rows: ${err.message}`);
  }
  return deleted;
}
