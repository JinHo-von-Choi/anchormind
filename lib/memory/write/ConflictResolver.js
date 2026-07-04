/**
 * ConflictResolver — remember 시점 충돌 감지, 자동 링크, supersede 처리
 *
 * 작성자: 최진호
 * 작성일: 2026-03-12
 * 수정일: 2026-04-03 (Narrative Reconstruction Phase 4: checkAssertionConsistency 추가)
 */

import { getPrimaryPool }            from "../../tools/db.js";
import { logWarn }                   from "../../logger.js";
import { quarantineAdjacentLinks }   from "../link/ReconsolidationEngine.js";
import { SYMBOLIC_CONFIG }           from "../../../config/symbolic.js";
import { symbolicMetrics }           from "../../symbolic/SymbolicMetrics.js";
import { ClaimConflictDetector }     from "../../symbolic/ClaimConflictDetector.js";

export class ConflictResolver {
  /**
   * @param {import("./FragmentStore.js").FragmentStore}   store
   * @param {import("../read/FragmentSearch.js").FragmentSearch} search
   * @param {Object} [deps] - 선택 의존성
   * @param {Object} [deps.linkChecker]            - Phase 3 LinkIntegrityChecker (advisory cycle 검증)
   * @param {Object} [deps.claimConflictDetector]  - Phase 3 polarity conflict 병기 (advisory)
   */
  constructor(store, search, deps = {}) {
    this.store                 = store;
    this.search                = search;
    this.linkChecker           = deps.linkChecker || null;
    this.claimConflictDetector = deps.claimConflictDetector || null;
  }

  /**
   * Lazy getter — ClaimConflictDetector 는 SYMBOLIC_CONFIG.polarityConflict 가 true 일
   * 때만 검사 경로에서 호출된다. 테스트에서 주입하지 않으면 첫 호출 시 생성한다.
   * @returns {ClaimConflictDetector}
   */
  _getClaimConflictDetector() {
    if (!this.claimConflictDetector) {
      this.claimConflictDetector = new ClaimConflictDetector();
    }
    return this.claimConflictDetector;
  }

  /**
   * advisory cycle 검사 (Phase 3).
   * linkChecker와 SYMBOLIC_CONFIG.linkCheck가 모두 활성화된 경우에만 동작.
   * 위반 발견 시 warning 메트릭만 증가시키고 caller의 createLink는 차단하지 않는다.
   *
   * @param {string|number} fromId
   * @param {string|number} toId
   * @param {string}        relationType
   * @param {string}        agentId
   * @param {string|null}   keyId
   * @returns {Promise<void>}
   */
  async _advisoryCycleCheck(fromId, toId, relationType, agentId, keyId) {
    if (!SYMBOLIC_CONFIG.enabled || !SYMBOLIC_CONFIG.linkCheck) return;
    if (!this.linkChecker) return;
    try {
      await this.linkChecker.checkCycle(fromId, toId, relationType, agentId, keyId ?? null);
    } catch (err) {
      logWarn(`[ConflictResolver] advisory cycle check failed: ${err.message}`);
    }
  }

  /**
   * 새 파편과 유사도가 높은 기존 파편을 탐색하여 충돌 목록을 반환한다.
   *
   * @param {string} content  새 파편 내용
   * @param {string} topic    새 파편 토픽
   * @param {string} newId    새 파편 ID (자기 자신 제외)
   * @param {string} agentId
   * @param {string|null} keyId
   * @returns {Promise<Array>}
   */
  async detectConflicts(content, topic, newId, agentId = "default", keyId = null) {
    try {
      const result = await this.search.search({
        text       : content,
        topic,
        tokenBudget: 500,
        agentId,
        keyId
      });

      const conflicts = [];

      for (const frag of result.fragments) {
        if (frag.id === newId) continue;
        const similarity = frag.similarity || 0;
        if (similarity > 0.8) {
          conflicts.push({
            existing_id     : frag.id,
            existing_content: (frag.content || "").substring(0, 100),
            similarity,
            recommendation : `기존 파편(${frag.id})을 amend 또는 forget 후 재저장 권장`
          });
        }
      }

      return conflicts;
    } catch (err) {
      logWarn(`[ConflictResolver] detectConflicts failed: ${err.message}`);
      return [];
    }
  }

