/**
 * 기억 시스템 설정
 *
 * 작성자: 최진호
 * 작성일: 2026-02-25
 * 수정일: 2026-03-07 (GC 정책, contextInjection 스마트 캡, pagination 설정 추가)
 */

export const MEMORY_CONFIG = {
  /** 복합 랭킹 가중치 (합계 1.0) */
  ranking: {
    importanceWeight    : 0.4,
    recencyWeight       : 0.3,
    semanticWeight      : 0.3,
    activationThreshold : 0,
    recencyHalfLifeDays : 30,
    /** recall 최종 정렬 lexical 보정 — hard override 아님, 제한된 가산항.
     *  lexWeight는 파편별 rerankerScore 유무로 결정한다(집합 단위 판정 아님). */
    lexicalWeightReranked    : 0.12, // rerankerScore 보유 파편의 lexical 미세 보정
    lexicalWeightFallback    : 0.18, // rerankerScore 미보유 파편의 lexical 보강 (semanticWeight 0.30보다 명확히 낮게)
    lexicalLinkedMultiplier  : 0.5,  // includeLinks 파편의 lexical 가중치 감쇠
    lexicalSaturation        : 8,    // lexicalMatchScore log 정규화 분모
    unrerankedBaseDiscount   : 0.85, // rerankerScore 미보유 파편 base에 적용하는 페널티 (reranking 미검증 신호)
  },
  /** stale 검증 주기 (일) */
  staleThresholds: {
    procedure: 30,
    fact      : 60,
    decision  : 90,
    default   : 60
  },
  /** 연결 파편 조회 한도 (getLinkedFragments 1-hop 결과 최대 수) */
  linkedFragmentLimit: 10,
  /**
   * type별 지수 감쇠 반감기 (일)
   * lib/memory/decay.js 의 HALF_LIFE_DAYS 와 동기화 필요.
   * 실제 SQL 계산은 FragmentStore.decayImportance() 내 CASE WHEN 참조.
   */
  halfLifeDays: {
    procedure : 30,
    fact      : 60,
    decision  : 90,
    error     : 45,
    preference: 120,
    relation  : 90,    // 미사용: fragment_links 테이블이 관계를 담당. 향후 제거 후보
    default   : 60
  },
  /** Reciprocal Rank Fusion 검색 설정 */
  rrfSearch: {
    k                : 60,    // RRF 상수 (높을수록 상위 랭크 부스트 감소)
    l1WeightFactor   : 2.0,   // L1(Redis) 결과 가중치 배수
    graphWeightFactor: 1.5    // L2.5 그래프 이웃 가중치 배수
  },
  /** L2.5 그래프 이웃 검색 설정 */
  graph: {
    seedCount     : 10,       // L2 상위 N개 파편을 그래프 시드로 사용
    relationBoosts: {
      caused_by    : 1.5,
      resolved_by  : 1.5,
      related      : 1.0,
      part_of      : 1.0,
      co_retrieved : 0.5,
      contradicts  : 0.3,
      superseded_by: 0.3
    }
  },
  /** 임베딩 비동기 워커 설정 */
  embeddingWorker: {
    batchSize   : 10,
    intervalMs  : 5000,
    retryLimit  : 3,
    retryDelayMs: 2000,
    queueKey    : "memento:embedding_queue"
  },
  /** 컨텍스트 주입 설정 */
  contextInjection: {
    maxCoreFragments   : 15,
    maxWmFragments     : 10,
    typeSlots          : {
      learning   : 3,
      preference : 5,
      error      : 5,
      procedure  : 5,
      decision   : 3,
      fact       : 3
    },
    defaultTokenBudget : 2000,
    temperatureBoost   : {
      warmWindowDays     : 7,
      warmBoost          : 0.2,
      highAccessBoost    : 0.15,
      highAccessThreshold: 5,
      learningBoost      : 0.3,
    },
    /** structured=true 전용: rankedInjection 복합 점수 가중치 (합계 1.0) */
    rankWeights        : {
      importance    : 0.6,
      ema_activation: 0.4
    }
  },
  /** recall 페이지네이션 설정 */
  pagination: {
    defaultPageSize : 20,
    maxPageSize     : 50
  },
  /** session_reflect 파편 정리 정책 */
  reflectionPolicy: {
    maxAgeDays       : 30,
    maxImportance    : 0.3,
    keepPerType      : 5,
    maxDeletePerCycle: 30
  },
  /** 시맨틱 검색 설정. minSimilarity는 SearchParamAdaptor가 적응형으로 조정한다. */
  semanticSearch: {
    minSimilarity: 0.5,
    limit        : 30
  },
  /** 파편 GC 정책 */
  gc: {
    utilityThreshold       : 0.15,
    gracePeriodDays        : 7,
    inactiveDays           : 60,
    maxDeletePerCycle      : 50,
    factDecisionPolicy     : {
      importanceThreshold  : 0.2,
      orphanAgeDays        : 30
    },
    errorResolvedPolicy    : {
      maxAgeDays           : 30,
      maxImportance        : 0.3
    }
  },
  /** 시맨틱 중복 제거 정책 (consolidate 사이클) */
  dedup: {
    batchSize    : Number(process.env.DEDUP_BATCH_SIZE     || 100),
    minFragments : Number(process.env.DEDUP_MIN_FRAGMENTS  || 5),
  },
  /** 기억 압축 정책 (consolidate 사이클) */
  compress: {
    ageDays  : Number(process.env.COMPRESS_AGE_DAYS   || 30),
    minGroup : Number(process.env.COMPRESS_MIN_GROUP   || 3),
  },
  /**
   * ProactiveRecall 자동 링크 정책
   *
   * 작성자: 최진호
   * 수정일: 2026-05-19
   *
   * mode 값:
   *   "off"    — 자동 링크 비활성. remember는 fragment만 저장.
   *   "auto"   — symbolic gate + workspace + caseIdPolicy 검증 통과 시만 related 링크 생성.
   *   "legacy" — 50% 키워드 오버랩 기준 자동 생성 (workspace/case 무관).
   */
  proactiveRecall: {
    mode             : process.env.MEMENTO_PROACTIVE_RECALL_MODE ?? "auto",
    keywordOverlapMin: parseFloat(process.env.MEMENTO_PROACTIVE_KW_OVERLAP_MIN ?? "0.5"),
    // 다른 workspace 파편 간 자동 링크 금지 (mode=auto일 때만 적용)
    requireSameWorkspace : true,
    // caseId 절충 정책:
    //   "both-required"      — 양쪽 모두 caseId 있고 일치해야 통과
    //   "strict-or-adjacent" — null 허용하되 sessionId 동일/24h 인접/workspace 동일 중 하나 요구
    //   "loose"              — 한쪽 null이면 무조건 허용 (legacy 동작)
    caseIdPolicy         : process.env.MEMENTO_PROACTIVE_CASE_POLICY ?? "strict-or-adjacent",
    // strict-or-adjacent에서 시간 인접 판단 폭 (ms)
    adjacencyWindowMs    : 24 * 3600 * 1000,
    // topic/type 일치 요구 — 운영 데이터 검토 후 활성화
    requireSameTopicOrType: false
  },
  /** consolidate 주기 (ms). 기본 6시간 — scheduler.js가 본 값을 참조한다. */
  consolidateIntervalMs: Number(process.env.CONSOLIDATE_INTERVAL_MS || 21600000),
  /**
   * consolidate 실행 조건 및 위험 stage 활성화 설정
   *
   * 작성자: 최진호
   * 수정일: 2026-05-19
   */
  consolidate: {
    /**
     * schema-fit gate: 시간 트리거에 더해 데이터 상태 조건을 평가한다.
     *
     * mode:
     *   "off"  — 시간 트리거만 사용, 조건 평가 생략
     *   "any"  — 아래 세 조건 중 하나라도 충족 시 실행
     *   "all"  — 아래 세 조건 전부 충족해야 실행
     */
    schemaFit: {
      pendingCaseFragmentsMin : 5,   // 같은 caseId 미해결 fragment 누적 임계
      recentRelatedLinksMin   : 20,  // 최근 6h 내 생성된 related 링크 수 임계
      fragmentsSinceLastRunMin: 30,  // 마지막 consolidation 이후 INSERT된 fragment 수 임계
      mode: process.env.MEMENTO_CONSOLIDATE_GATE_MODE ?? "any"
    },
    /**
     * LLM 재작성을 수반하는 위험 stage 활성화 플래그.
     * false로 설정된 stage는 실행 없이 status="skipped"를 반환한다.
     */
    enableRiskyStages: {
      splitLongFragments  : (process.env.MEMENTO_CONSOLIDATE_SPLIT_LONG ?? "true") === "true",
      detectContradictions: (process.env.MEMENTO_CONSOLIDATE_DETECT_CONTRADICT ?? "true") === "true",
      compressOldFragments: (process.env.MEMENTO_CONSOLIDATE_COMPRESS_OLD ?? "false") === "true"
    }
  },
  /** 긴 파편 분할 정책 (Gemini CLI 사용) */
  fragmentSplit: {
    lengthThreshold  : 300,   // 이 길이(자) 초과 파편을 분할 대상으로 선정
    batchSize        : 10,    // 한 사이클에 처리할 최대 파편 수
    minItems         : 2,     // Gemini가 최소 이 수 이상 항목으로 분리해야 원본 대체
    maxItems         : 8,     // Gemini에 요청할 최대 분리 항목 수
    timeoutMs        : 30_000 // 파편당 Gemini 타임아웃
  },
  /** 형태소 사전 및 L3 fallback 설정 */
  morphemeIndex: {
    fallbackThreshold : 5,        // L3 결과가 이 수 이하일 때 형태소 fallback 실행
    fallbackLimit     : 5,        // fallback 최대 반환 파편 수
    minSimilarity     : 0.15,     // fallback 최소 유사도 (L3보다 낮게 설정)
    maxMorphemes      : 10,       // 쿼리에서 추출할 최대 형태소 수
    geminiTimeoutMs   : 60_000,   // 형태소 분리 LLM 타임아웃 (Gemini/Codex/Copilot CLI 공통)
    registerOnRemember: true      // remember() 시 형태소 자동 등록 여부
  }
};
