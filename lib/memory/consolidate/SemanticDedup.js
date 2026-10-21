/**
 * SemanticDedup - consolidate의 시맨틱 중복 제거 단계
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 *
 * 파편이 minFragments 이상인 topic(파편 수 상위 batchSize개)을 고르고, topic 안을
 * (workspace, key_id) 묶음으로 나눠 묶음 벡터를 한 번 읽는다. 묶음 안 모든 쌍의 코사인을
 * 메모리에서 계산해 파편마다 정확 top-3 이웃을 구하고, cos >= 0.92인 비앵커 쌍을 안전
 * 게이트를 거쳐 병합한다. 생존자는 (created_at, id)가 큰 쪽이다.
 *
 * 파편마다 KNN 질의를 보내던 방식은 주기마다 질의 수가 유효 파편 수만큼 들었다. 묶음 단위
 * 계산은 묶음당 적재 질의 하나로 끝나고 근사 색인이 놓치는 이웃도 없다. 상태를 저장하지
 * 않으므로 매 주기 전수를 다시 본다. 단계 시간이 dedup.timeBudgetMs를 넘으면 남은 topic은
 * 다음 주기로 넘긴다.
 */

import { getPrimaryPool, queryWithAgentVector, withTransaction } from "../../tools/db.js";
import { buildSearchPath } from "../../config.js";
import { MEMORY_CONFIG } from "../../../config/memory.js";
import { logInfo, logWarn, logDebug } from "../../logger.js";
import { deindexRows } from "../FragmentIndex.js";
import { SCHEMA } from "../schema.js";
import { keyScopeNullable } from "../keyScope.js";
import { judgeMergePair } from "./consolidate-gate.js";
import { recordGateBlock, recordGateAllow } from "./gate-metrics.js";
import { toUnitVector, topNeighbors } from "./exactNeighbors.js";

export const COS_THRESHOLD = 0.92;

/** 파편마다 판정하는 이웃 수 */
const NEIGHBORS_PER_FRAGMENT = 3;

/** 차단 사유별로 debug 로그에 남기는 표본 수 */
const BLOCK_SAMPLES = 20;

/**
 * 병합 생존자 순서. created_at이 늦은 쪽, 같으면 id가 큰 쪽이 앞선다.
 *
 * @param {{createdAt: number, id: string}} a
 * @param {{createdAt: number, id: string}} b
 * @returns {number} a가 앞서면 양수
 */