  /**
   * remember() 시점 topic 기반 구조적 링크 생성.
   *
   * 임베딩이 아직 없는 시점이므로 pgvector 유사도 대신 동일 topic 파편을 DB에서 조회하여
   * `related` 링크를 즉시 생성한다. 이후 embedding_ready → GraphLinker 경로가
   * semantic 유사도 기반 링크를 추가하여 두 레이어를 보완한다.
   *
   * 최대 3개 링크 생성 (과도한 그래프 밀도 방지).
   *
   * @param {Object} newFragment - 방금 생성된 파편 (id, topic, type, key_id 포함)
   * @param {string} agentId
   * @returns {Promise<number>} 생성된 링크 수
   */
  async autoLinkOnRemember(newFragment, agentId) {
    if (!newFragment.topic || !newFragment.id) return 0;

    try {
      const related = await this.store.searchByTopic(newFragment.topic, {
        minImportance    : 0.3,
        limit            : 4,
        agentId,
        keyId            : newFragment.key_id ?? null,
        includeSuperseded: false
      });

      let linkCount = 0;
      for (const frag of related) {
        if (frag.id === newFragment.id || linkCount >= 3) break;
        try {
          /** Phase 3 advisory cycle check — related는 non_directional이라 early return */
          await this._advisoryCycleCheck(newFragment.id, frag.id, "related", agentId, newFragment.key_id ?? null);
          await this.store.createLink(newFragment.id, frag.id, "related", agentId);
          linkCount++;
        } catch { /* ON CONFLICT 등 무시 */ }
      }

      return linkCount;
    } catch {
      return 0;
    }
  }

  /**
   * 동일 topic + 시간 대역 내 기존 파편과 assertion 충돌 검사.
   * 충돌 감지 시 assertionStatus='inferred', supersedeCandidates 반환.
   * write-time 동기화 없음 (레이턴시 보호).
   *
   * 판정 기준:
   *   - Jaccard 유사도 > 0.3인 파편이 존재하면 충돌 후보
   *   - assertion_status='rejected' 파편과 유사 → 신규도 'inferred' (의심 내용 중첩)
   *   - assertion_status='verified' 파편과 유사 → 신규도 'inferred' (기존 검증 내용과 중첩)
   *   - 충돌 없으면 'observed' 유지
   *
   * @param {Object}      fragment - { id, content, topic, created_at, key_id }
   * @param {string}      agentId
   * @param {number|null} keyId
   * @returns {Promise<{ assertionStatus: string, supersedeCandidates: string[] }>}
   */
  async checkAssertionConsistency(fragment, agentId, keyId) {
    const pool = getPrimaryPool();
    if (!pool || !fragment.topic || !fragment.content) {
      return { assertionStatus: "observed", supersedeCandidates: [] };
    }

    try {
      const params   = [fragment.topic, fragment.id];
      let keyFilter  = "";
      if (keyId != null) {
        params.push(keyId);
        keyFilter = `AND key_id = $${params.length}`;
      }
      const { rows } = await pool.query(
        `SELECT id, content, assertion_status
         FROM agent_memory.fragments
         WHERE topic = $1
           AND created_at BETWEEN NOW() - INTERVAL '7 days' AND NOW() + INTERVAL '7 days'
           AND id != $2
           ${keyFilter}
           AND valid_to IS NULL
         ORDER BY created_at DESC
         LIMIT 10`,
        params
      );

      if (rows.length === 0) {
        return { assertionStatus: "observed", supersedeCandidates: [] };
      }

      const JACCARD_THRESHOLD  = 0.3;
      const supersedeCandidates = [];
      let   downgrade           = false;

      for (const row of rows) {
        const similarity = this._jaccardSimilarity(fragment.content, row.content);
        if (similarity > JACCARD_THRESHOLD) {
          supersedeCandidates.push(row.id);
          if (row.assertion_status === "rejected" || row.assertion_status === "verified") {
            downgrade = true;
          }
        }
      }

      if (downgrade && supersedeCandidates.length > 0 && process.env.ENABLE_RECONSOLIDATION === "true") {
        for (const candidateId of supersedeCandidates) {
          quarantineAdjacentLinks(fragment.id, candidateId, keyId).catch(() => {});
        }
      }

      /**
       * Phase 3 병기: symbolic polarity 충돌 검사.
       * 기존 Jaccard 결과를 대체하지 않고 병합한다. SYMBOLIC_CONFIG.polarityConflict
       * 가 false 면 호출하지 않고, detector 에서 예외가 나도 caller 에 전파하지 않는다.
       */
      const validationWarnings = [];
      if (SYMBOLIC_CONFIG.enabled && SYMBOLIC_CONFIG.polarityConflict) {
        try {
          const detector    = this._getClaimConflictDetector();
          const polarity    = await detector.detectPolarityConflicts(fragment.id, keyId);
          const polarityArr = (polarity && polarity.conflicts) || [];
          for (const c of polarityArr) {
            if (c.conflictWith && !supersedeCandidates.includes(c.conflictWith)) {
              supersedeCandidates.push(c.conflictWith);
            }
            validationWarnings.push({
              rule        : "polarity_conflict",
              conflictWith: c.conflictWith,
              subject     : c.subject,
              predicate   : c.predicate,
              ruleVersion : c.ruleVersion
            });
          }
        } catch (err) {
          logWarn(`[ConflictResolver] symbolic polarity check failed: ${err.message}`);
        }
      }

      return {
        assertionStatus    : downgrade ? "inferred" : "observed",
        supersedeCandidates,
        validationWarnings
      };
    } catch (err) {
      logWarn(`[ConflictResolver] checkAssertionConsistency failed: ${err.message}`);
      return { assertionStatus: "observed", supersedeCandidates: [], validationWarnings: [] };
    }
  }

