/**
 * MemoryRememberer - MemoryManager 분해 (Phase 5-B)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * 이관 대상: remember / batchRemember / amend / forget / _supersede /
 *            _rememberAtomic / _finalizeRemember / _recordCaseEvent
 *
 * 공개 API 계약은 MemoryManager와 100% 동일하게 유지한다.
 * MemoryManager.js는 이 클래스를 위임 호출하는 facade로 축소될 예정이다.
 */

import crypto                            from "crypto";
import { getPrimaryPool }                from "../../tools/db.js";
import { buildSearchPath, wmPgFallbackEnabled } from "../../config.js";
import { logWarn }                       from "../../logger.js";
import { rememberStageDuration, timeStage } from "../stage-metrics.js";
import { extractRequestCtx }            from "../keyId.js";
import { validateContentInput }         from "../contentGuard.js";
import { checkWorkspaceAllowed }        from "../../admin/ApiKeyStore.js";
import { WriteGate, WRITE_ENTRIES, ruleName, truncationInfo, truncationField } from "../write/WriteGate.js";
import { SERVER_ANCHOR_DEPS }         from "../write/serverAnchorDeps.js";
import { SCHEMA } from "../schema.js";
import { countLiveFragments } from "../read/quotaQueries.js";
import { isDuplicateHit, classifyDuplicate, resolveDuplicateHit, duplicateOfField } from "./RememberDuplicate.js";
import { isLiteralTrue } from "../../env-parse.js";
import { markWorkingMemoryRow, workingMemoryHints, WM_NONE_REASON, WM_FALLBACK_CAUSE } from "../WorkingMemoryRows.js";
import { provenanceContext } from "../provenance.js";
import { CONFOUNDED_MAX } from "../signals/CaseRewardBackprop.js";
import { amendFragment } from "./MemoryAmender.js";
import { forgetFragments } from "./MemoryForgetter.js";

export { isDuplicateHit, classifyDuplicate };
export { amendChanges } from "./MemoryAmender.js";



/** 파편이 사례 이벤트 근거일 때의 confidence. 검증 전 추론 파편은 기여가 섞인 근거다. */
const evidenceConfidence = (fragment) => (fragment.assertion_status === "inferred" ? CONFOUNDED_MAX : 1.0);

export class MemoryRememberer {
  /**
   * @param {Object} deps
   * @param {import("../write/FragmentStore.js").FragmentStore}               deps.store
   * @param {import("../FragmentIndex.js").FragmentIndex}               deps.index
   * @param {import("../write/FragmentFactory.js").FragmentFactory}           deps.factory
   * @param {import("../QuotaChecker.js").QuotaChecker}                deps.quotaChecker
   * @param {import("../write/RememberPostProcessor.js").RememberPostProcessor} deps.postProcessor
   * @param {import("../write/ConflictResolver.js").ConflictResolver}         deps.conflictResolver
   * @param {import("../CaseEventStore.js").CaseEventStore}             deps.caseEventStore
   * @param {import("../../symbolic/PolicyRules.js").PolicyRules}       deps.policyRules
   * @param {import("../link/SessionLinker.js").SessionLinker}               deps.sessionLinker
   * @param {import("../write/BatchRememberProcessor.js").BatchRememberProcessor} deps.batchRememberProcessor
   * @param {import("../../symbolic/LinkIntegrityChecker.js").LinkIntegrityChecker} deps.linkChecker
   * @param {Function}  deps.getHardGate           - (keyId: string) => Promise<boolean>
   * @param {boolean|null} deps.policyGatingEnabled - null 이면 SYMBOLIC_CONFIG 값 사용
   * @param {import("../embedding/MorphemeIndex.js").MorphemeIndex} [deps.morphemeIndex]
   */
  constructor({
    store,
    index,
    factory,
    quotaChecker,
    postProcessor,
    conflictResolver,
    caseEventStore,
    policyRules,
    sessionLinker,
    batchRememberProcessor,
    linkChecker,
    getHardGate,
    policyGatingEnabled,
    morphemeIndex
  } = {}) {
    this.store                 = store;
    this.index                 = index;
    this.factory               = factory;
    this.quotaChecker          = quotaChecker;
    this.postProcessor         = postProcessor;
    this.conflictResolver      = conflictResolver;
    this.caseEventStore        = caseEventStore;
    this.policyRules           = policyRules;
    this.sessionLinker         = sessionLinker;
    this.batchRememberProcessor = batchRememberProcessor;
    this.linkChecker           = linkChecker;
    this.morphemeIndex         = morphemeIndex;

    /**
     * hard gate 조회 함수. 기본값은 ApiKeyStore.getSymbolicHardGate.
     * 단위 테스트에서 인스턴스 프로퍼티 교체로 mock 주입 가능.
     * @type {(keyId: string) => Promise<boolean>}
     */
    this._getHardGate = getHardGate;

    /**
     * Phase 4 Soft/Hard Gating 활성화 여부.
     * SYMBOLIC_CONFIG.enabled && SYMBOLIC_CONFIG.policyRules를 기본값으로 하지만
     * 단위 테스트에서 인스턴스 레벨로 true 설정 가능.
     * null이면 SYMBOLIC_CONFIG 값을 사용.
     * @type {boolean|null}
     */
    this._policyGatingEnabled = policyGatingEnabled !== undefined ? policyGatingEnabled : null;

    /** 앵커 단계 의존성(키 권한 조회, 감사 기록). 단위 시험에서 인스턴스 프로퍼티 교체로 대역 주입 가능. */
    this._anchorDeps = SERVER_ANCHOR_DEPS;
  }