export function compareRecency(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 시맨틱 중복 제거 한 회차.
 *
 * @param {{ now?: () => number }} [opts]
 * @returns {Promise<number>} 병합된 쌍 수
 */
export async function runSemanticDedup({ now = Date.now } = {}) {
  const cfg       = MEMORY_CONFIG.dedup || {};
  const budgetMs  = cfg.timeBudgetMs || 1200000;
  const startedAt = now();
  const topics    = await loadTopics(cfg.minFragments || 5, cfg.batchSize || 100);
  if (topics.length === 0) return 0;

  const run = {
    gateCfg  : MEMORY_CONFIG.consolidate?.gate || {},
    processed: new Set(),
    stats    : { merged: 0, blocked: 0, rolledBack: 0, groups: 0, topicsLeft: 0 },
    blocks   : new Map()
  };

  for (let ti = 0; ti < topics.length; ti++) {
    if (now() - startedAt > budgetMs) {
      run.stats.topicsLeft = topics.length - ti;
      break;
    }
    for (const g of await loadGroups(topics[ti])) {
      run.stats.groups++;
      await dedupGroup(topics[ti], g.workspace ?? null, g.key_id ?? null, run);
    }
  }

  logSummary(run, now() - startedAt);
  return run.stats.merged;
}

/** 파편이 minFragments 이상인 topic, 파편 수 내림차순 상위 limit개 */
async function loadTopics(minFragments, limit) {
  const { rows } = await queryWithAgentVector("system",
    `SELECT topic, COUNT(*) AS cnt
     FROM ${SCHEMA}.fragments
     WHERE embedding IS NOT NULL
       AND valid_to IS NULL
       AND topic IS NOT NULL
     GROUP BY topic
     HAVING COUNT(*) >= $1
     ORDER BY cnt DESC
     LIMIT $2`,
    [minFragments, limit]
  );
  return rows.map(r => r.topic);
}

/** topic 안 파편이 둘 이상인 (workspace, key_id) 묶음 */
async function loadGroups(topic) {
  const { rows } = await queryWithAgentVector("system",
    `SELECT workspace, key_id
     FROM ${SCHEMA}.fragments
     WHERE topic = $1
       AND embedding IS NOT NULL
       AND valid_to IS NULL
     GROUP BY workspace, key_id
     HAVING COUNT(*) >= 2`,
    [topic]
  );
  return rows;
}

/**
 * 묶음 파편과 단위 벡터를 읽는다. 후보는 같은 topic·workspace·key 안으로 제한된다.
 *
 * @returns {Promise<{frags: Array, vectors: Array<Float32Array>}>}
 */
async function loadGroup(topic, workspace, keyId) {
  const params    = [topic, workspace];
  const keyClause = keyScopeNullable(params, "key_id", keyId);
  const { rows }  = await queryWithAgentVector("system",
    `SELECT id, content, created_at, is_anchor, embedding::text AS embedding
     FROM ${SCHEMA}.fragments
     WHERE topic = $1
       AND workspace IS NOT DISTINCT FROM $2
       AND embedding IS NOT NULL
       AND valid_to IS NULL
       ${keyClause}`,
    params
  );
  const frags   = [];
  const vectors = [];
  for (const r of rows) {
    const v = toUnitVector(r.embedding);
    if (!v) continue;
    frags.push({ id: r.id, content: r.content, createdAt: new Date(r.created_at).getTime(), isAnchor: r.is_anchor === true });
    vectors.push(v);
  }
  return { frags, vectors };
}

/** 묶음 하나의 병합 후보를 정확 top-3로 구해 병합한다. */
async function dedupGroup(topic, workspace, keyId, run) {
  const { frags, vectors } = await loadGroup(topic, workspace, keyId);
  if (frags.length < 2) return;
  const neighbors = await topNeighbors(vectors, NEIGHBORS_PER_FRAGMENT);

  /** 최신 파편부터 돌며 자신의 top-3 후보를 판정한다. 같은 쌍은 한 번만 본다. */
  const order  = frags.map((_, i) => i).sort((a, b) => compareRecency(frags[b], frags[a]));
  const judged = new Set();
  for (const i of order) {
    const frag = frags[i];
    if (frag.isAnchor || run.processed.has(frag.id)) continue;
    for (const { index, cosine } of neighbors[i]) {
      const closedSelf = await judgeCandidate(frag, frags[index], cosine, judged, run);
      /** 순회 중인 파편 자신이 닫혔으면 더는 승계자가 될 수 없다 */
      if (closedSelf) break;
    }
  }
}

/**
 * 후보 하나를 판정하고 병합한다.
 *
 * @returns {Promise<boolean>} 순회 중인 파편 frag가 병합으로 닫혔으면 true
 */
async function judgeCandidate(frag, candidate, cosine, judged, run) {
  if (cosine < COS_THRESHOLD || candidate.isAnchor || run.processed.has(candidate.id)) return false;
  const pairKey = frag.id < candidate.id ? `${frag.id}|${candidate.id}` : `${candidate.id}|${frag.id}`;
  if (judged.has(pairKey)) return false;
  judged.add(pairKey);

  /** 병합: (created_at, id)가 큰 파편 유지, 다른 쪽 soft delete */
  const fragKept = compareRecency(frag, candidate) > 0;
  const keep     = fragKept ? frag : candidate;
  const old      = fragKept ? candidate : frag;
  if (!passesGate(keep, old, cosine, run)) return false;

  const { merged, rolledBack, closedRows } = await mergeDedupPair(keep.id, old.id);
  if (!merged) {
    /** 롤백·이미 닫힘: 다음 후보로 넘어간다. 상태를 남기지 않으므로 다음 주기에 다시 본다. */
    if (rolledBack) run.stats.rolledBack++;
    return false;
  }
  await deindexRows(closedRows);
  run.processed.add(old.id);
  run.stats.merged++;
  return old.id === frag.id;
}

/**
 * 안전 게이트: 파괴 전 판정. 코사인은 수치만 다른 문장을 구분하지 못하므로
 * 제거 대상의 변별 토큰이 승계자에 남는지 확인한 뒤에만 병합한다.
 */
function passesGate(keep, old, cosine, run) {
  if (run.gateCfg.enabled === false) return true;
  const verdict = judgeMergePair(
    { keepContent: keep.content, oldContent: old.content, cosine },
    { minCosine: COS_THRESHOLD, maxLostTokens: run.gateCfg.maxLostTokens ?? 0 }
  );
  if (verdict.allow) {
    recordGateAllow("semantic_dedup");
    return true;
  }
  recordGateBlock("semantic_dedup", verdict.reason);
  run.stats.blocked++;
  const b = run.blocks.get(verdict.reason) ?? { count: 0, samples: [] };
  b.count++;
  if (b.samples.length < BLOCK_SAMPLES) b.samples.push({ keepId: keep.id, oldId: old.id, lost: verdict.lostTokens.slice(0, 5) });
  run.blocks.set(verdict.reason, b);
  return false;
}

/** 단계 결과 한 줄과 차단 표본(debug) */
function logSummary(run, elapsedMs) {
  const s = run.stats;
  if (s.merged === 0 && s.blocked === 0 && s.rolledBack === 0 && s.topicsLeft === 0) return;
  const reasons = [...run.blocks.entries()].map(([r, b]) => `${r}=${b.count}`).join(",");
  logInfo(`[SemanticDedup] merged ${s.merged} pairs, gate blocked ${s.blocked}${reasons ? ` (${reasons})` : ""}` +
          `, rolled back ${s.rolledBack}, groups ${s.groups}, topics deferred ${s.topicsLeft}, ${elapsedMs}ms`);
  for (const [reason, b] of run.blocks) {
    for (const x of b.samples) {
      logDebug(`[SemanticDedup] 병합 차단 표본 (${reason}) keep=${x.keepId} old=${x.oldId}` +
               (x.lost.length > 0 ? ` lost=${x.lost.join(",")}` : ""));
    }
  }
}

/**
 * 두 파편을 병합한다. 이전 파편을 닫고 링크와 access_count를 승계자로 옮긴다.
 *
 * 병합의 쓰기 전부를 한 트랜잭션으로 묶는다. 두 행을 잠근 뒤 어느 한쪽이라도
 * 이미 닫혀 있으면 아무것도 쓰지 않고 건너뛴다. 잠금 수준은 비키 열 갱신에
 * 필요한 NO KEY UPDATE 로 두어 다른 링크 삽입의 외래키 검사를 막지 않는다.
 *
 * @param {string} keepId
 * @param {string} oldId
 * @returns {Promise<{merged: boolean, rolledBack: boolean, closedRows: Array}>}
 */
export async function mergeDedupPair(keepId, oldId) {
  let closedRows = [];
  try {
    const merged = await withTransaction(getPrimaryPool(), async (client) => {
      await client.query(buildSearchPath(SCHEMA));
      await client.query("SET LOCAL app.current_agent_id = 'system'");
      await client.query("SET LOCAL app.current_key_id = ''");
      const alive = await client.query(
        `SELECT id, access_count FROM ${SCHEMA}.fragments
          WHERE id = ANY($1) AND valid_to IS NULL
          ORDER BY id FOR NO KEY UPDATE`,
        [[keepId, oldId]]
      );
      if (alive.rowCount !== 2) return false;

      /** 잠근 시점의 값으로 합산해 같은 승계자가 여러 번 병합돼도 누적이 유실되지 않게 한다 */
      const combinedAccess = alive.rows.reduce((sum, r) => sum + (parseInt(r.access_count) || 0), 0);

      /** 링크 이전 (from_id). 승계자에 같은 (from_id, to_id) 쌍이 이미 있으면 건너뛴다. */
      await client.query(
        `UPDATE ${SCHEMA}.fragment_links l SET from_id = $1
          WHERE l.from_id = $2 AND l.to_id != $1
            AND NOT EXISTS (
              SELECT 1 FROM ${SCHEMA}.fragment_links e
               WHERE e.from_id = $1 AND e.to_id = l.to_id
            )`,
        [keepId, oldId]
      );
      await client.query(
        `DELETE FROM ${SCHEMA}.fragment_links WHERE from_id = $1 AND to_id = $2`,
        [oldId, keepId]
      );

      /** 링크 이전 (to_id). 승계자에 같은 (from_id, to_id) 쌍이 이미 있으면 건너뛴다. */
      await client.query(
        `UPDATE ${SCHEMA}.fragment_links l SET to_id = $1
          WHERE l.to_id = $2 AND l.from_id != $1
            AND NOT EXISTS (
              SELECT 1 FROM ${SCHEMA}.fragment_links e
               WHERE e.from_id = l.from_id AND e.to_id = $1
            )`,
        [keepId, oldId]
      );
      await client.query(
        `DELETE FROM ${SCHEMA}.fragment_links WHERE from_id = $1 AND to_id = $2`,
        [keepId, oldId]
      );

      /** 이전 파편 soft delete, 폐기 출처 링크와 양방향 linked_to, access_count 합산 */
      const closedRes = await client.query(
        `UPDATE ${SCHEMA}.fragments SET valid_to = NOW()
          WHERE id = $1 AND valid_to IS NULL
          RETURNING id, keywords, topic, type, key_id`,
        [oldId]
      );
      closedRows = closedRes.rows;
      await client.query(
        `INSERT INTO ${SCHEMA}.fragment_links (from_id, to_id, relation_type, weight)
         VALUES ($1, $2, 'superseded_by', 1)
         ON CONFLICT (from_id, to_id) DO UPDATE SET relation_type = 'superseded_by'`,
        [oldId, keepId]
      );
      await client.query(
        `UPDATE ${SCHEMA}.fragments SET linked_to = array_append(linked_to, $2)
          WHERE id = $1 AND NOT ($2 = ANY(linked_to))`,
        [oldId, keepId]
      );
      await client.query(
        `UPDATE ${SCHEMA}.fragments SET linked_to = array_append(linked_to, $1)
          WHERE id = $2 AND NOT ($1 = ANY(linked_to))`,
        [oldId, keepId]
      );
      await client.query(
        `UPDATE ${SCHEMA}.fragments SET access_count = $1 WHERE id = $2`,
        [combinedAccess, keepId]
      );
      return true;
    });
    return { merged, rolledBack: false, closedRows };
  } catch (err) {
    logWarn(`[SemanticDedup] 병합 롤백 keep=${keepId} old=${oldId}: ${err.message}`);
    return { merged: false, rolledBack: true, closedRows: [] };
  }
}