  /**
   * 토큰 기반 Jaccard 유사도 계산.
   * 소문자 변환 후 공백 분리 토큰 집합 간 교집합/합집합 비율 반환.
   * NLP 라이브러리 불필요 — O(n) 시간 복잡도.
   *
   * @param {string} textA
   * @param {string} textB
   * @returns {number} 0.0 ~ 1.0
   */
  _jaccardSimilarity(textA, textB) {
    const tokenize  = (t) => new Set((t || "").toLowerCase().split(/\s+/).filter(Boolean));
    const setA      = tokenize(textA);
    const setB      = tokenize(textB);

    if (setA.size === 0 && setB.size === 0) return 1.0;
    if (setA.size === 0 || setB.size === 0) return 0.0;

    let intersectionSize = 0;
    for (const token of setA) {
      if (setB.has(token)) intersectionSize++;
    }

    const unionSize = setA.size + setB.size - intersectionSize;
    return intersectionSize / unionSize;
  }

  /**
   * 기존 파편을 새 파편으로 대체한다.
   * - superseded_by 링크 생성
   * - 구 파편의 valid_to를 현재 시각으로 설정
   * - 구 파편의 importance를 반감
   *
   * @param {string} oldId   - 대체될 파편 ID
   * @param {string} newId   - 대체하는 파편 ID
   * @param {string} agentId
   */
  async supersede(oldId, newId, agentId = "default", keyId = null) {
    /** Phase 3 advisory cycle check — superseded_by는 방향성 관계 */
    await this._advisoryCycleCheck(oldId, newId, "superseded_by", agentId, keyId);
    await this.store.createLink(oldId, newId, "superseded_by", agentId);

    const pool = getPrimaryPool();
    if (!pool) return;

    const params    = [oldId];
    let   keyFilter = "";
    if (keyId != null) {
      params.push(keyId);
      keyFilter = `AND key_id = $${params.length}`;
    }

    await pool.query(
      `UPDATE agent_memory.fragments
       SET valid_to   = NOW(),
           importance = GREATEST(0.05, importance * 0.5)
       WHERE id = $1 AND valid_to IS NULL ${keyFilter}`,
      params
    );
  }
}