  /** fragment type → case event type 매핑 */
  static FRAG_TO_EVENT = {
    error    : "error_observed",
    decision : "decision_committed",
    procedure: "fix_attempted"
  };

  /**
   * remember - 파편 기억
   *
   * @param {Object} params
   *   - content   {string} 기억할 내용
   *   - topic     {string} 주제
   *   - type      {string} fact|decision|error|preference|procedure|relation
   *   - keywords  {string[]} 키워드 (선택)
   *   - importance {number} 중요도 0~1 (선택)
   *   - source    {string} 출처 (선택)
   *   - linkedTo  {string[]} 연결 파편 ID (선택)
   *   - agentId   {string} 에이전트 ID (선택)
   *   - sessionId {string} 세션 ID (선택)
   *   - scope     {string} permanent|session (기본 permanent)
   * @returns {Object} { id, keywords, ttl_tier, scope }
   */
  async remember(params) {
    validateContentInput(params.content);

    const scope                           = params.scope || "permanent";
    const { agentId, keyId, groupKeyIds } = extractRequestCtx(params);
    const sessionId                       = params.sessionId || params._sessionId || null;
    const workspace                       = params.workspace ?? params._defaultWorkspace ?? null;
    const source                          = params.source ?? (sessionId ? `session:${sessionId.slice(0, 8)}` : null);

    const sessionResult = await this._handleSessionScope(params, scope, sessionId, {
      agentId, keyId, workspace, source
    });
    if (sessionResult) return sessionResult;

    const idempotentResult = await this._checkIdempotency(params, keyId);
    if (idempotentResult) return idempotentResult;

    const dryRunResult = await this._handleDryRun(params, source, sessionId, workspace, keyId);
    if (dryRunResult) return dryRunResult;

    /**
     * 할당량 초과 검사.
     *
     * MEMENTO_REMEMBER_ATOMIC=true: BEGIN → api_keys FOR UPDATE(quota 재검증) →
     *   FragmentWriter.insert(client) → COMMIT 단일 트랜잭션. TOCTOU 완전 차단.
     *   BatchRememberProcessor Phase B와 동일한 SELECT 조건·잠금 범위 사용.
     *
     * MEMENTO_REMEMBER_ATOMIC=false(기본): QuotaChecker.check()를 선제 검사로만 사용.
     *   동시 요청이 드문 환경에서 기존 성능·동작을 그대로 보존한다.
     */
    const atomicRemember = isLiteralTrue(process.env, "MEMENTO_REMEMBER_ATOMIC");

    /** atomic=true 경로는 _rememberAtomic 내부 트랜잭션의 FOR UPDATE 잠금으로
     *  quota 재검증을 수행하므로 pre-check를 생략하여 중복 SELECT를 제거한다. */
    if (!(atomicRemember && keyId)) {
      await this.quotaChecker.check(keyId);
    }

    params = await this._autoAssignCaseId(params, sessionId, keyId, groupKeyIds);

    /** 의미 쓰기 관문은 atomic 분기 진입 이전, 트랜잭션 밖에서 실행한다.
     *  soft 위반은 fragment.validation_warnings에 누적되어 INSERT 시 함께 영속화되고,
     *  hard gate 키에서는 SymbolicPolicyViolationError가 throw되어 atomic 트랜잭션을 시작하지 않는다. */
    const fragment = await this._buildGatedFragment(params, { source, sessionId, workspace, agentId, keyId });

    if (atomicRemember && keyId) {
      return await this._rememberAtomic(fragment, { agentId, keyId, groupKeyIds, params });
    }

    return await this._persistNonAtomic(fragment, params, agentId, keyId, groupKeyIds);
  }

