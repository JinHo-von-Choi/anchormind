/**
 * ProactiveRecall 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 * 수정일: 2026-05-19
 *
 * RememberPostProcessor._proactiveRecall 기능 검증:
 *   - mode="legacy" 시 유사 파편 발견 시 related_to 링크 생성
 *   - 유사 파편 없으면 링크 생성 안 함
 *   - search 없이 생성하면 ProactiveRecall 스킵
 *
 * mode별 상세 게이트 시나리오는 proactive-recall-gate.test.js 참조.
 */

import { describe, it, mock, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { teardownTestResources } from "../_lifecycle.js";
import { MEMORY_CONFIG }         from "../../config/memory.js";

after(async () => { await teardownTestResources(); });

/* ── mock 의존성 생성 헬퍼 ── */

function createMockSearch(overrides = {}) {
  return {
    search: mock.fn(async () => ({ fragments: [] })),
    ...overrides,
  };
}

function createMockStore(overrides = {}) {
  return {
    createLink      : mock.fn(async () => undefined),
    searchByKeywords: mock.fn(async () => []),
    ...overrides,
  };
}

function createMockDeps(overrides = {}) {
  const store  = createMockStore(overrides.store);
  const search = overrides.search !== undefined ? overrides.search : createMockSearch(overrides.searchOverrides);

  return {
    store,
    conflictResolver: {
      checkAssertionConsistency: mock.fn(async () => ({ assertionStatus: "observed" })),
    },
    temporalLinker: {
      linkTemporalNeighbors: mock.fn(async () => undefined),
    },
    morphemeIndex: {
      tokenize              : mock.fn(async (t) => String(t).toLowerCase().split(/[\s,.]+/).filter(w => w.length > 1).slice(0, 10)),
      getOrRegisterEmbeddings: mock.fn(async () => undefined),
    },
    search,
  };
}

/**
 * RememberPostProcessor를 동적 import한다.
 * pushToQueue 의존성을 mock하기 위해 모듈 레벨에서 처리.
 */
let RememberPostProcessor;

/* pushToQueue를 no-op로 대체 */
const originalPushToQueue = (await import("../../lib/redis.js")).pushToQueue;

describe("RememberPostProcessor -- ProactiveRecall", async () => {
  /* RememberPostProcessor를 로드 */
  const mod = await import("../../lib/memory/write/RememberPostProcessor.js");
  RememberPostProcessor = mod.RememberPostProcessor;

  it("mode=legacy 시 유사 파편 발견 시 related_to 링크 생성", async () => {
    // mode=legacy에서는 workspace/caseId 무관하게 50% 오버랩이면 링크 생성
    const orig    = MEMORY_CONFIG.proactiveRecall?.mode;
    MEMORY_CONFIG.proactiveRecall.mode = "legacy";

    try {
      const deps      = createMockDeps();
      const processor = new RememberPostProcessor(deps);

      deps.search.search = mock.fn(async () => ({
        fragments: [
          { id: "existing-1", content: "cpu 사용률 높음 성능 문제", keywords: ["cpu", "성능"] }
        ]
      }));

      await processor.run(
        { id: "new-1", content: "cpu 사용률 급등으로 인한 성능 저하", type: "error", keywords: ["cpu", "성능"] },
        { agentId: "test-agent", keyId: null }
      );

      /** fire-and-forget Promise 추적 -- setTimeout 대신 안정적 대기 */
      if (processor._proactiveRecallPromise) {
        await processor._proactiveRecallPromise;
      }

      assert.equal(deps.store.createLink.mock.calls.length >= 1, true,
        "createLink가 최소 1회 호출되어야 한다");

      const call = deps.store.createLink.mock.calls.find(c =>
        c.arguments[0] === "new-1" && c.arguments[1] === "existing-1"
      );
      assert.ok(call, "new-1 → existing-1 링크가 생성되어야 한다");
      assert.equal(call.arguments[2], "related");
      assert.equal(call.arguments[3], "test-agent");
    } finally {
      MEMORY_CONFIG.proactiveRecall.mode = orig;
    }
  });

  it("유사 파편 없으면 링크 생성 안 함", async () => {
    const deps      = createMockDeps();
    const processor = new RememberPostProcessor(deps);

    deps.search.search = mock.fn(async () => ({ fragments: [] }));

    await processor.run(
      { id: "new-2", content: "완전히 다른 내용", type: "fact", keywords: ["기타"] },
      { agentId: "test-agent", keyId: null }
    );

    if (processor._proactiveRecallPromise) {
      await processor._proactiveRecallPromise;
    }

    assert.equal(deps.store.createLink.mock.calls.length, 0,
      "유사 파편이 없으면 createLink가 호출되지 않아야 한다");
  });

  it("search 없이 생성하면 ProactiveRecall 스킵", async () => {
    const deps = createMockDeps({ search: null });
    const processor = new RememberPostProcessor(deps);

    /** 에러 없이 정상 완료되어야 한다 */
    await processor.run(
      { id: "new-3", content: "test", type: "fact", keywords: [] },
      { agentId: "agent", keyId: null }
    );

    if (processor._proactiveRecallPromise) {
      await processor._proactiveRecallPromise;
    }

    assert.equal(deps.store.createLink.mock.calls.length, 0,
      "search가 없으면 createLink가 호출되지 않아야 한다");
  });
});
