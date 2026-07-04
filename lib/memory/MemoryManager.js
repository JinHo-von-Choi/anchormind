/**
 * MemoryManager - 파편 기반 기억 시스템 통합 관리자 (Phase 5-B facade)
 *
 * 작성자: 최진호
 * 작성일: 2026-02-23
 * 수정일: 2026-04-20 (Phase 5-B MemoryManager 분해 — 책임을 4개 프로세서로 이관)
 *
 * MCP 도구 핸들러에서 호출되는 단일 진입점.
 * remember, recall, forget, link, amend, reflect, context, batchRemember,
 * toolFeedback, graphExplore, fragmentHistory, reconstructHistory,
 * consolidate, stats, deleteByAgent 공개 메서드를 그대로 유지한다.
 *
 * 실제 로직은 `lib/memory/processors/` 의 4개 클래스에 이관된다:
 *   - MemoryRememberer: remember / batchRemember / amend / forget / _supersede /
 *                       _rememberAtomic / _finalizeRemember / _recordCaseEvent
 *   - MemoryRecaller  : recall / context / graphExplore / toolFeedback / fragmentHistory
 *   - MemoryReflector : reflect / reconstructHistory / stats / consolidate
 *   - MemoryLinker    : link / deleteByAgent
 *
 * 공개 API 시그니처와 반환 계약은 분해 전과 100% 동일하다.
 */

import { FragmentStore }         from "./FragmentStore.js";
import { getFragmentIndex }      from "./FragmentIndex.js";
import { FragmentSearch }        from "./FragmentSearch.js";
import { FragmentFactory }       from "./FragmentFactory.js";
import { MemoryConsolidator }    from "./MemoryConsolidator.js";
import { MorphemeIndex }         from "./MorphemeIndex.js";
import { ConflictResolver }      from "./ConflictResolver.js";
import { SessionLinker }         from "./SessionLinker.js";
import { TemporalLinker }        from "./TemporalLinker.js";
import { CaseEventStore }        from "./CaseEventStore.js";
import { QuotaChecker }          from "./QuotaChecker.js";
import { RememberPostProcessor } from "./RememberPostProcessor.js";
import { ContextBuilder }        from "./read/ContextBuilder.js";
import { ReflectProcessor }      from "./ReflectProcessor.js";
import { BatchRememberProcessor } from "./BatchRememberProcessor.js";
import { LinkIntegrityChecker }  from "../symbolic/LinkIntegrityChecker.js";
import { PolicyRules }           from "../symbolic/PolicyRules.js";
import { getSymbolicHardGate }   from "../admin/ApiKeyStore.js";
import { RecallSuggestionEngine } from "./RecallSuggestionEngine.js";
import { MemoryRememberer }      from "./processors/MemoryRememberer.js";
import { MemoryRecaller }        from "./processors/MemoryRecaller.js";
import { MemoryReflector }       from "./processors/MemoryReflector.js";
import { MemoryLinker }          from "./processors/MemoryLinker.js";

const morphemeIndex = new MorphemeIndex();

let instance = null;

/**
 * facade와 모든 프로세서 간 공유 프로퍼티 목록.
 * 테스트 또는 런타임에서 facade 프로퍼티를 교체(`mm.store = stub`)하면
 * 대응되는 프로세서에도 자동 전파되어 mock 주입 호환성을 유지한다.
 */
const SHARED_PROPS = [
  "store", "index", "search", "factory", "consolidator",
  "sessionLinker", "linkChecker", "policyRules",
  "conflictResolver", "temporalLinker", "caseEventStore",
  "quotaChecker", "postProcessor", "contextBuilder",
  "reflectProcessor", "batchRememberProcessor",
  "suggestionEngine"
];

/**
 * private 프로퍼티(언더스코어 접두). 프로세서 생성자 인자 이름은 접두가 없으므로
 * 매핑 테이블로 전파 대상 키를 지정한다.
 */
const PRIVATE_PROP_MAP = {
  _getHardGate        : "_getHardGate",
  _policyGatingEnabled: "_policyGatingEnabled"
};

