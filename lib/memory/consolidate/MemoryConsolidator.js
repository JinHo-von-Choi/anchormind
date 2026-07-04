/**
 * MemoryConsolidator - TTL 전환, 중복 제거, 망각 관리, 모순 탐지
 *
 * 작성자: 최진호
 * 작성일: 2026-02-23
 * 수정일: 2026-02-28
 *
 * 주기적 유지보수 작업을 수행하여 파편 저장소 건강도 유지
 * utility_score 갱신, 증분 모순 탐지(Gemini Flash)
 */

import { performance }      from "node:perf_hooks";
import { FragmentStore }    from "../write/FragmentStore.js";
import { getFragmentIndex } from "../FragmentIndex.js";
import { EmbeddingWorker }  from "../embedding/EmbeddingWorker.js";
import { getPrimaryPool, queryWithAgentVector } from "../../tools/db.js";
import { MEMORY_CONFIG } from "../../../config/memory.js";
import { logInfo, logWarn, logError } from "../../logger.js";
import { ContradictionDetector } from "../link/ContradictionDetector.js";
import { ConsolidatorGC }        from "./ConsolidatorGC.js";
import { pushToQueue }           from "../../redis.js";

/**
 * 개별 스테이지 실행 시간 및 결과를 계측한다.
 *
 * @param {string}            name - 스테이지 이름
 * @param {() => Promise<*>}  fn   - 실행할 비동기 함수
 * @returns {Promise<{name: string, durationMs: number, affected: number, status: string, error?: string}>}
 */
async function timedStage(name, fn) {
  const start = performance.now();
  try {
    const result = await fn();
    /** fn이 { status, affected } 형태의 제어 객체를 반환하면 그대로 사용한다 */
    if (result !== null && typeof result === "object" && !Array.isArray(result)
        && typeof result.status === "string") {
      return { name, durationMs: Math.round(performance.now() - start), affected: result.affected ?? 0, status: result.status };
    }
    const affected = (result !== null && result !== undefined && result !== false)
      ? (typeof result === "number" ? result : (Array.isArray(result) ? result.length : 1))
      : 0;
    return { name, durationMs: Math.round(performance.now() - start), affected, status: "ok" };
  } catch (err) {
    return { name, durationMs: Math.round(performance.now() - start), affected: 0, status: "error", error: err.message };
  }
}

const SCHEMA = "agent_memory";

const CONSOLIDATION_QUEUE = {
  tail   : Promise.resolve(),
  running: false,
  waiting: 0
};

export class MemoryConsolidator {
  constructor() {
    this.store                = new FragmentStore();
    this.index                = getFragmentIndex();
    this.contradictionDetector = new ContradictionDetector(this.store);
    this.consolidatorGC        = new ConsolidatorGC(this.store);
  }

  /**
   * 전체 유지보수 실행 (master key 전용)
   *
   * @param {((event: {phase: string, processed: number, total: number, skipped: number, errors: number}) => void)|null} [onProgress]
   *   진행 이벤트 콜백. 각 스테이지 완료 시 호출된다. 제공되지 않으면 no-op.
   * @returns {Promise<Object>} 작업 결과 요약
   */
  async consolidate(onProgress = null) {
    const queued      = CONSOLIDATION_QUEUE.running || CONSOLIDATION_QUEUE.waiting > 0;
    const waitStartMs = Date.now();
    CONSOLIDATION_QUEUE.waiting += 1;

    const previous = CONSOLIDATION_QUEUE.tail.catch(() => {});
    let releaseSlot;
    const slot = new Promise(resolve => { releaseSlot = resolve; });
    CONSOLIDATION_QUEUE.tail = previous.then(() => slot);

    await previous;
    CONSOLIDATION_QUEUE.waiting -= 1;
    CONSOLIDATION_QUEUE.running = true;
    const queueWaitMs = Date.now() - waitStartMs;

    try {
      if (queued) {
        logInfo("[MemoryConsolidator] Consolidation request queued behind active run");
      }
      const result = await this._runConsolidationCycle(onProgress);
      return {
        ...result,
        queued,
        queueWaitMs
      };
    } finally {
      releaseSlot();
      CONSOLIDATION_QUEUE.running = false;
    }
  }

