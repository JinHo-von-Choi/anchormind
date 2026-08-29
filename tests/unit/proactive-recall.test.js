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

import { describe, it, mock, after } from "node:test";
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
const _originalPushToQueue = (await import("../../lib/redis.js")).pushToQueue;

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

  it("불용어만 공유하는 파편은 오버랩 필터링으로 링크가 생성되지 않는다", async () => {
    const deps      = createMockDeps();
    const processor = new RememberPostProcessor(deps);

    deps.search.search = mock.fn(async () => ({
      fragments: [
        { id: "existing-stopword", content: "확인 작업 완료", keywords: ["확인", "작업", "완료"] }
      ]
    }));

    await processor.run(
      { id: "new-stopword", content: "확인 작업 완료", type: "fact", keywords: ["확인", "작업", "완료"] },
      { agentId: "test-agent", keyId: null }
    );

    if (processor._proactiveRecallPromise) {
      await processor._proactiveRecallPromise;
    }

    assert.equal(deps.store.createLink.mock.calls.length, 0,
      "불용어만 공유하면 필터링 후 오버랩이 0이 되어 링크가 생성되지 않아야 한다");
  });

  it("Rationale 접두 문자열은 오버랩 계산에서 제외되어 무관 파편끼리 링크되지 않는다", async () => {
    const deps      = createMockDeps();
    const processor = new RememberPostProcessor(deps);

    deps.search.search = mock.fn(async () => ({
      fragments: [
        {
          id: "existing-rationale",
          content: "무관한 내용",
          keywords: ["Rationale: 향후 참조 필요함", "unrelated"]
        }
      ]
    }));

    await processor.run(
      {
        id: "new-rationale", content: "다른 무관한 내용", type: "fact",
        keywords: ["Rationale: 향후 참조 필요함", "database"]
      },
      { agentId: "test-agent", keyId: null }
    );

    if (processor._proactiveRecallPromise) {
      await processor._proactiveRecallPromise;
    }

    assert.equal(deps.store.createLink.mock.calls.length, 0,
      "Rationale 접두 문자열만 공유하는 무관 파편은 링크되지 않아야 한다");
  });

  it("mode=legacy에서도 workspace가 서로 다르면 링크를 생성하지 않는다", async () => {
    const orig = MEMORY_CONFIG.proactiveRecall?.mode;
    MEMORY_CONFIG.proactiveRecall.mode = "legacy";

    try {
      const deps      = createMockDeps();
      const processor = new RememberPostProcessor(deps);

      deps.search.search = mock.fn(async () => ({
        fragments: [
          { id: "existing-ws-b", content: "deploy service", keywords: ["deploy", "service"], workspace: "proj-b" }
        ]
      }));

      await processor.run(
        { id: "new-ws-a", content: "deploy service", type: "fact", keywords: ["deploy", "service"], workspace: "proj-a" },
        { agentId: "test-agent", keyId: null }
      );

      if (processor._proactiveRecallPromise) {
        await processor._proactiveRecallPromise;
      }

      assert.equal(deps.store.createLink.mock.calls.length, 0,
        "legacy 모드에서도 workspace가 다르면 링크가 생성되지 않아야 한다");
    } finally {
      MEMORY_CONFIG.proactiveRecall.mode = orig;
    }
  });

  it("mode=legacy에서 workspace가 같으면 기존처럼 링크를 생성한다", async () => {
    const orig = MEMORY_CONFIG.proactiveRecall?.mode;
    MEMORY_CONFIG.proactiveRecall.mode = "legacy";

    try {
      const deps      = createMockDeps();
      const processor = new RememberPostProcessor(deps);

      deps.search.search = mock.fn(async () => ({
        fragments: [
          { id: "existing-ws-a2", content: "deploy service", keywords: ["deploy", "service"], workspace: "proj-a" }
        ]
      }));

      await processor.run(
        { id: "new-ws-a2", content: "deploy service", type: "fact", keywords: ["deploy", "service"], workspace: "proj-a" },
        { agentId: "test-agent", keyId: null }
      );

      if (processor._proactiveRecallPromise) {
        await processor._proactiveRecallPromise;
      }

      const call = deps.store.createLink.mock.calls.find(c =>
        c.arguments[0] === "new-ws-a2" && c.arguments[1] === "existing-ws-a2"
      );
      assert.ok(call, "동일 workspace면 legacy 모드에서 링크가 생성되어야 한다");
    } finally {
      MEMORY_CONFIG.proactiveRecall.mode = orig;
    }
  });
});
