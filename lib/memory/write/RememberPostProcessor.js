/**
 * RememberPostProcessor — remember() 후처리 파이프라인
 *
 * 작성자: 최진호
 * 작성일: 2026-04-04
 * 수정일: 2026-04-27 (Phase 4: 형태소 등록 fire-and-forget 분리 + morpheme_indexed UPDATE)
 *
 * MemoryManager.remember()에서 파편 INSERT 후 실행하던 비동기/fire-and-forget
 * 후처리 항목을 일괄 관리한다:
 *   - 임베딩 큐 적재
 *   - 형태소 사전 등록 (fire-and-forget, 완료 시 morpheme_indexed=true 갱신)
 *   - linked_to 링크 생성
 *   - assertion 일관성 검사
 *   - 시간 기반 자동 링크
 *   - 품질 평가 큐 적재
 */

import { MEMORY_CONFIG }    from "../../../config/memory.js";
import { SYMBOLIC_CONFIG }  from "../../../config/symbolic.js";
import { pushToQueue }      from "../../redis.js";
import { EmbeddingWorker }  from "../EmbeddingWorker.js";
import { ClaimExtractor }   from "../../symbolic/ClaimExtractor.js";
import { ClaimStore, TENANT_ISOLATION_VIOLATION } from "../../symbolic/ClaimStore.js";
import { ClaimConflictDetector }      from "../../symbolic/ClaimConflictDetector.js";
import { evaluateProactiveGate }      from "../../symbolic/rules/v1/proactive-gate.js";
import { symbolicMetrics }  from "../../symbolic/SymbolicMetrics.js";
import { getPrimaryPool }   from "../../tools/db.js";
import { logWarn }          from "../../logger.js";

const SCHEMA             = "agent_memory";
const EVAL_EXCLUDE_TYPES = new Set(["fact", "procedure", "error", "episode"]);

export class RememberPostProcessor {
  /**
   * @param {{ store: FragmentStore, conflictResolver: ConflictResolver, temporalLinker: TemporalLinker, morphemeIndex: MorphemeIndex, search?: FragmentSearch }} deps
   */
  constructor({
    store,
    conflictResolver,
    temporalLinker,
    morphemeIndex,
    search                 = null,
    claimExtractor         = null,
    claimStore             = null,
    linkChecker            = null,
    claimConflictDetector  = null,
  }) {
    this.store            = store;
    this.conflictResolver = conflictResolver;
    this.temporalLinker   = temporalLinker;
    this.morphemeIndex    = morphemeIndex;
    this.search           = search;

    /** Phase 1 symbolic claim extraction — 지연 생성 (테스트에서 주입 가능) */
    this.claimExtractor = claimExtractor;
    this.claimStore     = claimStore;

    /** Phase 3 advisory link integrity — caller-side cycle check */
    this.linkChecker    = linkChecker;

    /** Phase 6 proactive gate — ClaimConflictDetector 지연 생성 */
    this.claimConflictDetector = claimConflictDetector;

    /** 테스트 안정성을 위한 fire-and-forget Promise 추적 */
    this._proactiveRecallPromise       = null;
    this._symbolicClaimPromise         = null;

    /**
     * Phase 4: 형태소 등록 drain용 Promise Set.
     * graceful shutdown 시 _drainMorpheme()으로 전체 완료 대기.
     */
    this._morphemePromises = new Set();
  }

  /**
   * Lazy getter — Phase 6 proactive gate 가 활성화된 경우에만 detector 인스턴스를 만든다.
   * @returns {ClaimConflictDetector}
   */
  _getClaimConflictDetector() {
    if (!this.claimConflictDetector) {
      this.claimConflictDetector = new ClaimConflictDetector();
    }
    return this.claimConflictDetector;
  }