  async _runConsolidationCycle(onProgress = null) {
    const emit       = (typeof onProgress === "function") ? onProgress : () => {};
    const cycleStart = Date.now();
    logInfo("[MemoryConsolidator] Consolidation cycle started");

    const results = {
      ttlTransitions       : 0,
      importanceDecay      : false,
      expiredDeleted       : 0,
      fragmentsSplit       : 0,
      duplicatesMerged     : 0,
      semanticDedupMerged  : 0,
      compressedFragments  : 0,
      embeddingsAdded      : 0,
      retroLinked          : 0,
      utilityUpdated       : 0,
      anchorsPromoted      : 0,
      contradictionsFound       : 0,
      nliResolvedDirectly       : 0,
      nliSkippedAsNonContra     : 0,
      feedbackReportGenerated   : false,
      gcCandidatesByType       : {},
      indexesPruned            : false,
      supersessionsDetected    : 0,
      stale_fragments          : [],
      reflectionsPurged        : 0,
      searchEventsGarbageCollected: 0
    };

    /**
     * Cycle 동안 stage 간 공유하는 상태(closure 캡처용).
     * - contraResult: detect_contradictions가 단일 숫자를 넘어 nliResolved/nliSkipped를 함께 전달한다.
     * - staleList: collect_stale_fragments가 배열 자체를 results에 노출한다.
     */
    const ctx = {
      contraResult: { found: 0, nliResolved: 0, nliSkipped: 0 },
      staleList   : []
    };

    const stageDefs = this._buildStages(ctx, results);
    const stages    = await this._executeStages(stageDefs, results, emit);

    const elapsed = Date.now() - cycleStart;
    logInfo(`[MemoryConsolidator] Consolidation cycle finished in ${elapsed}ms`, { results });
    return { ...results, stages };
  }

  /**
   * Consolidation stage 정의 배열을 구성한다.
   *
   * 새 stage 추가 시 이 배열에 한 항목만 push하면 TOTAL_STAGES와 progress가 자동 반영된다.
   *
   * @param {{ contraResult: Object, staleList: Array }} ctx   - stage 간 공유 상태
   * @param {Object}                                    results - 결과 집계 객체
   * @returns {Array<{
   *   name     : string,
   *   fn       : () => Promise<*>,
   *   onResult?: (stage: {status: string, affected: number, error?: string}) => void
   * }>}
   */
  _buildStages(ctx, results) {
    return [
      ...this._lifecycleStages(ctx, results),
      ...this._dedupCompressionStages(ctx, results),
      ...this._enrichmentStages(ctx, results),
      ...this._integrityStages(ctx, results),
      ...this._feedbackCleanupStages(ctx, results)
    ];
  }

  /** 모순 후처리·피드백 리포트/보정·인덱스 및 파편 GC 정리 stage 그룹 */
  _feedbackCleanupStages(ctx, results) {
    return [
      {
        name    : "process_pending_contradictions",
        fn      : () => this._processPendingContradictions(),
        onResult: (s) => { results.pendingContradictions = s.affected; }
      },
      {
        name    : "feedback_report",
        fn      : () => this._generateFeedbackReport(),
        onResult: (s) => { results.feedbackReportGenerated = s.status === "ok" && s.affected > 0; }
      },
      {
        name    : "feedback_calibration",
        fn      : () => this._calibrateByFeedback(),
        onResult: (s) => {
          if (s.affected > 0) {
            logWarn(`[MemoryConsolidator] Feedback calibration: ${s.affected} fragments updated`);
          }
        }
      },
      {
        name    : "prune_keyword_indexes",
        fn      : async () => { await this.index.pruneKeywordIndexes(); return 1; },
        onResult: (s) => { results.indexesPruned = s.status === "ok"; }
      },
      {
        name: "collect_stale_fragments",
        fn  : async () => {
          ctx.staleList = await this._collectStaleFragments();
          return Array.isArray(ctx.staleList) ? ctx.staleList.length : 0;
        },
        onResult: () => { results.stale_fragments = ctx.staleList; }
      },
      {
        name    : "purge_stale_reflections",
        fn      : () => this._purgeStaleReflections(),
        onResult: (s) => { results.reflectionsPurged = s.affected; }
      },
      {
        name    : "gc_search_events",
        fn      : () => this._gcSearchEvents(),
        onResult: (s) => { results.searchEventsGarbageCollected = s.affected; }
      }
    ];
  }

