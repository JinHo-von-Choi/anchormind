/**
 * RememberPostProcessor Phase 1 symbolic claim extraction 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * 검증 대상 (8단계 hook):
 *  1. SYMBOLIC_CONFIG.enabled=false → _extractSymbolicClaims 호출 안 됨
 *  2. enabled=true + claimExtraction=false → 호출 안 됨
 *  3. 둘 다 true → ClaimExtractor.extract 및 ClaimStore.insert 가 호출됨
 *  4. ClaimStore 가 TENANT_ISOLATION_VIOLATION throw → remember 실패 아님 + recordGateBlock 증가
 *  5. ClaimStore 가 일반 에러 throw → remember 실패 아님
 *
 * 원칙:
 *  - 외부 의존성 (redis, EmbeddingWorker, MorphemeIndex 등) 은 mock.module 로 차단
 *  - symbolic 관련 주입은 constructor 의 claimExtractor / claimStore 옵션 사용
 *  - config/symbolic.js 는 node:test mock.module 로 플래그 조합 제어
 */

import { test, describe, beforeEach, afterEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { teardownTestResources } from "../../_lifecycle.js";

/* ------------------------------------------------------------------ */
/*  Module mocks (must be registered before dynamic import)            */
/* ------------------------------------------------------------------ */

/** redis 큐 push 를 no-op 으로 */
mock.module("../../../lib/redis.js", {
  namedExports: {
    pushToQueue       : mock.fn(async () => {}),
    pushToQueuePriority: mock.fn(async () => {}),
    redisClient       : null,
    cacheDocument     : mock.fn(async () => {}),
    getCachedDocument : mock.fn(async () => null),
  }
});

/** EmbeddingWorker 를 no-op 으로 */
mock.module("../../../lib/memory/embedding/EmbeddingWorker.js", {
  namedExports: {
    EmbeddingWorker: class {
      async processOrphanFragments() { return 0; }
    }
  }
});

/** logger 는 side-effect 억제 */
mock.module("../../../lib/logger.js", {
  namedExports: {
    logWarn : mock.fn(),
    logInfo : mock.fn(),
    logError: mock.fn(),
  }
});

/** MEMORY_CONFIG 최소 스텁 */
mock.module("../../../config/memory.js", {
  namedExports: {
    MEMORY_CONFIG: {
      embeddingWorker: { queueKey: "test_embedding_queue" }
    }
  }
});

/**
 * config/symbolic.js — 테스트에서 SYMBOLIC_CONFIG 를 덮어쓸 수 있도록 mutable holder 로 export.
 * Object.freeze 는 프로덕션 파일에 한정되고, 여기서는 mock 이므로 mutation 허용.
 */
const symbolicHolder = {
  SYMBOLIC_CONFIG: {
    enabled         : false,
    claimExtraction : false,
    explain         : false,
    linkCheck       : false,
    polarityConflict: false,
    policyRules     : false,
    cbrFilter       : false,
    proactiveGate   : false,
    shadow          : false,
    ruleVersion     : "v1",
    timeoutMs       : 50,
    maxCandidates   : 32,
  }
};
mock.module("../../../config/symbolic.js", {
  namedExports: symbolicHolder
});

after(async () => { await teardownTestResources(); });

/** ClaimExtractor 실제 구현을 static mock 으로 대체 */
const extractFn = mock.fn(async () => ([{
  subject    : "redis",
  predicate  : "사용",
  object     : "cache",
  polarity   : "positive",
  confidence : 0.75,
  extractor  : "morpheme-rule",
  ruleVersion: "v1",
}]));

class MockClaimExtractor {
  constructor() { this.extract = extractFn; }
}
mock.module("../../../lib/symbolic/ClaimExtractor.js", {
  namedExports: { ClaimExtractor: MockClaimExtractor }
});

/** ClaimStore mock — insertFn 은 테스트마다 교체 */
const insertFn = mock.fn(async () => 1);
class MockClaimStore {
  constructor() { this.insert = insertFn; }
}
const TENANT_ISOLATION_VIOLATION = "TENANT_ISOLATION_VIOLATION";
mock.module("../../../lib/symbolic/ClaimStore.js", {
  namedExports: {
    ClaimStore: MockClaimStore,
    TENANT_ISOLATION_VIOLATION,
  }
});

/** SymbolicMetrics mock */
const metricsCalls = {
  recordClaim    : [],
  recordGateBlock: [],
  observeLatency : [],
};
mock.module("../../../lib/symbolic/SymbolicMetrics.js", {
  namedExports: {
    symbolicMetrics: {
      recordClaim    : (extractor, polarity) => metricsCalls.recordClaim.push({ extractor, polarity }),
      recordGateBlock: (phase, reason)       => metricsCalls.recordGateBlock.push({ phase, reason }),
      recordWarning  : () => {},
      observeLatency : (op, ms)              => metricsCalls.observeLatency.push({ op, ms }),
    }
  }
});

/* ------------------------------------------------------------------ */
/*  Import after mocks                                                 */
/* ------------------------------------------------------------------ */

const { RememberPostProcessor } = await import("../../../lib/memory/write/RememberPostProcessor.js");

/* ------------------------------------------------------------------ */
/*  Test fixtures                                                      */
/* ------------------------------------------------------------------ */

const makeDeps = () => ({
  store: {
    getByIds        : async () => [],
    createLink      : async () => {},
    patchAssertion  : async () => {},
    incrementAccess : () => {},
    touchLinked     : async () => {},
  },
  conflictResolver: {
    checkAssertionConsistency: async () => ({ assertionStatus: "observed" }),
  },
  temporalLinker: {
    linkTemporalNeighbors: async () => {},
  },
  morphemeIndex: {
    tokenize                : async (t) => String(t).toLowerCase().split(/[\s,.]+/).filter(w => w.length > 1).slice(0, 10),
    getOrRegisterEmbeddings : async () => [],
  },
  search: null,
});

const makeFragment = (over = {}) => ({
  id        : "frag-1",
  content   : "Redis 는 캐시로 사용한다",
  type      : "fact",
  topic     : "infra",
  linked_to : [],
  key_id    : null,
  ...over
});

const waitForPromise = async (p) => { if (p) { try { await p; } catch { /* swallow */ } } };

const resetMocks = () => {
  extractFn.mock.resetCalls();
  insertFn.mock.resetCalls();
  metricsCalls.recordClaim.length     = 0;
  metricsCalls.recordGateBlock.length = 0;
  metricsCalls.observeLatency.length  = 0;
  // default insert: success
  insertFn.mock.mockImplementation(async () => 1);
};

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("RememberPostProcessor — Phase 1 symbolic claim extraction hook", () => {

  beforeEach(() => resetMocks());

  test("SYMBOLIC_CONFIG.enabled=false → _extractSymbolicClaims 호출 안 됨", async () => {
    symbolicHolder.SYMBOLIC_CONFIG.enabled         = false;
    symbolicHolder.SYMBOLIC_CONFIG.claimExtraction = true;

    const processor = new RememberPostProcessor(makeDeps());
    await processor.run(makeFragment(), { agentId: "a", keyId: null });
    await waitForPromise(processor._symbolicClaimPromise);

    assert.equal(extractFn.mock.callCount(), 0);
    assert.equal(insertFn.mock.callCount(),  0);
  });

  test("enabled=true + claimExtraction=false → 호출 안 됨", async () => {
    symbolicHolder.SYMBOLIC_CONFIG.enabled         = true;
    symbolicHolder.SYMBOLIC_CONFIG.claimExtraction = false;

    const processor = new RememberPostProcessor(makeDeps());
    await processor.run(makeFragment(), { agentId: "a", keyId: null });
    await waitForPromise(processor._symbolicClaimPromise);

    assert.equal(extractFn.mock.callCount(), 0);
    assert.equal(insertFn.mock.callCount(),  0);
  });

  test("enabled+claimExtraction=true → ClaimExtractor + ClaimStore 호출 + recordClaim 증가", async () => {
    symbolicHolder.SYMBOLIC_CONFIG.enabled         = true;
    symbolicHolder.SYMBOLIC_CONFIG.claimExtraction = true;

    const processor = new RememberPostProcessor(makeDeps());
    await processor.run(makeFragment(), { agentId: "a", keyId: null });
    await waitForPromise(processor._symbolicClaimPromise);

    assert.equal(extractFn.mock.callCount(), 1, "extract called once");
    assert.equal(insertFn.mock.callCount(),  1, "insert called once");
    assert.equal(metricsCalls.recordClaim.length, 1);
    assert.deepEqual(metricsCalls.recordClaim[0], { extractor: "morpheme-rule", polarity: "positive" });
    assert.equal(metricsCalls.observeLatency.length, 1);
    assert.equal(metricsCalls.observeLatency[0].op, "claim_extraction");
  });

  test("ClaimStore.insert 가 TENANT_ISOLATION_VIOLATION throw → run() 은 실패하지 않고 recordGateBlock 증가", async () => {
    symbolicHolder.SYMBOLIC_CONFIG.enabled         = true;
    symbolicHolder.SYMBOLIC_CONFIG.claimExtraction = true;

    insertFn.mock.mockImplementation(async () => { throw new Error(TENANT_ISOLATION_VIOLATION); });

    const processor = new RememberPostProcessor(makeDeps());
    await processor.run(makeFragment(), { agentId: "a", keyId: null });
    await waitForPromise(processor._symbolicClaimPromise);

    assert.equal(metricsCalls.recordGateBlock.length, 1);
    assert.deepEqual(metricsCalls.recordGateBlock[0], { phase: "claim_extraction", reason: "tenant_violation" });
    assert.equal(metricsCalls.recordClaim.length, 0, "tenant violation 시 recordClaim 증가하지 않음");
  });

  test("ClaimStore.insert 가 일반 에러 throw → run() 은 실패 없음, recordGateBlock 증가 안 함", async () => {
    symbolicHolder.SYMBOLIC_CONFIG.enabled         = true;
    symbolicHolder.SYMBOLIC_CONFIG.claimExtraction = true;

    insertFn.mock.mockImplementation(async () => { throw new Error("db connection refused"); });

    const processor = new RememberPostProcessor(makeDeps());
    await assert.doesNotReject(async () => {
      await processor.run(makeFragment(), { agentId: "a", keyId: null });
      await waitForPromise(processor._symbolicClaimPromise);
    });

    assert.equal(metricsCalls.recordGateBlock.length, 0);
    assert.equal(metricsCalls.observeLatency.length, 1, "latency 는 finally 경로에서 관측");
  });

  test("ClaimExtractor.extract 가 빈 배열 반환 → ClaimStore.insert 호출 없음", async () => {
    symbolicHolder.SYMBOLIC_CONFIG.enabled         = true;
    symbolicHolder.SYMBOLIC_CONFIG.claimExtraction = true;

    extractFn.mock.mockImplementationOnce(async () => []);

    const processor = new RememberPostProcessor(makeDeps());
    await processor.run(makeFragment(), { agentId: "a", keyId: null });
    await waitForPromise(processor._symbolicClaimPromise);

    assert.equal(extractFn.mock.callCount(), 1);
    assert.equal(insertFn.mock.callCount(),  0);
    assert.equal(metricsCalls.recordClaim.length, 0);
    assert.equal(metricsCalls.observeLatency.length, 1);
  });
});