  /**
   * remember() 후처리 파이프라인 실행.
   *
   * @param {{ id: string, content: string, type: string, topic?: string, linked_to?: string[], created_at?: string }} fragment
   * @param {{ agentId: string, keyId: string|null, groupKeyIds?: number[]|null }} context
   */
  async run(fragment, { agentId, keyId, groupKeyIds = null }) {
    const id = fragment.id;

    /** 임베딩 비동기 큐 적재 */
    try {
      await pushToQueue(MEMORY_CONFIG.embeddingWorker.queueKey, { fragmentId: id });
    } catch {
      /** Redis 미가용 시 동기 임베딩 생성 (1건) */
      new EmbeddingWorker().processOrphanFragments(1).catch(err => {
        logWarn(`[RememberPostProcessor] inline embedding failed: ${err.message}`);
      });
    }

    /**
     * Phase 4: 형태소 사전 등록 fire-and-forget.
     * 완료 시 fragments.morpheme_indexed = true 갱신.
     * Promise는 _morphemePromises Set에 등록하여 graceful shutdown drain 가능.
     */
    const morphemeP = this.morphemeIndex.tokenize(fragment.content)
      .catch(() => [])
      .then(morphemes => this.morphemeIndex.getOrRegisterEmbeddings(morphemes))
      .then(() => this._updateMorphemeIndexed(id))
      .catch(err => {
        logWarn(`[RememberPostProcessor] morpheme registration failed: ${err.message}`);
      });

    this._morphemePromises.add(morphemeP);
    morphemeP.finally(() => this._morphemePromises.delete(morphemeP));

    /** linked_to 링크 생성 (소유권 검증 후 허용된 ID만 링크) */
    if (fragment.linked_to?.length > 0) {
      const linkIds       = fragment.linked_to;
      const allowedIds    = new Set();

      try {
        const owned = await this.store.getByIds(linkIds, agentId, keyId);
        for (const f of owned) allowedIds.add(f.id);
      } catch (err) {
        logWarn(`[RememberPostProcessor] linkedTo ownership check failed: ${err.message}`);
      }

      const dropped = linkIds.filter(lid => !allowedIds.has(lid));
      if (dropped.length > 0) {
        logWarn(`[RememberPostProcessor] linkedTo ownership denied — dropping ids: ${dropped.join(", ")}`);
      }

      await Promise.all([...allowedIds].map(async (linkId) => {
        /** Phase 3 advisory cycle check (non-directional "related"는 early return) */
        await this._advisoryCycleCheck(id, linkId, "related", agentId, keyId);
        return this.store.createLink(id, linkId, "related", agentId)
          .catch(err => {
            logWarn(`[RememberPostProcessor] link creation failed for ${linkId}: ${err.message}`);
          });
      }));
    }

    /** assertion 일관성 검사 (fire-and-forget — 레이턴시 무관) */
    this.conflictResolver
      .checkAssertionConsistency(
        { ...fragment, created_at: fragment.created_at ?? new Date().toISOString() },
        agentId,
        keyId
      )
      .then(({ assertionStatus }) => {
        if (assertionStatus !== "observed") {
          this.store.patchAssertion(id, assertionStatus, keyId)
            .catch(err => logWarn(`[RememberPostProcessor] patchAssertion failed: ${err.message}`));
        }
      })
      .catch(err => logWarn(`[RememberPostProcessor] checkAssertionConsistency failed: ${err.message}`));

    /** 시간 기반 자동 링크 (fire-and-forget) */
    this.temporalLinker.linkTemporalNeighbors(
      { ...fragment, created_at: fragment.created_at ?? new Date().toISOString() },
      { agentId, keyId, groupKeyIds }
    ).catch(err => {
      logWarn(`[RememberPostProcessor] temporalLinker failed: ${err.message}`);
    });

    /** 비동기 품질 평가 큐 적재 */
    if (!EVAL_EXCLUDE_TYPES.has(fragment.type)) {
      await pushToQueue("memory_evaluation", {
        fragmentId: id,
        agentId,
        type   : fragment.type,
        content: fragment.content
      });
    }

    /** ProactiveRecall: 유사 파편 발견 시 related_to 링크 자동 생성 (fire-and-forget) */
    this._proactiveRecallPromise = this._proactiveRecall(fragment, { agentId, keyId }).catch(err => {
      logWarn(`[RememberPostProcessor] proactiveRecall failed: ${err.message}`);
    });

    /**
     * 8단계: Symbolic claim extraction (Phase 1 Shadow)
     * - MEMENTO_SYMBOLIC_ENABLED + MEMENTO_SYMBOLIC_CLAIM_EXTRACTION 둘 다 true 일 때만 동작
     * - fire-and-forget. 실패/격리 위반 시 remember() 응답에 영향 없음
     * - TENANT_ISOLATION_VIOLATION 은 gate_blocked 메트릭으로 기록 후 swallow
     */
    if (SYMBOLIC_CONFIG.enabled && SYMBOLIC_CONFIG.claimExtraction) {
      this._symbolicClaimPromise = this._extractSymbolicClaims(fragment, { agentId, keyId }).catch(err => {
        logWarn(`[RememberPostProcessor] symbolic claim extraction failed: ${err.message}`);
      });
    }
  }