  /** TTL 전환·중요도 감쇠·만료 삭제·GC 프리뷰 stage 그룹 */
  _lifecycleStages(ctx, results) {
    return [
      {
        name    : "ttl_transition",
        fn      : () => this._transitionWithCount(),
        onResult: (s) => { results.ttlTransitions = s.affected; }
      },
      {
        name    : "importance_decay",
        fn      : async () => { await this.store.decayImportance(); return 1; },
        onResult: (s) => { results.importanceDecay = s.status === "ok"; }
      },
      {
        name    : "expired_delete",
        fn      : () => this.store.deleteExpired(),
        onResult: (s) => { results.expiredDeleted = s.affected; }
      },
      {
        name: "gc_preview",
        fn  : async () => {
          const gcPreview = await queryWithAgentVector("system",
            `SELECT type, COUNT(*) as cnt FROM ${SCHEMA}.fragments
             WHERE utility_score < ${MEMORY_CONFIG.gc?.utilityThreshold || 0.15}
               AND ttl_tier NOT IN ('permanent') AND is_anchor = FALSE
             GROUP BY type`,
            []
          );
          results.gcCandidatesByType = Object.fromEntries(
            gcPreview.rows.map(r => [r.type, parseInt(r.cnt)])
          );
          return gcPreview.rows.length;
        },
        onResult: (s) => {
          if (s.status === "error") {
            logWarn(`[MemoryConsolidator] GC preview query failed: ${s.error}`);
            results.gcCandidatesByType = {};
          }
        }
      }
    ];
  }

  /** 장문 분할·중복 병합·시맨틱 중복 제거·구파편 압축 stage 그룹 */
  _dedupCompressionStages(ctx, results) {
    return [
      {
        name: "split_long_fragments",
        fn  : () => {
          if (MEMORY_CONFIG.consolidate?.enableRiskyStages?.splitLongFragments === false) {
            return Promise.resolve({ status: "skipped", affected: 0 });
          }
          return this._splitLongFragments();
        },
        onResult: (s) => { results.fragmentsSplit = s.affected; }
      },
      {
        name    : "merge_duplicates",
        fn      : () => this._mergeDuplicates(),
        onResult: (s) => { results.duplicatesMerged = s.affected; }
      },
      {
        name    : "semantic_dedup",
        fn      : () => this._semanticDedup(),
        onResult: (s) => { results.semanticDedupMerged = s.affected; }
      },
      {
        name: "compress_old_fragments",
        fn  : () => {
          if (MEMORY_CONFIG.consolidate?.enableRiskyStages?.compressOldFragments === false) {
            return Promise.resolve({ status: "skipped", affected: 0 });
          }
          return this._compressOldFragments();
        },
        onResult: (s) => { results.compressedFragments = s.affected; }
      }
    ];
  }

  /** 임베딩 백필·역방향 링크·유틸리티 점수 갱신·재큐잉·앵커 승격 stage 그룹 */
  _enrichmentStages(ctx, results) {
    return [
      {
        name    : "embeddings_backfill",
        fn      : async () => { const _embWorker = new EmbeddingWorker(); return _embWorker.processOrphanFragments(5); },
        onResult: (s) => { results.embeddingsAdded = s.affected; }
      },
      {
        name: "retro_link",
        fn  : async () => {
          const { GraphLinker } = await import("../link/GraphLinker.js");
          const linker          = new GraphLinker();
          const retroResult     = await linker.retroLink(20);
          results.retroLinked   = retroResult.linksCreated;
          return retroResult.linksCreated;
        }
      },
      {
        name    : "utility_score_update",
        fn      : () => this._updateUtilityScores(),
        onResult: (s) => { results.utilityUpdated = s.affected; }
      },
      {
        name    : "requeue_high_ema",
        fn      : () => this._requeueHighEmaLowQuality(),
        onResult: (s) => {
          if (s.affected > 0) {
            logInfo(`[MemoryConsolidator] ${s.affected}개 파편 재평가 큐 등록`);
          }
        }
      },
      {
        name    : "promote_anchors",
        fn      : () => this._promoteAnchors(),
        onResult: (s) => { results.anchorsPromoted = s.affected; }
      }
    ];
  }

