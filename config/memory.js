/**
 * 기억 시스템 설정
 *
 * 작성자: 최진호
 * 작성일: 2026-02-25
 * 수정일: 2026-05-22 (morphemeIndex kanaMinChars, enableKuromoji 추가)
 */

/**
 * 환경 변수를 정수로 파싱한다. 파싱 실패 시 기본값, 성공 시 min~max 클램프.
 */
function envInt(name, def, min, max) {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  if (Number.isNaN(raw)) return def;
  return Math.min(max, Math.max(min, raw));
}

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
    /** keywords-only 정확 일치 가산. semantic 최대 기여(semanticWeight)보다 크게 잡아
     *  유사도 분포가 극단적인 임베딩 환경에서도 정확 히트의 우위를 보장한다. */
    exactKeywordBoost: 0.35,
    /** 절단 슬롯 보장: exact 히트는 budget의 exactSlotShare까지, L3kw supplement는
     *  semanticSlotShare까지 우선 확보한다(둘 다 무제한 아님 — 일반 키워드 독점 방지). */
    exactSlotShare: 0.5,
    semanticSlotShare: 0.25,
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
    k                     : 60,    // RRF 상수 (높을수록 상위 랭크 부스트 감소)
    l1WeightFactor        : 2.0,   // L1(Redis) 결과 가중치 배수
    graphWeightFactor     : 1.5,   // L2.5 그래프 이웃 가중치 배수
    candidateMinImportance: 0.1    // RRF 후보 저중요도 컷오프 하한 (비-앵커)
  },
  /**
   * 질의 의도별 검색 프로파일.
   *
   * classifyQueryIntent가 판정한 의도에 따라 RRF 레이어 가중, 시맨틱 임계값,
   * 형태소 프로브 채택 조건, 랭킹 lexical 가중치를 한 번에 전환한다.
   * ranking의 importanceWeight/recencyWeight/semanticWeight는 합계 1.0 제약이
   * 걸려 있어 프로파일 조정 대상이 아니다.
   * MEMENTO_QUERY_PROFILE_ENABLED=false로 전체 비활성화할 수 있다.
   */
  queryProfiles: {
    enabled: true,
    /** 코드 식별자·경로·수치 중심 질의: 키워드 경로와 정확 일치 신호를 키운다. */
    EXACT_SYMBOL: {
      l2WeightFactor           : 1.6,
      l3WeightFactor           : 0.9,
      minSimilarityDelta       : 0.0,
      morphemeFallbackThreshold: 5,
      exactKeywordBoost        : 0.45,
      lexicalWeightReranked    : 0.18,
      lexicalWeightFallback    : 0.26,
    },
    /** 개념·원인·절차 질의: 벡터 경로를 키우고 임계값을 낮춰 후보 진입을 넓힌다.
     *  text-embedding-3-small 실측에서 한국어 패러프레이즈 쌍 코사인이 0.26 부근이라
     *  기본 임계값 0.40으로는 정답이 후보에 들어오지 못한다. */
    CONCEPT_INTENT: {
      l2WeightFactor           : 0.9,
      l3WeightFactor           : 1.5,
      minSimilarityDelta       : -0.20,
      morphemeFallbackThreshold: 12,
      exactKeywordBoost        : 0.25,
      lexicalWeightReranked    : 0.08,
      lexicalWeightFallback    : 0.12,
    },
    /** 혼재·판정 불가 질의: 임계값만 소폭 완화하고 나머지는 기본값을 유지한다. */
    HYBRID: {
      l2WeightFactor           : 1.0,
      l3WeightFactor           : 1.1,
      minSimilarityDelta       : -0.06,
      morphemeFallbackThreshold: 8,
    },
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
  /**
   * 합성 역질의 증강.
   *
   * 파편 저장 시 회상 시점에 던져질 만한 질문을 LLM으로 생성해 보조 벡터로 색인한다.
   * 저장 표기와 회상 표기가 어긋나는 경우(영문 기술용어 저장 대 한국어 질의)를 겨냥한다.
   *
   * 파편당 LLM 1회와 임베딩 2~3회가 추가되므로 기본값은 비활성이다.
   * MEMENTO_SYNTHETIC_QUERY_ENABLED=true로 생성을 켜고, MEMENTO_SYNTHETIC_QUERY_SEARCH로
   * 검색 반영을 끌 수 있다. 생성을 꺼도 이미 쌓인 보조 벡터는 검색에 쓰인다.
   * 생성을 기본 활성으로 두면 업그레이드만으로 LLM 호출 비용이 발생하므로 옵트인으로 둔다.
   */
  syntheticQuery: {
    enabled          : process.env.MEMENTO_SYNTHETIC_QUERY_ENABLED === "true",
    searchEnabled    : process.env.MEMENTO_SYNTHETIC_QUERY_SEARCH  !== "false",
    /** 적용 대상 제한. 이득이 확인되기 전에 넓히면 비용이 먼저 늘어난다. */
    minImportance    : Number(process.env.MEMENTO_SYNTHETIC_QUERY_MIN_IMPORTANCE || 0.8),
    types            : (process.env.MEMENTO_SYNTHETIC_QUERY_TYPES || "error,procedure,decision")
                         .split(",").map(t => t.trim()).filter(Boolean),
    /** 생성 개수와 길이 상한 */
    minQueries       : 2,
    maxQueries       : 3,
    maxQueryChars    : 120,
    /** 전용 큐. 임베딩 큐와 분리해 폭주가 서로 전파되지 않게 한다. */
    queueKey         : "memento:synthetic_query_queue",
    intervalMs       : Number(process.env.MEMENTO_SYNTHETIC_QUERY_INTERVAL_MS || 5000),
    batchSize        : Number(process.env.MEMENTO_SYNTHETIC_QUERY_BATCH || 5),
    retryLimit       : 3,
    llmTimeoutMs     : Number(process.env.MEMENTO_SYNTHETIC_QUERY_TIMEOUT_MS || 20000),
    /** 분당 LLM 호출 상한. 0이면 무제한 */
    maxCallsPerMinute: Number(process.env.MEMENTO_SYNTHETIC_QUERY_RPM || 20),
    /** 보조 벡터 히트의 유사도 감쇠 계수. 본문 히트와 같은 무게로 다루지 않는다. */
    similarityDecay  : 0.85,
    /** 보조 벡터 검색 상한 */
    searchLimit      : 10,
    /** 한 검색에서 보조 경로로 합류시킬 최대 파편 수.
     *  프로브는 본 검색과 병렬로 실행되므로 조회 비용은 지연에 거의 영향이 없지만,
     *  무제한 합류시키면 본문 정확 일치가 후보 경쟁에서 밀린다. */
    adoptLimit       : Number(process.env.MEMENTO_SYNTHETIC_QUERY_ADOPT || 5),
    /** 백필 수집기가 한 번에 처리할 미생성 파편 수 */
    backfillBatch    : Number(process.env.MEMENTO_SYNTHETIC_QUERY_BACKFILL || 20),
  },
  /** 임베딩 비동기 워커 설정 */
  embeddingWorker: {
    batchSize   : 10,
    intervalMs  : 5000,
    retryLimit  : 3,
    retryDelayMs: 2000,
    queueKey    : "memento:embedding_queue"
  },
  /** batch_remember 비동기 워커 설정 */
  batchRememberWorker: {
    intervalMs : 1000,
    retryLimit : 3,
    queueKey   : "memento:batch_remember_queue"
  },
  /** 컨텍스트 주입 설정 */
  contextInjection: {
    maxAnchorFragments : envInt("MEMENTO_CONTEXT_ANCHOR_LIMIT", 10, 1, 30),
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
    maxImportance    : 0.55,
    keepPerType      : 5,
    maxDeletePerCycle: 30
  },
  /** 시맨틱 검색 설정. minSimilarity는 SearchParamAdaptor가 적응형으로 조정한다.
   *  0.40: 12쿼리 골드셋 실측에서 상위5 유용건 최대(0.5는 자유 회상 질의 침묵, 0.35는 노이즈가 이득 상쇄). */
  semanticSearch: {
    minSimilarity  : 0.4,
    limit          : 30,
    /** text 없는 keywords-only 쿼리에서 L3 시맨틱 보조 실행 여부.
     *  L1/L2는 저장 keywords 배열만 보므로 content 매칭은 이 경로가 유일하다. */
    keywordFallback: process.env.MEMENTO_KEYWORD_SEMANTIC_FALLBACK !== "false",
    /** keywords 보조 L3 실행 상한(ms). 초과 시 빈 배열로 대체해 응답 지연을 차단한다. */
    keywordFallbackTimeoutMs: envInt("MEMENTO_KEYWORD_FALLBACK_TIMEOUT_MS", 1500, 100, 60000)
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
    },
    splitChildPolicy: {
      maxImportance     : 0.3, // split 자식이 이 importance 미만이면 GC 후보 (branch 1)
      orphanAgeDays     : 30,  // 생성 후 이 일수 경과 + 무접근 시 삭제 (branch 1)
      tombstonedGraceDays: 7   // 부모가 tombstone된 split 자식의 유예 일수 (branch 2)
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
     * 파괴 단계 안전 게이트.
     *
     * 시맨틱 중복 제거가 병합을 수행하기 전에 판정한다. 코사인 유사도는 수치나
     * 식별자만 다른 문장을 구분하지 못하므로(max_connections 200과 500은 0.99 이상),
     * 제거 대상의 변별 토큰이 승계자에 남는지 확인한 뒤에만 병합을 허용한다.
     * enabled=false로 두면 게이트 없이 기존 동작으로 되돌아간다.
     */
    gate: {
      enabled      : true,
      maxLostTokens: 0,
    },
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
    minItems         : 2,     // LLM이 최소 이 수 이상 항목으로 분리해야 원본 대체
    maxItems         : 8,     // LLM에 요청할 최대 분리 항목 수
    timeoutMs        : 30_000, // 파편당 LLM 타임아웃
    minChildLength     : 20,   // 이 길이 미만 자식 단편은 폐기
    excludeMetaTopics  : ["session_reflect", "consolidation", "reflection"], // 분할 제외 메타 토픽
    failureBackoffHours: 24,   // 분할 실패 후 이 시간 동안 재선정 제외 (무한 재분할 차단)
    /** 부모의 주어 앵커를 하나도 담지 못한 자식을 폐기 */
    requireSubjectAnchor    : (process.env.MEMENTO_SPLIT_SUBJECT_GATE  ?? "true") === "true",
    /** 부모에 없던 양상(예정·추측·의무·의도)을 도입한 자식을 폐기 */
    rejectIntroducedModality: (process.env.MEMENTO_SPLIT_MODALITY_GATE ?? "true") === "true",
    subjectAnchorMax        : 12  // 부모 원문에서 뽑을 주어 앵커 상한
  },
  /** 피드백 계측 설정 */
  feedback: {
    /**
     * 쓰기 계열 도구 응답에 tool_feedback 요청 힌트를 확률적으로 동봉한다.
     * recall은 자체 힌트 경로를 이미 갖고 있어 rates에서 제외한다.
     */
    sampling: {
      enabled           : (process.env.MEMENTO_FEEDBACK_SAMPLING ?? "true") === "true",
      rates             : {
        remember: 0.10,
        amend   : 0.25,
        forget  : 0.25
      },
      maxHintsPerSession: 2,    // 세션당 힌트 상한. 초과 시 무음
      cooldownSeconds   : 900   // 직전 힌트 이후 이 시간 동안 재발행 금지
    }
  },
  /** 형태소 사전 및 L3 fallback 설정 */
  morphemeIndex: {
    fallbackThreshold : 5,        // L3 결과가 이 수 이하일 때 형태소 fallback 실행
    fallbackLimit     : 5,        // fallback 최대 반환 파편 수
    minSimilarity     : 0.15,     // fallback 최소 유사도 (L3보다 낮게 설정)
    maxMorphemes      : 10,       // 쿼리에서 추출할 최대 형태소 수
    geminiTimeoutMs   : 60_000,   // 형태소 분리 LLM 타임아웃 (Gemini/Codex/Copilot CLI 공통)
    registerOnRemember: true,     // remember() 시 형태소 자동 등록 여부
    tokenizer         : process.env.MEMENTO_MORPHEME_TOKENIZER || "local", // "local" | "llm"
    /** 가나 런 최소 길이 — 미만이면 kuromoji 로드 없이 문자 분리 */
    kanaMinChars      : 2,
    /** false이면 kuromoji를 절대 로드하지 않는다 (+269MB 상주 방지) */
    enableKuromoji    : process.env.MEMENTO_ENABLE_KUROMOJI !== "false"
  },
  /**
   * workspace 스코프 랭킹 감쇠.
   * 검색 scope에 workspace가 지정됐을 때, workspace 불일치·NULL(전역) 파편의
   * 랭킹 점수에 penalty 배율을 곱한다. 반환 자체는 유지한다.
   */
  workspaceDecay: {
    enabled : process.env.MEMENTO_WORKSPACE_DECAY !== "false",
    penalty : parseFloat(process.env.MEMENTO_WORKSPACE_DECAY_PENALTY ?? "0.7")
  },
  /**
   * 세션 세그먼트. 전송계층 세션 ID를 파편에 직접 쓰지 않고
   * 유휴·수명 기준으로 회전하는 파생 ID({원본}#{seq})를 주입한다.
   */
  sessionSegment: {
    enabled  : process.env.MEMENTO_SESSION_SEGMENT !== "false",
    idleMs   : Number(process.env.MEMENTO_SEGMENT_IDLE_MS    || 2_700_000),
    maxAgeMs : Number(process.env.MEMENTO_SEGMENT_MAX_AGE_MS || 43_200_000),
    /** AutoReflect 발동에 필요한 세그먼트당 최소 활동(파편+도구 호출) 수 */
    minActivityForReflect: Number(process.env.MEMENTO_SEGMENT_MIN_ACTIVITY || 3)
  }
};