  /**
   * Phase 4: fragments.morpheme_indexed = true 갱신.
   * 형태소 등록이 완료된 파편에 대해서만 호출된다.
   *
   * @param {string} fragmentId
   */
  async _updateMorphemeIndexed(fragmentId) {
    const pool = getPrimaryPool();
    if (!pool) return;
    try {
      await pool.query(
        `UPDATE ${SCHEMA}.fragments SET morpheme_indexed = true WHERE id = $1`,
        [fragmentId]
      );
    } catch (err) {
      logWarn(`[RememberPostProcessor] morpheme_indexed UPDATE 실패 (id=${fragmentId}): ${err.message}`);
    }
  }

  /**
   * Phase 4: graceful shutdown drain.
   * 진행 중인 모든 형태소 등록 Promise가 완료될 때까지 대기.
   *
   * @returns {Promise<void>}
   */
  async drainMorpheme() {
    if (this._morphemePromises.size === 0) return;
    await Promise.allSettled([...this._morphemePromises]);
  }

  /**
   * Symbolic claim 추출 & 영속화 파이프라인 (fire-and-forget 진입점).
   *
   * 1) ClaimExtractor.extract 로 content → claim 트리플 목록 추출
   * 2) ClaimStore.insert 로 fragment_claims 에 배치 insert
   *    - fragment.key_id 와 ctx.keyId 불일치 시 TENANT_ISOLATION_VIOLATION throw
   *    - 이 경우 memento_symbolic_gate_blocked_total 증가 후 swallow
   * 3) 성공 claim 마다 symbolicMetrics.recordClaim 으로 카운터 증가
   * 4) 전체 연산 레이턴시를 observeLatency('claim_extraction', ms) 로 관측
   *
   * @param {{ id: string, content: string, topic?: string, key_id?: string|null }} fragment
   * @param {{ agentId: string, keyId: string|null }} ctx
   */
  async _extractSymbolicClaims(fragment, { agentId, keyId }) {
    const t0        = Date.now();
    const extractor = this._getClaimExtractor();
    const store     = this._getClaimStore();

    let claims = [];
    try {
      claims = await extractor.extract(fragment.content, fragment.topic);
    } catch (err) {
      logWarn(`[RememberPostProcessor] claim extract failed: ${err.message}`);
      symbolicMetrics.observeLatency("claim_extraction", Date.now() - t0);
      return;
    }

    if (!Array.isArray(claims) || claims.length === 0) {
      symbolicMetrics.observeLatency("claim_extraction", Date.now() - t0);
      return;
    }

    try {
      await store.insert(fragment, claims, { agentId, keyId });
      for (const c of claims) {
        symbolicMetrics.recordClaim(c.extractor ?? "morpheme-rule", c.polarity ?? "uncertain");
      }
    } catch (err) {
      if (err && err.message === TENANT_ISOLATION_VIOLATION) {
        symbolicMetrics.recordGateBlock("claim_extraction", "tenant_violation");
      } else {
        logWarn(`[RememberPostProcessor] claim insert failed: ${err?.message ?? err}`);
      }
    } finally {
      symbolicMetrics.observeLatency("claim_extraction", Date.now() - t0);
    }
  }

  /** ClaimExtractor 를 한 번만 지연 생성 (테스트에서 주입 가능) */
  _getClaimExtractor() {
    if (!this.claimExtractor) {
      this.claimExtractor = new ClaimExtractor({
        morphemeIndex: this.morphemeIndex,
        ruleVersion  : SYMBOLIC_CONFIG.ruleVersion
      });
    }
    return this.claimExtractor;
  }

  /** ClaimStore 를 한 번만 지연 생성 (테스트에서 주입 가능) */
  _getClaimStore() {
    if (!this.claimStore) this.claimStore = new ClaimStore();
    return this.claimStore;
  }