  /** 모순 탐지·승계 탐지 stage 그룹 */
  _integrityStages(ctx, results) {
    return [
      {
        name: "detect_contradictions",
        fn  : async () => {
          if (MEMORY_CONFIG.consolidate?.enableRiskyStages?.detectContradictions === false) {
            ctx.contraResult = { found: 0, nliResolved: 0, nliSkipped: 0 };
            return Promise.resolve({ status: "skipped", affected: 0 });
          }
          ctx.contraResult = await this._detectContradictions();
          return ctx.contraResult.found ?? 0;
        },
        onResult: () => {
          results.contradictionsFound   = ctx.contraResult.found;
          results.nliResolvedDirectly   = ctx.contraResult.nliResolved;
          results.nliSkippedAsNonContra = ctx.contraResult.nliSkipped;
        }
      },
      {
        name    : "detect_supersessions",
        fn      : () => this._detectSupersessions(),
        onResult: (s) => { results.supersessionsDetected = s.affected; }
      }
    ];
  }

  /**
   * stage 정의 배열을 순서대로 실행하고 계측 결과 배열을 반환한다.
   *
   * 각 stage는 timedStage로 계측되며 오류 시에도 중단하지 않고 다음 stage로 진행한다.
   * 예기치 않은 throw는 logError 후 results.error에 기록한다.
   *
   * @param {Array}    stageDefs - _buildStages()가 반환한 stage 정의 배열
   * @param {Object}   results   - 결과 집계 객체 (onResult 콜백이 직접 갱신)
   * @param {Function} emit      - 진행 이벤트 콜백
   * @returns {Promise<Array<{name: string, durationMs: number, affected: number, status: string, error?: string}>>}
   */
  async _executeStages(stageDefs, results, emit) {
    const TOTAL_STAGES = stageDefs.length;
    const stages       = [];

    try {
      this.contradictionDetector.resetCheckedPairs();

      for (const def of stageDefs) {
        const s = await timedStage(def.name, def.fn);
        stages.push(s);
        if (typeof def.onResult === "function") {
          try { def.onResult(s); }
          catch (err) { logWarn(`[MemoryConsolidator] onResult hook failed for ${def.name}: ${err.message}`); }
        }
        emit({
          phase    : def.name,
          processed: stages.length,
          total    : TOTAL_STAGES,
          skipped  : 0,
          errors   : s.status === "error" ? 1 : 0
        });
      }
    } catch (err) {
      logError(`[MemoryConsolidator] consolidation error: ${err.message}`, err);
      results.error = err.message;
    }

    return stages;
  }

  /**
     * 중복 파편 병합.
     *
     * migration-031 이후 content_hash UNIQUE 범위는 (key_id, content_hash)로 per-key다.
     * 두 키에 동일 content_hash가 존재하는 것은 정상 상태이므로 그룹 키를
     * (key_id, workspace, content_hash)로 한정하여 cross-tenant 병합을 차단한다.
     * master 키(key_id IS NULL)는 자동 병합 대상에서 제외한다.
     */
  async _mergeDuplicates() {
    const result = await queryWithAgentVector("system",
      `WITH dups AS (
                SELECT key_id,
                       workspace,
                       content_hash,
                       array_agg(id ORDER BY importance DESC, created_at ASC) AS ids,
                       count(*) AS cnt
                FROM ${SCHEMA}.fragments
                WHERE key_id IS NOT NULL
                GROUP BY key_id, workspace, content_hash
                HAVING count(*) > 1
             )
             SELECT * FROM dups LIMIT 50`
    );

    let merged = 0;

    for (const dup of result.rows) {
      const keepId    = dup.ids[0];
      const removeIds = dup.ids.slice(1);
      const groupKey  = dup.key_id;

      /**
       * group 동질성 어설션: 같은 (key_id, workspace, content_hash) 안의 row만 병합한다.
       * SQL GROUP BY 이후에도 키/워크스페이스 검증을 한 번 더 확인하여 회귀 방지.
       */
      const verify = await queryWithAgentVector("system",
        `SELECT id, key_id, workspace
                 FROM ${SCHEMA}.fragments
                 WHERE id = ANY($1::uuid[])`,
        [[keepId, ...removeIds]]
      );
      const scopeMismatch = verify.rows.some(r =>
        r.key_id !== groupKey || (r.workspace ?? null) !== (dup.workspace ?? null)
      );
      if (scopeMismatch) {
        logWarn(`[MemoryConsolidator] _mergeDuplicates scope mismatch detected, skip group key_id=${groupKey}`);
        continue;
      }

      for (const rid of removeIds) {
        /** 링크를 승계자에게 이전 (동일 키 범위 내에서만) */
        await queryWithAgentVector("system",
          `UPDATE ${SCHEMA}.fragments
                     SET linked_to = array_append(
                         CASE WHEN NOT ($1 = ANY(linked_to)) THEN linked_to ELSE linked_to END, $1
                     )
                     WHERE id = ANY($2) AND key_id = $3 AND NOT ($1 = ANY(linked_to))
                     RETURNING id`,
          [keepId, [rid], groupKey],
          "write"
        );

        /** linked_to 참조를 승계자로 교체 (동일 키 범위 내에서만) */
        await queryWithAgentVector("system",
          `UPDATE ${SCHEMA}.fragments
                     SET linked_to = array_replace(linked_to, $1, $2)
                     WHERE $1 = ANY(linked_to) AND key_id = $3`,
          [rid, keepId, groupKey],
          "write"
        );

        await this.store.delete(rid, "system", groupKey);
        merged++;
      }
    }

    return merged;
  }

