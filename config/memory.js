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
    l2WeightFactor   : 1.0,   // L2(PostgreSQL keyword/topic) 기본 가중치
    l3WeightFactor   : 1.0,   // L3(pgvector semantic) 기본 가중치
    graphWeightFactor: 1.5,   // L2.5 그래프 이웃 가중치 배수
    mixed: {
      l1WeightFactor   : 2.5, // text + structured query는 명시 키워드 신호를 우선한다
      l2WeightFactor   : 1.7,
      l3WeightFactor   : 0.6,
      graphWeightFactor: 1.5
    }
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
  /** 시맨틱 검색 설정 */
  semanticSearch: {
    minSimilarity     : 0.35,
    limit             : 30,
    timeoutMs         : 5000,
    statementTimeoutMs: 4500,
    hnswEfSearch      : 80
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
  /** consolidate 주기 (ms) */
  consolidateIntervalMs: Number(process.env.CONSOLIDATE_INTERVAL_MS || 3600000),
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