  /**
   * 저장된 파편과 키워드 오버랩이 있는 기존 파편을 검색하여 related_to 링크를 생성한다.
   * fire-and-forget -- 실패해도 remember() 응답에 영향 없음.
   */
  async _proactiveRecall(fragment, { agentId, keyId }) {
    const mode = MEMORY_CONFIG.proactiveRecall?.mode ?? "auto";

    // mode=off이면 자동 링크를 생성하지 않는다
    if (mode === "off") return;

    if (!this.search) return;

    const keywords = Array.isArray(fragment.keywords) && fragment.keywords.length > 0
      ? fragment.keywords
      : fragment.content.split(/\s+/).filter(w => w.length > 1).slice(0, 8);

    if (keywords.length === 0) return;

    const { fragments: candidates } = await this.search.search({
      keywords,
      keyId,
      tokenBudget  : 400,
      fragmentCount: 5
    });

    const overlapMin = MEMORY_CONFIG.proactiveRecall?.keywordOverlapMin ?? 0.5;
    const newKwSet   = new Set(keywords.map(k => k.toLowerCase()));

    for (const candidate of candidates) {
      if (candidate.id === fragment.id) continue;

      const candKws = Array.isArray(candidate.keywords)
        ? candidate.keywords.map(k => k.toLowerCase())
        : [];
      const shared  = candKws.filter(k => newKwSet.has(k)).length;
      const overlap = shared / Math.max(newKwSet.size, candKws.length, 1);

      if (overlap < overlapMin) continue;

      if (mode === "legacy") {
        // legacy: v4.1.0 이전 동작 — workspace/case 무관, 오버랩 기준만 적용
        await this._advisoryCycleCheck(fragment.id, candidate.id, "related", agentId, keyId);
        await this.store.createLink(fragment.id, candidate.id, "related", agentId)
          .catch(err => logWarn(`[RememberPostProcessor] createLink failed: ${err.message}`));
        continue;
      }

      // mode="auto": Phase 3 advisory cycle check
      await this._advisoryCycleCheck(fragment.id, candidate.id, "related", agentId, keyId);

      /**
       * Phase 6 symbolic proactive gate — polarity 충돌/quarantine/cohort 불일치 시 차단.
       * workspace 일치 체크 및 caseId 정책을 proactiveConfig로 전달한다.
       */
      if (SYMBOLIC_CONFIG.enabled && SYMBOLIC_CONFIG.proactiveGate) {
        const gateResult = await this._proactiveGateCheck(fragment, candidate, keyId);
        if (!gateResult.allowed) {
          symbolicMetrics.recordGateBlock("proactive", gateResult.reason);
          continue;
        }
      }

      await this.store.createLink(fragment.id, candidate.id, "related", agentId)
        .catch(err => logWarn(`[RememberPostProcessor] createLink failed: ${err.message}`));
    }
  }

  /**
   * Phase 6 ProactiveRecall gate 내부 래퍼 — rules/v1/proactive-gate 에 위임.
   * 실패 시 fail-open (allowed=true) 으로 신경 경로를 막지 않는다.
   *
   * @param {Object}      source
   * @param {Object}      target
   * @param {string|null} keyId
   * @returns {Promise<{ allowed: boolean, reason: string, ruleVersion: string }>}
   */
  async _proactiveGateCheck(source, target, keyId) {
    try {
      const detector       = this._getClaimConflictDetector();
      const proactiveConfig = MEMORY_CONFIG.proactiveRecall;
      return await evaluateProactiveGate({ source, target, keyId }, { detector, proactiveConfig });
    } catch (err) {
      logWarn(`[RememberPostProcessor] proactive gate failed: ${err.message}`);
      return { allowed: true, reason: "gate_error", ruleVersion: "v1" };
    }
  }

  /**
   * Phase 3 advisory cycle check — linkChecker와 SYMBOLIC_CONFIG.linkCheck
   * 모두 활성화된 경우에만 동작. 실패해도 caller를 차단하지 않는다.
   *
   * @param {string|number} fromId
   * @param {string|number} toId
   * @param {string}        relationType
   * @param {string}        agentId
   * @param {string|null}   keyId
   */
  async _advisoryCycleCheck(fromId, toId, relationType, agentId, keyId) {
    if (!SYMBOLIC_CONFIG.enabled || !SYMBOLIC_CONFIG.linkCheck) return;
    if (!this.linkChecker) return;
    try {
      await this.linkChecker.checkCycle(fromId, toId, relationType, agentId, keyId ?? null);
    } catch (err) {
      logWarn(`[RememberPostProcessor] advisory cycle check failed: ${err.message}`);
    }
  }
}