  /**
     * TTL 전환 + 전환 수 추적
     * 전환 전후의 ttl_tier 분포를 비교하여 실제 전환 건수를 반환한다.
     */
  async _transitionWithCount() {
    const before = await queryWithAgentVector("system",
      `SELECT ttl_tier, count(*)::int AS cnt
             FROM ${SCHEMA}.fragments GROUP BY ttl_tier`
    );
    const beforeMap = new Map(before.rows.map(r => [r.ttl_tier, r.cnt]));

    await this.store.transitionTTL();

    const after = await queryWithAgentVector("system",
      `SELECT ttl_tier, count(*)::int AS cnt
             FROM ${SCHEMA}.fragments GROUP BY ttl_tier`
    );

    let transitions = 0;
    for (const row of after.rows) {
      const prev = beforeMap.get(row.ttl_tier) || 0;
      const diff = Math.abs(row.cnt - prev);
      transitions += diff;
    }

    return Math.floor(transitions / 2);
  }

  /**
     * utility_score 갱신
     * score = importance * (1 + ln(max(access_count, 1))) / age_months^0.3
     * permanent 파편 포함 계산, 단 eviction 대상에서는 제외.
     */
  async _updateUtilityScores() {
    const result = await queryWithAgentVector("system",
      `UPDATE ${SCHEMA}.fragments
       SET utility_score =
         (importance * (1.0 + LN(GREATEST(access_count, 1))))
         / POWER(GREATEST(1.0, EXTRACT(EPOCH FROM (NOW() - created_at)) / 2592000.0), 0.3)
       WHERE utility_score IS DISTINCT FROM
         (importance * (1.0 + LN(GREATEST(access_count, 1))))
         / POWER(GREATEST(1.0, EXTRACT(EPOCH FROM (NOW() - created_at)) / 2592000.0), 0.3)`,
      [],
      "write"
    );

    return result.rowCount;
  }

  /**
   * 고-EMA 저-importance 파편을 MemoryEvaluator 큐에 재등록
   *
   * 조건: ema_activation > 0.3 AND importance < 0.4 AND quality_verified IS NULL
   * 자주 노출됐지만 원래 중요도가 낮은 파편 — 재평가 후 진위 판별.
   *
   * @returns {Promise<number>} 큐에 등록된 파편 수
   */
  async _requeueHighEmaLowQuality() {
    const result = await queryWithAgentVector("system",
      `SELECT id, agent_id, type, content
       FROM ${SCHEMA}.fragments
       WHERE ema_activation  > 0.3
         AND importance       < 0.4
         AND quality_verified IS NULL
         AND ttl_tier        != 'permanent'
       ORDER BY ema_activation DESC
       LIMIT 20`,
      []
    );

    for (const row of result.rows) {
      await pushToQueue("memory_evaluation", {
        fragmentId: row.id,
        agentId   : row.agent_id,
        type      : row.type,
        content   : row.content
      });
    }

    return result.rows.length;
  }

  /**
     * 앵커 파편 승격
     * 조건: access_count >= 10, importance >= 0.8
     */
  async _promoteAnchors() {
    const result = await queryWithAgentVector("system",
      `UPDATE ${SCHEMA}.fragments
             SET is_anchor = TRUE
             WHERE is_anchor = FALSE
               AND access_count >= 10
               AND importance >= 0.8`,
      [],
      "write"
    );

    return result.rowCount;
  }