  /**
   * scope=session 경로 처리.
   * sessionId가 있으면 영구 저장과 같은 의미 쓰기 관문을 거친 뒤 Working Memory에만 저장하고
   * 즉시 반환한다. Redis에 넣지 못하면 대체 경로(PostgreSQL 작업 기억 행)로 저장하고, 대체
   * 경로도 쓸 수 없으면 저장하지 않았음을 응답에 알린다. 응답의 working_memory가 저장 경로다.
   * sessionId가 없으면 null을 반환하여 permanent 경로로 낙하시킨다.
   *
   * @param {Object} params
   * @param {string} scope
   * @param {string|null} sessionId
   * @returns {Promise<Object|null>}
   */
  async _handleSessionScope(params, scope, sessionId, { agentId, keyId, workspace, source }) {
    if (scope !== "session" || !sessionId) return null;

    const { draft: fragment } = await this._writeGate().check({
      entry : WRITE_ENTRIES.REMEMBER,
      op    : "create",
      fields: params,
      ctx   : { keyId, agentId, provenance: provenanceContext(params), isMaster: params._isMaster === true },
      build : (input) => this._buildFragment(input, source, sessionId, workspace, agentId, keyId)
    });

    let stored = { backend: "redis", id: fragment.id };
    if (!await this.index.addToWorkingMemory(sessionId, fragment)) {
      stored = await this._storeWorkingMemoryFallback(fragment, sessionId);
    }
    const { backend, id } = stored;

    const warnings = Array.isArray(fragment.validation_warnings) ? fragment.validation_warnings : [];
    const hints    = workingMemoryHints(backend, stored.reason);
    return {
      id,
      keywords      : fragment.keywords,
      ttl_tier      : "session",
      scope         : "session",
      conflicts     : [],
      working_memory: backend,
      ...(warnings.length > 0 ? { validation_warnings: warnings.map(ruleName) } : {}),
      ...truncationField(truncationInfo(warnings)),
      ...(hints.length > 0 ? { _meta: { hints } } : {})
    };
  }

  /**
   * Redis가 작업 기억을 받지 못했을 때 PostgreSQL 작업 기억 행으로 저장한다.
   *
   * @param {Object} fragment  - 관문을 거친 파편
   * @param {string} sessionId
   * @returns {Promise<{backend: "postgres-fallback"|"none", id: string, reason?: string}>} reason은 none이면 미저장 사유, postgres-fallback이면 대체 경로로 간 사유
   */
  async _storeWorkingMemoryFallback(fragment, sessionId) {
    if (!wmPgFallbackEnabled()) {
      return { backend: "none", id: fragment.id, reason: WM_NONE_REASON.FALLBACK_OFF };
    }

    await this.index.enforceFallbackKeyCap(fragment.key_id ?? null);
    const id = await this.store.insert(markWorkingMemoryRow(fragment));
    if (!id) return { backend: "none", id: fragment.id, reason: WM_NONE_REASON.WRITE_UNAVAILABLE };

    await this.index.enforceFallbackWorkingMemoryBudget(sessionId);
    const redisReady = this.index.workingMemoryBackend?.() === "redis";
    return {
      backend: "postgres-fallback",
      id,
      reason : redisReady ? WM_FALLBACK_CAUSE.WRITE_FAILED : WM_FALLBACK_CAUSE.NOT_READY
    };
  }

  /**
   * idempotencyKey 중복 검사.
   * 같은 key_id 범위에서 동일한 idempotencyKey로 호출하면 기존 파편을 즉시 반환한다.
   * DB 인덱스(idx_fragments_idempotency_tenant / idx_fragments_idempotency_master)로
   * 보장하는 유일성과 일치하며, quota 소모 없이 안전하게 재시도를 허용한다.
   *
   * @param {Object}      params
   * @param {string|null} keyId
   * @returns {Promise<Object|null>}
   */
  async _checkIdempotency(params, keyId) {
    if (!params.idempotencyKey) return null;

    const existing = await this.store.findByIdempotencyKey(params.idempotencyKey, keyId);
    if (!existing) return null;

    return {
      id         : existing.id,
      keywords   : existing.keywords ?? [],
      ttl_tier   : existing.ttl_tier,
      scope      : "permanent",
      conflicts  : [],
      idempotent : true,
      existing   : true
    };
  }

