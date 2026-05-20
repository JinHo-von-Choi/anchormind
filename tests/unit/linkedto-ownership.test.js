/**
 * RememberPostProcessor — linkedTo 소유권 검증 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-10
 *
 * 검증 범위:
 *   - 자신이 소유한 id만 링크 생성
 *   - 타 테넌트 id는 링크 미생성 + 경고 로그
 *   - 소유 검증 실패(예외) 시 링크 생략
 */

import { describe, it, mock, after } from "node:test";
import assert from "node:assert/strict";

import { teardownTestResources } from "../_lifecycle.js";

after(async () => { await teardownTestResources(); });

/** RememberPostProcessor 로드 */
const { RememberPostProcessor } = await import("../../lib/memory/RememberPostProcessor.js");

/** 공통 mock 생성 헬퍼 */
function createDeps(getByIdsImpl) {
  return {
    store: {
      createLink      : mock.fn(async () => undefined),
      getByIds        : mock.fn(getByIdsImpl),
      searchByKeywords: mock.fn(async () => []),
    },
    conflictResolver: {
      checkAssertionConsistency: mock.fn(async () => ({ assertionStatus: "observed" })),
    },
    temporalLinker: {
      linkTemporalNeighbors: mock.fn(async () => undefined),
    },
    morphemeIndex: {
      tokenize               : mock.fn(async () => []),
      getOrRegisterEmbeddings: mock.fn(async () => undefined),
    },
    search: null,
  };
}

describe("RememberPostProcessor -- linkedTo 소유권 검증", async () => {

  it("소유한 id만 링크를 생성한다", async () => {
    /** owned-1은 소유, other-tenant는 타 테넌트 → 필터됨 */
    const deps = createDeps(async (ids) =>
      ids.filter(id => id === "owned-1").map(id => ({ id }))
    );

    const processor = new RememberPostProcessor(deps);
    await processor.run(
      {
        id       : "new-frag",
        content  : "테스트",
        type     : "fact",
        linked_to: ["owned-1", "other-tenant"],
      },
      { agentId: "agent-A", keyId: "key-A" }
    );

    const created = deps.store.createLink.mock.calls.map(c => c.arguments[1]);
    assert.ok(created.includes("owned-1"),      "소유한 owned-1은 링크 생성되어야 한다");
    assert.ok(!created.includes("other-tenant"), "타 테넌트 other-tenant는 링크 생성 안 된다");
  });

  it("소유한 id가 없으면 createLink를 호출하지 않는다", async () => {
    const deps = createDeps(async () => []);

    const processor = new RememberPostProcessor(deps);
    await processor.run(
      {
        id       : "new-frag-2",
        content  : "테스트",
        type     : "fact",
        linked_to: ["foreign-1", "foreign-2"],
      },
      { agentId: "agent-B", keyId: "key-B" }
    );

    assert.equal(deps.store.createLink.mock.calls.length, 0,
      "소유한 id가 없으면 createLink는 0회여야 한다");
  });

  it("linked_to가 없으면 소유권 검증을 건너뛴다", async () => {
    const deps = createDeps(async () => { throw new Error("should not be called"); });

    const processor = new RememberPostProcessor(deps);
    await assert.doesNotReject(
      () => processor.run(
        { id: "new-frag-3", content: "테스트", type: "fact" },
        { agentId: "agent-C", keyId: "key-C" }
      ),
      "linked_to 없으면 getByIds 호출 없이 정상 완료"
    );

    assert.equal(deps.store.getByIds.mock.calls.length, 0);
  });

  it("getByIds 예외 시 링크 생성을 건너뛴다", async () => {
    const deps = createDeps(async () => { throw new Error("DB 오류"); });

    const processor = new RememberPostProcessor(deps);
    await processor.run(
      {
        id       : "new-frag-4",
        content  : "테스트",
        type     : "fact",
        linked_to: ["some-id"],
      },
      { agentId: "agent-D", keyId: "key-D" }
    );

    assert.equal(deps.store.createLink.mock.calls.length, 0,
      "getByIds 예외 시 createLink는 호출되지 않아야 한다");
  });
});