  /**
     * 증분 모순 탐지 (3단계 하이브리드 파이프라인)
     *
     * Stage 1: pgvector 코사인 유사도 > 0.85 → 후보 필터링
     * Stage 2: NLI 분류 → 명확한 모순(conf >= 0.8) 즉시 해소, entailment 즉시 통과
     * Stage 3: Gemini CLI 에스컬레이션 → NLI 불확실 케이스(수치/도메인 모순)
     *
     * NLI 미가용 시 기존 로직으로 폴백 (Gemini CLI 또는 pending 큐).
     *
     * @returns {number} 발견된 모순 쌍 수
     */
  async _detectContradictions() {
    return this.contradictionDetector.detectContradictions();
  }

  /**
   * 모순 확인 시 contradicts 링크 + 시간 논리 기반 해소
   */
  async _resolveContradiction(newFrag, candidate, reasoning) {
    await this.store.createLink(newFrag.id, candidate.id, "contradicts", "system");

    const newDate = new Date(newFrag.created_at);
    const oldDate = new Date(candidate.created_at);

    if (newDate > oldDate) {
      if (!candidate.is_anchor) {
        await queryWithAgentVector("system",
          `UPDATE ${SCHEMA}.fragments SET importance = importance * 0.5 WHERE id = $1`,
          [candidate.id], "write"
        );
      }
      await this.store.createLink(candidate.id, newFrag.id, "superseded_by", "system");
      await queryWithAgentVector("system",
        `UPDATE ${SCHEMA}.fragments SET valid_to = NOW()
         WHERE id = $1 AND valid_to IS NULL`,
        [candidate.id], "write"
      );
    } else {
      await queryWithAgentVector("system",
        `UPDATE ${SCHEMA}.fragments SET importance = importance * 0.5 WHERE id = $1`,
        [newFrag.id], "write"
      );
      await this.store.createLink(newFrag.id, candidate.id, "superseded_by", "system");
      await queryWithAgentVector("system",
        `UPDATE ${SCHEMA}.fragments SET valid_to = NOW()
         WHERE id = $1 AND valid_to IS NULL`,
        [newFrag.id], "write"
      );
    }

    try {
      const winner  = newDate > oldDate ? newFrag   : candidate;
      const loser   = newDate > oldDate ? candidate : newFrag;
      const { MemoryManager } = await import("../MemoryManager.js");
      const mgr = MemoryManager.getInstance();

      await mgr.remember({
        content   : `[모순 해결] "${(loser.content  || "").substring(0, 80)}" 파편이 "${(winner.content || "").substring(0, 80)}" 으로 대체됨. 판단 근거: ${reasoning || "시간 순서 기준"}`,
        type      : "decision",
        topic     : newFrag.topic || "contradiction",
        keywords  : ["contradiction", "superseded", "resolved", ...(newFrag.keywords || []).slice(0, 3)],
        importance: 0.6,
        isAnchor  : false,
        linkedTo  : [winner.id, loser.id]
      });
    } catch (auditErr) {
      logWarn(`[MemoryConsolidator] Contradiction audit record failed: ${auditErr.message}`);
    }

    logInfo(`[MemoryConsolidator] Contradiction resolved: ${newFrag.id} <-> ${candidate.id}: ${reasoning}`);
  }

  async _detectSupersessions() {
    return this.contradictionDetector.detectSupersessions();
  }

  async _askGeminiSupersession(contentA, contentB) {
    return this.contradictionDetector.askGeminiSupersession(contentA, contentB);
  }

  async _askGeminiContradiction(contentA, contentB) {
    return this.contradictionDetector.askGeminiContradiction(contentA, contentB);
  }

  async _flagPotentialContradiction(redisClient, key, fragA, fragB) {
    return this.contradictionDetector.flagPotentialContradiction(redisClient, key, fragA, fragB);
  }

  async _processPendingContradictions() {
    return this.contradictionDetector.processPendingContradictions();
  }

  async _updateContradictionTimestamp(redisClient, key, timestamp) {
    return this.contradictionDetector.updateContradictionTimestamp(redisClient, key, timestamp);
  }

  /**
     * 피드백 리포트 생성
     *
     * tool_feedback + task_feedback 데이터를 집계하여
     * 도구별 관련성/충분성 비율, 주요 개선 제안을 산출한다.
     * 최소 피드백 10건 이상인 도구만 통계 표시.
     *
     * @returns {boolean} 리포트 생성 여부
     */
  async _generateFeedbackReport() {
    return this.consolidatorGC.generateFeedbackReport();
  }


  /**
     * 검증 주기 초과 파편 목록 반환
     * @returns {Promise<Array>} stale fragment 요약 목록
     */
  async _collectStaleFragments() {
    return this.consolidatorGC.collectStaleFragments();
  }