  /**
   * M5 dryRun 처리.
   * 파편 생성 없이 실행 계획(할당량·충돌·검증 경고)을 반환한다.
   * factory.create / policyRules.check / quotaChecker.getUsage는 side-effect free이므로
   * 호출하되 store.insert / index.index / postProcessor.run은 완전 생략한다.
   *
   * @param {Object}      params
   * @param {string|null} source
   * @param {string|null} sessionId
   * @param {string|null} workspace
   * @param {string|null} keyId
   * @returns {Promise<Object|null>}
   */
  async _handleDryRun(params, source, sessionId, workspace, keyId) {
    if (params.dryRun !== true) return null;

    const agentId = params.agentId || "default";
    const { draft: dryFragment, warnings: validationWarnings, truncation } = await this._writeGate().check({
      entry : WRITE_ENTRIES.REMEMBER,
      op    : "create",
      mode  : "dryRun",
      fields: params,
      ctx   : { keyId, agentId, provenance: provenanceContext(params), isMaster: params._isMaster === true },
      build : (input) => {
        const f = this.factory.create({
          ...input,
          source         : source,
          contextSummary : input.contextSummary || null,
          sessionId,
          isAnchor       : input.isAnchor || false,
          affect         : input.affect   || undefined
        }, { contentPrepared: true });
        f.agent_id  = agentId;
        f.key_id    = keyId;
        f.workspace = workspace;
        return f;
      }
    });

    // iron-laws: ignore[IL-301] dryRun 미리보기에서는 충돌 탐지 실패를 충돌 없음으로 보여 준다
    const conflicts = await this.conflictResolver.detectConflicts(
      dryFragment.content, dryFragment.topic, null, dryFragment.agent_id, keyId, workspace
    ).catch(() => []);

    const quota = await this.quotaChecker.getUsage(keyId).catch(() => ({
      limit: null, current: 0, remaining: null, resetAt: null
    }));

    return {
      dryRun   : true,
      simulated: {
        fragment: {
          id          : "<would-generate>",
          type        : dryFragment.type,
          content     : dryFragment.content,
          keywords    : dryFragment.keywords,
          importance  : dryFragment.importance,
          ttl_tier    : dryFragment.ttl_tier
        },
        conflicts           : conflicts.map(c => ({ id: c.id, content: c.content })),
        validation_warnings : validationWarnings,
        ...truncationField(truncation),
        quota
      }
    };
  }

  /**
   * case_id 자동 할당.
   * 동일 session+topic의 error 흐름을 감지하여 caseId를 설정한 새 params를 반환한다.
   * 변경이 없으면 원본 params를 그대로 반환한다.
   *
   * @param {Object}        params
   * @param {string|null}   sessionId
   * @param {string|null}   keyId
   * @param {string[]|null} groupKeyIds
   * @returns {Promise<Object>}
   */
  async _autoAssignCaseId(params, sessionId, keyId, groupKeyIds) {
    const AUTO_CASE_TYPES = new Set(["error", "procedure", "decision"]);
    if (params.caseId || !sessionId || !params.topic || !AUTO_CASE_TYPES.has(params.type)) {
      return params;
    }

    const caseScope = {
      agentId: params.agentId || "default",
      includePeerAgents: false,
      workspace: params.workspace ?? params._defaultWorkspace ?? null,
      allWorkspaces: false
    };
    const existingCaseId = await this.store.findCaseIdBySessionTopic(
      sessionId, params.topic, keyId, groupKeyIds, caseScope
    );
    if (existingCaseId) {
      return { ...params, caseId: existingCaseId };
    }

    if (params.type === "error") {
      return { ...params, caseId: crypto.randomUUID() };
    }

    const errorIds = await this.store.findErrorFragmentsBySessionTopic(
      sessionId, params.topic, keyId, groupKeyIds, caseScope
    );
    if (errorIds.length > 0) {
      const newCaseId = crypto.randomUUID();
      Promise.all(errorIds.map(id => this.store.updateCaseId(
        id, newCaseId, keyId, { ...caseScope, groupKeyIds }
      )))
        .catch(err => logWarn(`[MemoryRememberer] auto-case-id backfill failed: ${err.message}`));
      return { ...params, caseId: newCaseId };
    }

    return params;
  }

  /**
   * 이 인스턴스의 정책 의존성으로 의미 쓰기 관문을 만든다. 시험이 인스턴스 속성으로 바꾼
   * policyRules, _getHardGate, _policyGatingEnabled를 호출 시점에 반영한다.
   *
   * @returns {WriteGate}
   */
  _writeGate() {
    return new WriteGate({
      policyRules          : this.policyRules,
      policyGatingEnabled  : this._policyGatingEnabled,
      getHardGate          : (keyId) => this._getHardGate(keyId),
      checkWorkspaceAllowed,
      ...this._anchorDeps
    });
  }

