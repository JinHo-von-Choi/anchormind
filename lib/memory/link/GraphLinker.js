/**
 * GraphLinker - 임베딩 기반 자동 관계 생성 워커
 *
 * 작성자: 최진호
 * 작성일: 2026-03-07
 * 수정일: 2026-10-31 (중복 판정과 링크 후보를 거리 한 번 계산으로 고른다)
 *
 * EmbeddingWorker의 embedding_ready 이벤트를 구독하여
 * 새로 임베딩이 생성된 파편의 유사 파편을 찾아 관계를 자동 생성한다.
 * consolidate 시 기존 파편 간 소급 링킹도 수행한다.
 */

import { FragmentStore }       from "../write/FragmentStore.js";
import { queryWithAgentVector } from "../../tools/db.js";
import { logDebug, logWarn }     from "../../logger.js";

/** PostgreSQL 외래 키 위반. 링크를 만드는 사이 한쪽 파편이 지워졌다. */
const FK_VIOLATION = "23503";
import { SCHEMA, DEINDEX_COLUMNS } from "../schema.js";
import { deindexRows } from "../FragmentIndex.js";
import { keyScopeNullableIndexed } from "../keyScope.js";
import { deletedRowCondition, revivableRowCondition, reviveAssignments } from "./LinkVisibility.js";
import { backgroundTaskDuration } from "../background-metrics.js";

export class GraphLinker {
  constructor() {
    this.store = new FragmentStore();
  }

  /**
   * 단일 파편에 대해 유사 파편을 찾아 관계를 자동 생성한다.
   *
   * 1. DB에서 해당 파편 조회 (embedding IS NOT NULL 확인)
   * 2. 같은 topic + 같은 key_id + similarity > 0.7인 상위 3개 후보를 pgvector cosine으로 검색
   * 3. 관계 유형 결정: related / resolved_by
   *    유사도는 같은 사실인지 판정하지 못하므로 superseded_by를 만들거나 파편을
   *    닫지 않는다. 대체는 remember의 supersedes 인자로 명시한다.
   * 4. store.createLink() 호출 (중복 링크는 ON CONFLICT로 무시)
   *
   * @param {string}      fragmentId
   * @param {string}      agentId
   * @param {string|null} keyId        - DB API key ID (null = master key, 전체 접근)
   * @param {string[]}    groupKeyIds  - 키 그룹 공유 대상 ID 배열 (옵션)
   * @returns {number} 생성된 링크 수
   */
  async linkFragment(fragmentId, agentId = "default", _keyId = null, _groupKeyIds = []) {
    const end = backgroundTaskDuration.startTimer({ task: "graph_linker" });
    try {
      return await this.#linkFragment(fragmentId, agentId);
    } finally {
      end();
    }
  }

  /**
   * @param {string} fragmentId
   * @param {string} agentId
   * @returns {Promise<number>}
   */
  async #linkFragment(fragmentId, agentId) {
    /** 임베딩 존재 여부 + 파편 메타데이터 조회 */
    const fragResult = await queryWithAgentVector(agentId,
      `SELECT id, content, topic, type, created_at, key_id, workspace
       FROM ${SCHEMA}.fragments
       WHERE id = $1 AND embedding IS NOT NULL AND valid_to IS NULL`,
      [fragmentId]
    );

    if (!fragResult.rows || fragResult.rows.length === 0) return 0;

    const newFragment = fragResult.rows[0];

