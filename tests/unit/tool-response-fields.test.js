/**
 * 도구 응답 필드 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
 *
 * remember, recall, context, reflect 핸들러가 클라이언트가 읽는 핵심 필드를 채우는지,
 * 오류 시 success=false 와 오류 정보를 내는지만 단언한다. 응답 전체의 키 집합이나 값은
 * 고정하지 않으므로 부가 필드가 늘어도 통과한다.
 *
 * 하위 계층은 대역으로 바꿔 DB와 Redis 상태에 흔들리지 않게 한다.
 */

import { test, describe, mock } from "node:test";
import assert                   from "node:assert/strict";

const FRAGMENT = {
  id        : "frag-0000000000000001",
  content   : "테스트 파편",
  type      : "fact",
  importance: 0.6,
  topic     : "test",
  keywords  : ["a", "b"],
  created_at: "2026-09-30T00:00:00.000Z",
  similarity: 0.8
};

/** 시험마다 동작을 바꿀 수 있도록 가변 대역으로 둔다. */
const manager = {
  remember: async () => ({ id: FRAGMENT.id, keywords: FRAGMENT.keywords, ttl_tier: "permanent", scope: "persistent", conflicts: [] }),
  recall  : async () => ({ fragments: [FRAGMENT], total: 1, _searchEventId: "se-1" }),
  context : async () => ({ core: [FRAGMENT], working: [], summary: "요약" }),
  reflect : async () => ({ stored: 1, episodeId: "frag-0000000000000002", links: [] })
};
const original = { ...manager };

mock.module("../../lib/memory/MemoryManager.js", {
  namedExports : { MemoryManager: { getInstance: () => manager } },
  defaultExport: { getInstance: () => manager }
});

/** 피드백 힌트 표집은 확률에 따라 `_meta`를 붙이므로 끈다. */
mock.module("../../lib/memory/signals/FeedbackSampler.js", {
  namedExports: {
    maybeFeedbackHint: async () => null,
    shouldSample     : () => false,
    buildFeedbackHint: () => null
  }
});

/** 파편 부가 로딩은 DB를 탄다. */
mock.module("../../lib/memory/read/LinkedFragmentLoader.js", {
  namedExports: { fetchLinkedFragments: async () => new Map() }
});
mock.module("../../lib/memory/read/StitchSourceLoader.js", {
  namedExports: { fetchCausalLinks: async () => new Map(), fetchSessionNeighbors: async () => new Map() }
});

const memory = await import("../../lib/tools/memory.js");

/** 각 시험 뒤에 대역을 원래 동작으로 되돌린다. */
function restoreManager() {
  Object.assign(manager, original);
}

describe("remember 응답", () => {
  test("success와 저장된 파편의 id, keywords, ttl_tier, scope를 담는다", async () => {
    const res = await memory.tool_remember({ content: "내용", topic: "test", type: "fact" });
    assert.equal(res.success, true);
    assert.equal(res.id, FRAGMENT.id);
    assert.deepEqual(res.keywords, FRAGMENT.keywords);
    assert.equal(typeof res.ttl_tier, "string");
    assert.equal(typeof res.scope, "string");
    assert.ok(Array.isArray(res.conflicts));
  });

  test("하위 계층 오류는 success=false와 오류 문구, 코드로 전달된다", async () => {
    manager.remember = async () => {
      const err = new Error("fragment limit exceeded");
      err.code = "fragment_limit_exceeded";
      throw err;
    };
    try {
      const res = await memory.tool_remember({ content: "내용", topic: "test", type: "fact" });
      assert.equal(res.success, false);
      assert.equal(res.error, "fragment limit exceeded");
      assert.equal(res.code, "fragment_limit_exceeded");
    } finally {
      restoreManager();
    }
  });

  test("정책 위반 예외는 응답으로 바꾸지 않고 그대로 전파한다", async () => {
    const violation = Object.assign(new Error("blocked"), { name: "SymbolicPolicyViolationError" });
    manager.remember = async () => { throw violation; };
    try {
      await assert.rejects(
        () => memory.tool_remember({ content: "내용", topic: "test", type: "fact" }),
        (err) => err === violation
      );
    } finally {
      restoreManager();
    }
  });
});

describe("recall 응답", () => {
  test("success, count, fragments 배열을 담고 각 파편이 id를 가진다", async () => {
    const res = await memory.tool_recall({ keywords: ["a"] });
    assert.equal(res.success, true);
    assert.equal(typeof res.count, "number");
    assert.ok(Array.isArray(res.fragments));
    assert.equal(res.fragments.length, res.count);
    assert.equal(res.fragments[0].id, FRAGMENT.id);
  });
});

describe("context 응답", () => {
  test("success, core 배열, working 배열, summary 문자열을 담는다", async () => {
    const res = await memory.tool_context({ tokenBudget: 500 });
    assert.equal(res.success, true);
    assert.ok(Array.isArray(res.core));
    assert.ok(Array.isArray(res.working));
    assert.equal(typeof res.summary, "string");
    assert.equal(res.core[0].id, FRAGMENT.id);
  });
});

describe("reflect 응답", () => {
  test("success, stored 수, episodeId, links 배열을 담는다", async () => {
    const res = await memory.tool_reflect({ summary: ["사실 하나"] });
    assert.equal(res.success, true);
    assert.equal(typeof res.stored, "number");
    assert.equal(typeof res.episodeId, "string");
    assert.ok(Array.isArray(res.links));
  });
});

describe("공통 규약", () => {
  test("모든 핵심 도구 응답이 success 불리언을 노출한다", async () => {
    const calls = [
      () => memory.tool_remember({ content: "내용", topic: "test", type: "fact" }),
      () => memory.tool_recall({ keywords: ["a"] }),
      () => memory.tool_context({ tokenBudget: 500 }),
      () => memory.tool_reflect({ summary: ["사실 하나"] })
    ];
    for (const call of calls) {
      assert.equal(typeof (await call()).success, "boolean");
    }
  });
});