  /**
   * remember 입력을 관문에 통과시키고 저장할 파편을 만든다.
   *
   * @param {Object} params
   * @param {Object} meta - source, sessionId, workspace, agentId, keyId
   * @returns {Promise<Object>} 관문 판정이 반영된 파편
   */
  async _buildGatedFragment(params, { source, sessionId, workspace, agentId, keyId }) {
    const { draft } = await this._writeGate().check({
      entry : WRITE_ENTRIES.REMEMBER,
      op    : "create",
      fields: params,
      ctx   : { keyId, agentId, provenance: provenanceContext(params), isMaster: params._isMaster === true },
      build : (input) => this._buildFragment(input, source, sessionId, workspace, agentId, keyId)
    });
    return draft;
  }

  /**
   * fragment 생성 및 메타 필드(agent_id, key_id, workspace) 주입.
   *
   * @param {Object}      params
   * @param {string|null} source
   * @param {string|null} sessionId
   * @param {string|null} workspace
   * @param {string}      agentId
   * @param {string|null} keyId
   * @returns {Object}
   */
  _buildFragment(params, source, sessionId, workspace, agentId, keyId) {
    const fragment = this.factory.create({
      ...params,
      source         : source,
      contextSummary : params.contextSummary || null,
      sessionId,
      isAnchor       : params.isAnchor || false,
      affect         : params.affect   || undefined
    }, { contentPrepared: true });
    fragment.agent_id  = agentId;
    fragment.key_id    = keyId;
    fragment.workspace = workspace;
    /** workspace 해석 출처: 명시 파라미터 > 키 기본값 > 미지정 */
    fragment.workspace_source = params.workspace != null
      ? "explicit"
      : (params._defaultWorkspace != null ? "key_default" : "unscoped");
    return fragment;
  }

  /**
   * non-atomic INSERT 이후 공통 후속 처리.
   * index, postProcessor, conflict 감지, supersedes, TTL 하향, 결과 조립을 수행한다.
   *
   * @param {Object}        fragment      - factory.create() 이후 파편
   * @param {Object}        params        - remember() 원본 params
   * @param {string}        agentId
   * @param {string|null}   keyId
   * @param {string[]|null} groupKeyIds
   * @returns {Promise<Object>}
   */
  async _persistNonAtomic(fragment, params, agentId, keyId, groupKeyIds) {
    const id  = await timeStage(rememberStageDuration, { stage: "insert" }, () => this.store.insert(fragment));
    const hit = isDuplicateHit(fragment, id)
      ? await resolveDuplicateHit(this.store, fragment, id, { agentId, keyId, scope: "permanent" })
      : null;
    if (hit?.response) return hit.response;

    return this._finalizeRemember({ ...fragment, id }, { agentId, keyId, groupKeyIds, params, hit });
  }