    /**
     * 같은 topic·key 범위의 거리를 한 번만 계산해 중복 판정(이전 파편, 0.90 이상 1위)과 링크 후보(0.7 초과
     * 상위 3)를 함께 고른다. 중복 판정은 소유 범위 안에서만 한다. 스케줄러가 master/system 주체로 불러도
     * 범위는 파편 행의 key_id가 정한다. 중복 판정은 workspace도 같아야 한다. 같은 본문을 workspace마다
     * 따로 저장하는 것은 중복 판정 색인(uq_frag_hash_ws_*)이 허용한 정상 상태다.
     */
    const params    = [fragmentId, newFragment.topic, newFragment.created_at, newFragment.workspace ?? null];
    const keyClause = keyScopeNullableIndexed(params, "f.key_id", newFragment.key_id ?? null);
    const scored = await queryWithAgentVector(agentId,
      `WITH q AS MATERIALIZED (
         SELECT embedding FROM ${SCHEMA}.fragments WHERE id = $1
       ), scored AS MATERIALIZED (
         SELECT f.id, f.created_at, 1 - (f.embedding <=> q.embedding) AS similarity,
                f.workspace IS NOT DISTINCT FROM $4::text AS same_workspace
           FROM ${SCHEMA}.fragments f, q
          WHERE f.id != $1
            AND f.topic = $2
            AND f.embedding IS NOT NULL
            AND f.valid_to IS NULL
            ${keyClause}
       ), picked AS (
         (SELECT 'dedup' AS kind, id, similarity FROM scored
           WHERE similarity >= 0.90
             AND same_workspace
             AND (created_at < $3::timestamptz OR (created_at = $3::timestamptz AND id < $1))
           ORDER BY similarity DESC, id LIMIT 1)
         UNION ALL
         (SELECT 'candidate' AS kind, id, similarity FROM scored
           WHERE similarity > 0.7
           ORDER BY similarity DESC, id LIMIT 3)
       )
       SELECT p.kind, f.id, f.content, f.type, f.created_at, f.is_anchor, p.similarity
         FROM picked p JOIN ${SCHEMA}.fragments f ON f.id = p.id
        ORDER BY p.similarity DESC, f.id`,
      params
    );
    const existing   = scored.rows.find(r => r.kind === "dedup");
    const candidates = scored.rows.filter(r => r.kind === "candidate");

    if (existing) {
      const similarity = parseFloat(existing.similarity);

      if (similarity >= 0.95 && existing.content === newFragment.content) {
        /**
         * 완전 중복: 신규 파편 soft delete + 기존 파편 touch.
         * Embedding similarity alone is not identity: short memories that differ
         * only in a marker/value routinely exceed 0.95.  The content equality and
         * stable created_at/id ordering keep distinct batch rows alive and prevent
         * concurrent embedding_ready handlers from retiring each other.
         */
        await queryWithAgentVector(agentId,
          `UPDATE ${SCHEMA}.fragments SET valid_to = NOW()
           WHERE id = $1 AND valid_to IS NULL RETURNING ${DEINDEX_COLUMNS}`,
          [fragmentId], "write"
        ).then(r => deindexRows(r.rows));
        await queryWithAgentVector(agentId,
          `UPDATE ${SCHEMA}.fragments SET access_count = access_count + 1
           WHERE id = $1`,
          [existing.id], "write"
        );
        logDebug(`[GraphLinker] Dedup: ${fragmentId} is duplicate of ${existing.id} (cos=${similarity.toFixed(4)})`);
        return 0;
      }

      /** 유사하지만 내용이 다른 파편: 경고 후 링크 생성 계속 */
      logWarn(`[GraphLinker] Near-duplicate detected: ${fragmentId} ~ ${existing.id} (cos=${similarity.toFixed(4)})`);
    }

    if (candidates.length === 0) return 0;

    let linkCount = 0;

    for (const candidate of candidates) {
      let relationType = "related";

      /** error -> error(resolved): resolved_by 링크 */
      if (newFragment.type === "error" && candidate.type === "error") {
        if (newFragment.content.includes("[해결됨]") || newFragment.content.includes("resolved")) {
          relationType = "resolved_by";
        }
      }

      try {
        await this.store.createLink(candidate.id, newFragment.id, relationType, agentId, 1, { producer: "graph_linker" });
        linkCount++;
      } catch (err) {
        /** 그사이 지워진 파편(외래 키)만 조용히 건너뛴다. 중복은 쓰기 경로가 ON CONFLICT로 처리한다. */
        if (err?.code !== FK_VIOLATION) logWarn(`[GraphLinker] 링크 생성 실패 ${candidate.id}->${newFragment.id}: ${err.message}`);
      }
    }