  /**
   * session_reflect 토픽의 오래되고 낮은 importance 파편을 정리한다.
   * type별로 최신 keepPerType개를 보존하고 나머지 중 조건에 맞는 것만 삭제.
   */
  async _purgeStaleReflections() {
    return this.consolidatorGC.purgeStaleReflections();
  }

  /**
     * 통계 조회
     */
  async getStats() {
    const pool = getPrimaryPool();
    if (!pool) return {};

    const result = await pool.query(
      `SELECT
                count(*)                                                     AS total,
                count(*) FILTER (WHERE ttl_tier = 'permanent')               AS permanent,
                count(*) FILTER (WHERE ttl_tier = 'hot')                     AS hot,
                count(*) FILTER (WHERE ttl_tier = 'warm')                    AS warm,
                count(*) FILTER (WHERE ttl_tier = 'cold')                    AS cold,
                count(*) FILTER (WHERE embedding IS NOT NULL)                AS embedded,
                avg(importance)                                              AS avg_importance,
                count(DISTINCT topic)                                        AS topic_count,
                count(*) FILTER (WHERE type = 'error')                       AS error_count,
                count(*) FILTER (WHERE type = 'preference')                  AS preference_count,
                count(*) FILTER (WHERE type = 'decision')                    AS decision_count,
                count(*) FILTER (WHERE type = 'procedure')                   AS procedure_count,
                count(*) FILTER (WHERE type = 'fact')                        AS fact_count,
                count(*) FILTER (WHERE type = 'relation')                    AS relation_count,
                sum(access_count)                                            AS total_accesses,
                avg(utility_score)                                           AS avg_utility,
                sum(estimated_tokens)                                        AS total_tokens
             FROM ${SCHEMA}.fragments`
    );

    const stats          = result.rows[0];
    stats.avg_importance = parseFloat(stats.avg_importance || 0).toFixed(3);
    stats.avg_utility    = parseFloat(stats.avg_utility || 0).toFixed(3);
    stats.total_tokens   = parseInt(stats.total_tokens || 0, 10);

    return stats;
  }

  /**
   * 긴 파편을 Gemini CLI로 원자 파편들로 분할
   *
   * 동작:
   *   1. length(content) > threshold인 파편 조회 (앵커·만료 제외)
   *   2. 파편별 Gemini CLI 호출 → 1~2문장 원자 항목 배열 반환
   *   3. 각 항목을 독립 파편으로 INSERT (embedding은 EmbeddingWorker가 사후 처리)
   *   4. 형제 파편끼리 related 순차 링크 + 각 파편 → 원본 part_of 링크
   *   5. 원본 파편 valid_to = NOW() (supersede 처리)
   *
   * @returns {number} 분할 처리된 원본 파편 수
   */
  async _splitLongFragments() {
    return this.consolidatorGC.splitLongFragments();
  }

  /**
   * 최근 24시간 피드백 데이터를 기반으로 파편 importance를 점진 보정한다.
   *
   * @returns {Promise<number>} 업데이트된 파편 수
   */
  async _calibrateByFeedback() {
    return this.consolidatorGC.calibrateByFeedback();
  }

  /**
   * search_events 30일 초과 레코드 정리
   * @returns {Promise<number>} 삭제된 행 수
   */
  async _gcSearchEvents() {
    return this.consolidatorGC._gcSearchEvents();
  }