  /**
   * TOCTOU-safe 단일 트랜잭션 remember 경로.
   * MEMENTO_REMEMBER_ATOMIC=true이고 keyId가 존재할 때만 호출된다.
   *
   * BEGIN → api_keys FOR UPDATE → 현재 fragment 수 재검증 →
   * FragmentWriter.insert(client) → COMMIT 순서로 원자 실행한다.
   * BatchRememberProcessor._checkQuotaPhaseB와 동일한 SELECT 조건·잠금 범위를 사용한다.
   *
   * @param {Object} fragment          - factory.create() 이후의 파편 객체 (id 포함)
   * @param {Object} ctx
   * @param {string}      ctx.agentId
   * @param {string}      ctx.keyId
   * @param {string[]|null} ctx.groupKeyIds
   * @param {Object}      ctx.params   - remember() 원본 params (postProcessor 등 후속 처리용)
   * @returns {Promise<Object>} remember() 반환 구조와 동일
   */
  async _rememberAtomic(fragment, { agentId, keyId, groupKeyIds, params }) {
    const pool = getPrimaryPool();
    if (!pool) {
      /** DB 없음 — 기존 경로로 폴백 */
      await this.quotaChecker.check(keyId);
      const id = await timeStage(rememberStageDuration, { stage: "insert" }, () => this.store.insert(fragment));
      return this._finalizeRemember({ ...fragment, id }, { agentId, keyId, groupKeyIds, params });
    }
    const _safeAgent = String(agentId || "default").replace(/[^a-zA-Z0-9_-]/g, "");
    const client    = await pool.connect();

    let id;
    try {
      await client.query(buildSearchPath(SCHEMA));
      await client.query("BEGIN");
      await client.query("SET LOCAL app.current_agent_id = 'system'");

      /** BatchRememberProcessor._checkQuotaPhaseB와 동일한 잠금·SELECT */
      const { rows: [keyRow] } = await client.query(
        `SELECT fragment_limit FROM ${SCHEMA}.api_keys WHERE id = $1 FOR UPDATE`,
        [keyId]
      );

      if (keyRow && keyRow.fragment_limit !== null) {
        const currentCount = await countLiveFragments(client, keyId);
        if (currentCount >= keyRow.fragment_limit) {
          await client.query("ROLLBACK");
          const err   = new Error(
            `Fragment limit reached (${currentCount}/${keyRow.fragment_limit}). Delete unused fragments or request a higher limit.`
          );
          err.code    = "fragment_limit_exceeded";
          err.current = currentCount;
          err.limit   = keyRow.fragment_limit;
          throw err;
        }
      }

      /** SET LOCAL을 agentId로 전환 후 INSERT — FragmentWriter가 safeAgent 재설정 */
      id = await timeStage(rememberStageDuration, { stage: "insert" }, () => this.store.writer.insert(fragment, { client }));

      await client.query("COMMIT");
    } catch (err) {
      // iron-laws: ignore[IL-301] ROLLBACK 실패만 무시하고 원래 오류를 다시 던진다
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const hit = isDuplicateHit(fragment, id)
      ? await resolveDuplicateHit(this.store, fragment, id, { agentId, keyId, scope: "permanent" })
      : null;
    if (hit?.response) return hit.response;

    return this._finalizeRemember({ ...fragment, id }, { agentId, keyId, groupKeyIds, params, hit });
  }

  /**
   * INSERT 이후 공통 후속 처리(index, postProcessor, conflict, supersedes 등)를
   * 담당하는 내부 헬퍼. 비원자 경로와 _rememberAtomic()이 공유한다. 충돌 탐지와 자동 링크는 서로의 결과를
   * 쓰지 않으므로 함께 띄운다.
   *
   * @param {Object} fragment   - id가 확정된 파편 객체
   * @param {Object} ctx
   * @returns {Promise<Object>} remember() 반환 구조
   */
  async _finalizeRemember(fragment, { agentId, keyId, groupKeyIds, params, hit = null }) {
    const id = fragment.id;

    await timeStage(rememberStageDuration, { stage: "index" }, () =>
      this.index.index(fragment, fragment.session_id ?? params.sessionId, fragment.key_id ?? null));
    /** 후처리 파이프라인 (임베딩, 형태소, 링크, assertion, 시간링크, 평가큐) */
    await timeStage(rememberStageDuration, { stage: "postprocess" }, () =>
      this.postProcessor.run(fragment, { agentId, keyId, groupKeyIds }));

    /** 충돌 감지 — skipConflictDetection=true(예: reflect의 내부 episode)면 동기 임베딩+검색을 생략한다. */
    const [conflicts] = await Promise.all([
      params.skipConflictDetection
        ? []
        : timeStage(rememberStageDuration, { stage: "conflict" }, () => this.conflictResolver.detectConflicts(
          fragment.content, fragment.topic, id, agentId, keyId, fragment.workspace ?? null
        )),
      timeStage(rememberStageDuration, { stage: "autolink" }, () =>
        this.conflictResolver.autoLinkOnRemember(fragment, agentId)).catch(err => {
        logWarn(`[MemoryRememberer] autoLinkOnRemember failed: ${err.message}`);
      })
    ]);

    if (params.supersedes && Array.isArray(params.supersedes)) {
      for (const oldId of params.supersedes) {
        if (oldId === id) continue;
        try {
          await this._supersede(oldId, id, agentId, keyId);
        } catch (err) {
          logWarn(`[MemoryRememberer] supersede ${oldId} failed: ${err.message}`);
        }
      }
    }

    const effectiveImportance = fragment.importance ?? 0.5;
    let   lowImportanceWarning;
    let   effectiveTtlTier    = fragment.ttl_tier;

    if (effectiveImportance < 0.3) {
      lowImportanceWarning = "이 내용은 낮은 중요도로 저장됩니다. 장기 보존이 필요하면 importance를 명시하세요.";
      if (!params.ttl_tier) {
        effectiveTtlTier = "short";
        await this.store.updateTtlTier(id, "short", keyId).catch(err => {
          logWarn(`[MemoryRememberer] ttl_tier update failed: ${err.message}`);
        });
      }
    }

    const result = {
      id,
      keywords      : fragment.keywords,
      ttl_tier      : effectiveTtlTier,
      scope         : "permanent",
      conflicts,
      ...duplicateOfField(hit, id)
    };

    if (Array.isArray(fragment.validation_warnings) && fragment.validation_warnings.length > 0) {
      result.validation_warnings = fragment.validation_warnings.map(v =>
        typeof v === "object" && v !== null && v.rule ? String(v.rule) : String(v)
      );
      Object.assign(result, truncationField(truncationInfo(fragment.validation_warnings)));
    }

    if (lowImportanceWarning) {
      result.low_importance_warning = lowImportanceWarning;
    }

    if (fragment.case_id && this.caseEventStore) {
      this._recordCaseEvent(fragment, keyId).catch(err =>
        logWarn(`[MemoryRememberer] case event recording failed: ${err.message}`)
      );
    }

    return result;
  }

  /**
   * case_id가 있는 파편에 대해 case_events에 이벤트를 기록한다.
   * fragment_evidence(produced_by), preceded_by 엣지, resolved_by 엣지를 자동 생성한다.
   *
   * @param {Object}      fragment - id가 포함된 파편 객체
   * @param {number|null} keyId
   */
  async _recordCaseEvent(fragment, keyId) {
    const eventType = MemoryRememberer.FRAG_TO_EVENT[fragment.type];
    if (!eventType) return;

    // Callers run after the insert transaction commits. A persisted fragment's
    // source key may differ from the caller key (for example, a shared result).
    const sourceKeyId = Object.hasOwn(fragment, "key_id") ? fragment.key_id : keyId;

    const appended = await this.caseEventStore.append({
      case_id           : fragment.case_id,
      session_id        : fragment.session_id ?? null,
      event_type        : eventType,
      summary           : (fragment.content || "").slice(0, 200),
      entity_keys       : fragment.keywords || [],
      source_fragment_id: fragment.id,
      key_id            : sourceKeyId ?? null,
      /** fragment_evidence: 이 파편이 이벤트의 근거. 검증 전 추론(inferred) 파편은 기여가 섞인 근거로 둔다. */
      evidence          : [{ fragment_id: fragment.id, kind: "produced_by", confidence: evidenceConfidence(fragment) }]
    });
    if (appended.inserted === false) return;
    const { event_id } = appended;

    /** preceded_by: 동일 case_id의 직전 이벤트와 연결 */
    const eventScope = {
      keyId: sourceKeyId ?? null,
      agentId: fragment.agent_id ?? "default",
      workspace: fragment.workspace ?? null
    };
    const prevEvents = await this.caseEventStore.getByCase(fragment.case_id, {
      ...eventScope, limit: 2
    });
    const prevEvent  = prevEvents.find(e => e.event_id !== event_id);
    if (prevEvent) {
      await this.caseEventStore.addEdge(event_id, prevEvent.event_id, "preceded_by").catch((err) => {
        logWarn("[MemoryRememberer] case event edge failed", { from: event_id, to: prevEvent.event_id, error: err?.message });
      });
    }

    /** resolved_by: procedure가 동일 case의 error를 해결. 규약은 error 이벤트에서 해결 이벤트로 가는 간선이다. */
    if (eventType === "fix_attempted") {
      const errorEvents = await this.caseEventStore.getByCase(
        fragment.case_id,
        { ...eventScope, eventType: "error_observed" }
      );
      for (const errEvt of errorEvents) {
        await this.caseEventStore.addEdge(errEvt.event_id, event_id, "resolved_by").catch((err) => {
          logWarn("[MemoryRememberer] case event edge failed", { from: errEvt.event_id, to: event_id, error: err?.message });
        });
      }
    }
  }

  /**
   * batchRemember - 복수 파편 일괄 저장
   *
   * BatchRememberProcessor에 위임한다.
   *
   * @param {Object} params
   *   - fragments {Array<Object>} 파편 배열
   *   - agentId   {string}       에이전트 ID (선택)
   *   - _keyId    {string|null}  API 키 ID (선택)
   * @returns {{ results: Array<{id, success, error?}>, inserted: number, skipped: number }}
   */
  async batchRemember(params, onProgress = null) {
    return this.batchRememberProcessor.process(params, onProgress);
  }

  /**
   * 기존 파편을 새 파편으로 대체한다 (ConflictResolver.supersede 위임 래퍼).
   * tests/unit/supersedes-param.test.js 가 존재/위임 패턴을 명시적으로 검증하므로 유지.
   *
   * - superseded_by 링크 생성
   * - 구 파편의 valid_to 를 현재 시각으로 설정
   * - 구 파편의 importance 를 반감
   *
   * @param {string}      oldId   - 대체될 파편 ID
   * @param {string}      newId   - 대체하는 파편 ID
   * @param {string}      agentId
   * @param {string|null} keyId
   */
  async _supersede(oldId, newId, agentId = "default", keyId = null) {
    return this.conflictResolver.supersede(oldId, newId, agentId, keyId);
  }

  /**
   * amend - 기존 파편의 content/metadata를 갱신한다. 구현은 MemoryAmender에 있다.
   *
   * @param {Object} params
   * @returns {Promise<Object>} { updated, fragment }
   */
  async amend(params) {
    return amendFragment(this, params);
  }

  /**
   * 승인 inventory CLI 전용 사전검증.
   *
   * inventory가 반환한 workspace를 다시 바인딩해야 global-only 기본값 아래에서도
   * named-workspace 파편을 안전하게 찾을 수 있다. 실행 전에 승인 목록 전체를 이
   * 메서드로 확인하면 뒤쪽 항목의 잘못된 scope 때문에 앞쪽 항목만 먼저 바뀌는
   * 예측 가능한 부분 적용도 막을 수 있다.
   */
  async validateFragmentAgentNormalization(
    id,
    currentAgentId,
    { anchorsOnly = true, workspace = null, allWorkspaces = false } = {}
  ) {
    const existing = await this.store.getById(id, currentAgentId, null, [], {
      includePeerAgents: false,
      workspace,
      allWorkspaces
    });
    const expectedWorkspace = workspace ?? null;
    const wrongWorkspace = allWorkspaces !== true
      && (existing?.workspace ?? null) !== expectedWorkspace;
    if (
      !existing
      || wrongWorkspace
      || (anchorsOnly && existing.is_anchor !== true)
      || existing.agent_id !== currentAgentId
    ) {
      return { valid: false, error: "Approved fragment not found in the expected agent scope" };
    }
    if (currentAgentId === "default") {
      return { valid: false, error: "Fragment is already shared" };
    }
    return { valid: true, fragment: existing };
  }

  /** 승인 inventory CLI 전용: public amend schema를 우회하지 않는 내부 정규화 경로. */
  async normalizeFragmentAgentToDefault(
    id,
    currentAgentId,
    { anchorsOnly = true, workspace = null, allWorkspaces = false } = {}
  ) {
    const validation = await this.validateFragmentAgentNormalization(
      id, currentAgentId, { anchorsOnly, workspace, allWorkspaces }
    );
    if (!validation.valid) {
      return { updated: false, error: validation.error };
    }
    const existing = validation.fragment;

    try {
      await this.index.deindex(
        existing.id, existing.keywords, existing.topic, existing.type,
        existing.key_id ?? null, { strict: true, content: existing.content }
      );
    } catch (err) {
      return {
        updated: false,
        error: `Agent scope cache consistency failed: ${err.message}`
      };
    }

    const restorePrivateIndex = async () => {
      await this.index.index(
        existing, null, existing.key_id ?? null, { strict: true }
      );
    };

    let result;
    try {
      result = await this.store.update(
        id, { agent_id: "default" }, currentAgentId, null, existing,
        { amendedBy: "system:anchor-scope", normalizeVersionAgentToDefault: true }
      );
    } catch (err) {
      try {
        await restorePrivateIndex();
      } catch (restoreErr) {
        throw new Error(
          "Agent scope database update and private cache restore both failed",
          { cause: restoreErr }
        );
      }
      throw err;
    }
    if (!result || result.merged) {
      try {
        await restorePrivateIndex();
      } catch (restoreErr) {
        throw new Error(
          "Agent scope database update did not complete and private cache restore failed",
          { cause: restoreErr }
        );
      }
      return { updated: false, error: "Agent scope normalization failed" };
    }

    try {
      await this.index.index(result, null, existing.key_id ?? null, { strict: true });
    } catch (err) {
      return {
        updated: true,
        databaseUpdated: true,
        cacheConsistent: false,
        cacheWarning: `Agent scope cache consistency failed: ${err.message}`,
        fragment: result
      };
    }
    return { updated: true, fragment: result };
  }

  normalizeAnchorAgentToDefault(id, currentAgentId, opts = {}) {
    return this.normalizeFragmentAgentToDefault(
      id, currentAgentId, { ...opts, anchorsOnly: true }
    );
  }

  /**
   * forget - 파편 망각. 구현은 MemoryForgetter에 있다.
   *
   * @param {Object} params
   * @returns {Promise<Object>} { deleted, protected, purged? }
   */
  async forget(params) {
    return forgetFragments(this, params);
  }
}