    return linkCount;
  }

  /**
   * 임베딩은 있지만 링크가 전혀 없는 고립 파편에 대해 소급 링킹 수행.
   *
   * fragment_links에 from_id/to_id로 참여하지 않는 파편을
   * batchSize개 조회하여 각각 linkFragment()를 호출한다.
   *
   * @param {number} batchSize
   * @returns {{ processed: number, linksCreated: number }}
   */
  async retroLink(batchSize = 20) {
    const isolated = await queryWithAgentVector("system",
      `SELECT f.id
       FROM ${SCHEMA}.fragments f
       WHERE f.embedding IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM ${SCHEMA}.fragment_links l
           WHERE l.from_id = f.id OR l.to_id = f.id
         )
       ORDER BY f.created_at DESC
       LIMIT $1`,
      [batchSize]
    );

    let processed    = 0;
    let linksCreated = 0;

    for (const row of isolated.rows) {
      const count = await this.linkFragment(row.id, "system");
      processed++;
      linksCreated += count;
    }

    if (linksCreated > 0) {
      logDebug(`[GraphLinker] retroLink: processed=${processed}, linksCreated=${linksCreated}`);
    }

    return { processed, linksCreated };
  }

  /**
   * 동일 세션에서 함께 회상된 파편들 간 co-retrieval 링크를 생성/강화한다.
   *
   * 이미 링크가 있으면 weight + 1, 없으면 weight = 1로 신규 생성.
   * 상위 5개 파편만 페어링하여 조합 수를 C(5,2) = 10으로 제한.
   *
   * @param {string[]} fragmentIds - 같은 recall 결과에 포함된 파편 ID 목록
   * @param {string}   sessionId
   * @param {string}   agentId
   * @returns {Promise<number>} 처리된 링크 수
   */
  async buildCoRetrievalLinks(fragmentIds, sessionId, agentId = "default") {
    if (!fragmentIds || fragmentIds.length < 2) return 0;

    const ids  = fragmentIds.slice(0, 5);
    let   count = 0;

    for (let i = 0; i < ids.length; i++) {
      // iron-laws: ignore[PERF-102] 안쪽 반복 대상의 크기가 작게 제한돼 있다
      for (let j = i + 1; j < ids.length; j++) {
        try {
          await queryWithAgentVector(agentId,
            `INSERT INTO ${SCHEMA}.fragment_links (from_id, to_id, relation_type, weight)
             VALUES ($1, $2, 'co_retrieved', 1)
             ON CONFLICT (from_id, to_id) DO UPDATE
               SET relation_type = CASE WHEN ${deletedRowCondition(`${SCHEMA}.fragment_links`)}
                                        THEN 'co_retrieved' ELSE ${SCHEMA}.fragment_links.relation_type END,
                   weight        = CASE WHEN ${deletedRowCondition(`${SCHEMA}.fragment_links`)}
                                        THEN 1 ELSE ${SCHEMA}.fragment_links.weight + 1 END${reviveAssignments()}
               WHERE ${revivableRowCondition(`${SCHEMA}.fragment_links`)}`,
            [ids[i], ids[j]], "write"
          );
          count++;
        } catch (err) {
          /** 그사이 지워진 파편(외래 키)만 조용히 건너뛴다. 중복은 ON CONFLICT가 처리한다. */
          if (err?.code !== FK_VIOLATION) logWarn(`[GraphLinker] 함께 회상 링크 실패 ${ids[i]}->${ids[j]}: ${err.message}`);
        }
      }
    }

    return count;
  }
}