export class MemoryManager {
  constructor() {
    /** 공유 객체 초기화 — 순서 보존 (Phase 5-B §6.1 리스크 완화) */
    this.store             = new FragmentStore();
    this.index             = getFragmentIndex();
    this.search            = new FragmentSearch();
    this.factory           = new FragmentFactory();
    this.consolidator      = new MemoryConsolidator();
    this.sessionLinker     = new SessionLinker(this.store, this.index);

    /** Phase 3/4 symbolic components — advisory only, 기본값 off */
    this.linkChecker       = new LinkIntegrityChecker({ sessionLinker: this.sessionLinker });
    this.policyRules       = new PolicyRules();

    this.conflictResolver  = new ConflictResolver(this.store, this.search, {
      linkChecker: this.linkChecker
    });
    this.temporalLinker    = new TemporalLinker(this.store.links);
    this.caseEventStore    = new CaseEventStore();
    this.quotaChecker      = new QuotaChecker();
    this.postProcessor     = new RememberPostProcessor({
      store           : this.store,
      conflictResolver: this.conflictResolver,
      temporalLinker  : this.temporalLinker,
      morphemeIndex,
      search          : this.search,
      linkChecker     : this.linkChecker,
    });
    this.contextBuilder    = new ContextBuilder({
      recall: this.recall.bind(this),
      store : this.store,
      index : this.index,
    });
    this.batchRememberProcessor = new BatchRememberProcessor({
      store  : this.store,
      index  : this.index,
      factory: this.factory,
    });
    this.reflectProcessor  = new ReflectProcessor({
      store                : this.store,
      index                : this.index,
      factory              : this.factory,
      sessionLinker        : this.sessionLinker,
      remember             : this.remember.bind(this),
      batchRememberProcessor: this.batchRememberProcessor,
    });

    /**
     * hard gate 조회 함수. 기본값은 ApiKeyStore.getSymbolicHardGate.
     * 단위 테스트에서 인스턴스 프로퍼티 교체로 mock 주입 가능.
     */
    this._getHardGate = getSymbolicHardGate;

    /**
     * Phase 4 Soft/Hard Gating 활성화 여부.
     * null이면 SYMBOLIC_CONFIG 값을 사용. 단위 테스트에서 true 설정 가능.
     */
    this._policyGatingEnabled = null;

    /**
     * 비침습적 사용 패턴 힌트 엔진 (optional).
     * 미주입 시 suggestionEngine?.suggest() 옵셔널 체이닝이 null 반환.
     */
    this.suggestionEngine = new RecallSuggestionEngine();

    /** Phase 5-B 프로세서 초기화 — 공유 객체가 모두 준비된 뒤에 생성 */
    this.rememberer = new MemoryRememberer({
      store                 : this.store,
      index                 : this.index,
      factory               : this.factory,
      quotaChecker          : this.quotaChecker,
      postProcessor         : this.postProcessor,
      conflictResolver      : this.conflictResolver,
      caseEventStore        : this.caseEventStore,
      policyRules           : this.policyRules,
      sessionLinker         : this.sessionLinker,
      batchRememberProcessor: this.batchRememberProcessor,
      linkChecker           : this.linkChecker,
      getHardGate           : this._getHardGate,
      policyGatingEnabled   : this._policyGatingEnabled,
      morphemeIndex,
    });
    this.recaller = new MemoryRecaller({
      store           : this.store,
      search          : this.search,
      index           : this.index,
      caseEventStore  : this.caseEventStore,
      contextBuilder  : this.contextBuilder,
      suggestionEngine: this.suggestionEngine,
    });
    this.reflector = new MemoryReflector({
      reflectProcessor: this.reflectProcessor,
      store           : this.store,
      caseEventStore  : this.caseEventStore,
      consolidator    : this.consolidator,
    });
    this.linker = new MemoryLinker({
      store: this.store,
      index: this.index,
    });

    /**
     * 공유 프로퍼티 setter 동기화 — facade 프로퍼티 교체가 프로세서에 자동 전파되도록
     * accessor 기반 defineProperty로 래핑한다. 테스트가 `mm.store = stubStore`로
     * 공유 객체를 교체하면 rememberer/recaller/reflector/linker가 즉시 새 참조를 사용한다.
     */
    this._installSharedSync();
  }

  _installSharedSync() {
    const self = this;
    const procs = () => [self.rememberer, self.recaller, self.reflector, self.linker];

    for (const key of SHARED_PROPS) {
      let value = self[key];
      Object.defineProperty(self, key, {
        configurable: true,
        enumerable  : true,
        get() { return value; },
        set(v) {
          value = v;
          for (const proc of procs()) {
            if (proc && key in proc) proc[key] = v;
          }
        }
      });
    }

    for (const [facadeKey, procKey] of Object.entries(PRIVATE_PROP_MAP)) {
      let value = self[facadeKey];
      Object.defineProperty(self, facadeKey, {
        configurable: true,
        enumerable  : true,
        get() { return value; },
        set(v) {
          value = v;
          for (const proc of procs()) {
            if (proc && procKey in proc) proc[procKey] = v;
          }
        }
      });
    }
  }

  static getInstance() {
    if (!instance) {
      instance = new MemoryManager();
    }
    return instance;
  }

  /**
   * 테스트용 팩터리. 원하는 공유 의존성을 mock으로 주입한 인스턴스를 반환한다.
   * 공유 프로퍼티 setter가 자동으로 내부 프로세서에 전파한다.
   */
  static create(deps = {}) {
    const mm = new MemoryManager();
    if (deps.store)            mm.store            = deps.store;
    if (deps.search)           mm.search           = deps.search;
    if (deps.factory)          mm.factory          = deps.factory;
    if (deps.consolidator)     mm.consolidator     = deps.consolidator;
    if (deps.conflictResolver) mm.conflictResolver = deps.conflictResolver;
    if (deps.sessionLinker)    mm.sessionLinker    = deps.sessionLinker;
    return mm;
  }

  /* ─────────────────────────── 공개 API (위임) ─────────────────────────── */

  async remember(params)           { return this.rememberer.remember(params); }
  async batchRemember(params, onProgress = null) { return this.rememberer.batchRemember(params, onProgress); }
  async amend(params)              { return this.rememberer.amend(params); }
  async forget(params)             { return this.rememberer.forget(params); }

  async recall(params)             { return this.recaller.recall(params); }
  async context(params)            { return this.recaller.context(params); }
  async graphExplore(params)       { return this.recaller.graphExplore(params); }
  async toolFeedback(params)       { return this.recaller.toolFeedback(params); }
  async fragmentHistory(params)    { return this.recaller.fragmentHistory(params); }

  async reflect(params)            { return this.reflector.reflect(params); }
  async reconstructHistory(params) { return this.reflector.reconstructHistory(params); }
  async consolidate(onProgress = null) { return this.reflector.consolidate(onProgress); }
  async stats()                    { return this.reflector.stats(); }

  async link(params)               { return this.linker.link(params); }
  async deleteByAgent(agentId)     { return this.linker.deleteByAgent(agentId); }

  async drainMorpheme() {
    if (typeof this.postProcessor?.drainMorpheme === "function") {
      return this.postProcessor.drainMorpheme();
    }
  }
}