  /**
   * 시맨틱 중복 제거 (같은 topic 내 cos >= 0.92 파편 병합)
   *
   * 각 topic 내 파편에 대해 pgvector KNN으로 top-3 유사 파편을 검색하고,
   * cos >= 0.92인 쌍을 병합한다. 앵커 파편은 병합에서 제외.
   * 최신 파편을 유지하고 이전 파편에 valid_to를 설정한다.
   *
   * @returns {Promise<number>} 병합된 쌍 수
   */
  async _semanticDedup() {
    const cfg          = MEMORY_CONFIG.dedup || {};
    const batchSize    = cfg.batchSize    || 100;
    const minFragments = cfg.minFragments || 5;
    const COS_THRESHOLD = 0.92;

    /** 1. 충분한 파편이 있는 topic 목록 조회 */
    const topicsResult = await queryWithAgentVector("system",
      `SELECT topic, COUNT(*) AS cnt
       FROM ${SCHEMA}.fragments
       WHERE embedding IS NOT NULL
         AND valid_to IS NULL
         AND topic IS NOT NULL
       GROUP BY topic
       HAVING COUNT(*) >= $1
       ORDER BY cnt DESC
       LIMIT $2`,
      [minFragments, batchSize]
    );

    if (topicsResult.rows.length === 0) return 0;

    let mergedCount = 0;
    const processed = new Set();

    for (const topicRow of topicsResult.rows) {
      const topic = topicRow.topic;

      /** 2. 해당 topic의 모든 유효 파편 조회 */
      const fragsResult = await queryWithAgentVector("system",
        `SELECT id, content, created_at, is_anchor, access_count, embedding
         FROM ${SCHEMA}.fragments
         WHERE topic = $1
           AND embedding IS NOT NULL
           AND valid_to IS NULL
         ORDER BY created_at DESC`,
        [topic]
      );

      for (const frag of fragsResult.rows) {
        if (frag.is_anchor) continue;
        if (processed.has(frag.id)) continue;

        /** 3. KNN으로 같은 topic 내 가장 유사한 3개 검색 */
        const knnResult = await queryWithAgentVector("system",
          `SELECT id, content, created_at, is_anchor, access_count,
                  1 - (embedding <=> $1) AS cosine_similarity
           FROM ${SCHEMA}.fragments
           WHERE topic = $2
             AND id != $3
             AND embedding IS NOT NULL
             AND valid_to IS NULL
           ORDER BY embedding <=> $1
           LIMIT 3`,
          [frag.embedding, topic, frag.id]
        );

        for (const candidate of knnResult.rows) {
          const cos = parseFloat(candidate.cosine_similarity);
          if (cos < COS_THRESHOLD) continue;
          if (candidate.is_anchor) continue;
          if (processed.has(candidate.id)) continue;

          /** 4. 병합: 최신 파편 유지, 이전 파편 soft delete */
          const fragDate      = new Date(frag.created_at);
          const candidateDate = new Date(candidate.created_at);
          const keepId        = fragDate >= candidateDate ? frag.id : candidate.id;
          const oldId         = fragDate >= candidateDate ? candidate.id : frag.id;
          const combinedAccess = (parseInt(frag.access_count) || 0) + (parseInt(candidate.access_count) || 0);

          /** 링크 이전 (from_id) */
          await queryWithAgentVector("system",
            `UPDATE ${SCHEMA}.fragment_links SET from_id = $1
             WHERE from_id = $2 AND to_id != $1
             ON CONFLICT (from_id, to_id) DO NOTHING`,
            [keepId, oldId], "write"
          ).catch(() => {});

          /** 중복 링크 정리 (from_id 이전으로 발생 가능) */
          await queryWithAgentVector("system",
            `DELETE FROM ${SCHEMA}.fragment_links
             WHERE from_id = $1 AND to_id = $2`,
            [oldId, keepId], "write"
          ).catch(() => {});

          /** 링크 이전 (to_id) */
          await queryWithAgentVector("system",
            `UPDATE ${SCHEMA}.fragment_links SET to_id = $1
             WHERE to_id = $2 AND from_id != $1
             ON CONFLICT (from_id, to_id) DO NOTHING`,
            [keepId, oldId], "write"
          ).catch(() => {});

          /** 중복 링크 정리 (to_id 이전으로 발생 가능) */
          await queryWithAgentVector("system",
            `DELETE FROM ${SCHEMA}.fragment_links
             WHERE from_id = $1 AND to_id = $2`,
            [keepId, oldId], "write"
          ).catch(() => {});

          /** 이전 파편 soft delete + access_count 합산 */
          await queryWithAgentVector("system",
            `UPDATE ${SCHEMA}.fragments SET valid_to = NOW() WHERE id = $1 AND valid_to IS NULL`,
            [oldId], "write"
          );

          await queryWithAgentVector("system",
            `UPDATE ${SCHEMA}.fragments SET access_count = $1 WHERE id = $2`,
            [combinedAccess, keepId], "write"
          );

          processed.add(oldId);
          mergedCount++;
        }
      }
    }

    if (mergedCount > 0) {
      logInfo(`[MemoryConsolidator] Semantic dedup merged ${mergedCount} pairs`);
    }

    return mergedCount;
  }

  /**
   * 오래된 저-importance 파편을 topic별로 그룹 압축
   * @returns {Promise<number>} 압축된 파편 수
   */
  async _compressOldFragments() {
    return this.consolidatorGC.compressOldFragments();
  }
}

