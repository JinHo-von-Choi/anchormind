/**
 * 응답 형태 스냅샷 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * recall, context, remember, reflect 4종 응답의 최상위 키 집합과 각 키의 타입을
 * 고정한다. 값은 보지 않는다. 리팩토링으로 내부 구조가 바뀌어도 클라이언트가
 * 보는 표면은 그대로여야 하며, 그 판정을 사람의 기억이 아니라 이 시험이 한다.
 *
 * 하위 계층은 전부 대역으로 바꾼다. DB나 Redis 상태에 따라 결과가 흔들리면
 * 계약 시험으로 쓸 수 없기 때문이다.
 *
 * 의도적인 표면 변경 시 SNAPSHOT_UPDATE=1 로 갱신하고 사유를 CHANGELOG에 남긴다.
 */

import { test, describe, mock } from "node:test";
import assert                   from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath }        from "node:url";
import path                     from "node:path";

const HERE          = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(HERE, "..", "fixtures", "response-shape.snapshot.json");

/** 하위 계층이 돌려주는 최소 형태. 각 도구가 이 위에 응답을 조립한다. */
const FAKE_FRAGMENT = {
  id        : "frag-0000000000000001",
  content   : "테스트 파편",
  type      : "fact",
  importance: 0.6,
  topic     : "test",
  keywords  : ["a", "b"],
  created_at: "2026-08-28T00:00:00.000Z",
  similarity: 0.8
};

const managerStub = {
  remember: async () => ({ id: FAKE_FRAGMENT.id, keywords: FAKE_FRAGMENT.keywords, ttl_tier: "permanent", scope: "persistent", conflicts: [] }),
  recall  : async () => ({ fragments: [FAKE_FRAGMENT], total: 1, _searchEventId: "se-1" }),
  context : async () => ({ core: [FAKE_FRAGMENT], working: [], summary: "요약" }),
  reflect : async () => ({ stored: 1, episodeId: "frag-0000000000000002", links: [] })
};

mock.module("../../lib/memory/MemoryManager.js", {
  namedExports: { MemoryManager: { getInstance: () => managerStub } },
  defaultExport: { getInstance: () => managerStub }
});

/**
 * 피드백 힌트 표집은 Math.random을 쓴다. 표집이 걸린 호출에만 `_meta`가 붙으므로
 * 막지 않으면 같은 코드가 회차에 따라 다른 키 집합을 낸다. 계약 시험이 확률에
 * 흔들리면 회귀와 잡음을 구분할 수 없다.
 */
mock.module("../../lib/memory/signals/FeedbackSampler.js", {
  namedExports: {
    maybeFeedbackHint: async () => null,
    shouldSample     : () => false,
    buildFeedbackHint: () => null
  }
});

/** 파편 부가 로딩은 DB를 탄다. 계약 시험이 DB 상태에 흔들리지 않도록 대역으로 막는다. */
mock.module("../../lib/memory/read/LinkedFragmentLoader.js", {
  namedExports: { fetchLinkedFragments: async () => new Map() }
});
mock.module("../../lib/memory/read/StitchSourceLoader.js", {
  namedExports: { fetchCausalLinks: async () => new Map(), fetchSessionNeighbors: async () => new Map() }
});

const memory = await import("../../lib/tools/memory.js");

/**
 * 응답 객체를 키 이름과 타입의 쌍으로 환원한다.
 * 배열은 원소 타입까지만 본다. 값과 길이는 계약이 아니다.
 *
 * @param {Object} obj
 * @returns {Object<string, string>}
 */
export function shapeOf(obj) {
  if (obj === null || typeof obj !== "object") return typeof obj;
  const out = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (Array.isArray(v))                out[key] = v.length > 0 ? `array<${shapeName(v[0])}>` : "array<empty>";
    else if (v === null)                 out[key] = "null";
    else if (typeof v === "object")      out[key] = "object";
    else                                 out[key] = typeof v;
  }
  return out;
}

function shapeName(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

const CASES = [
  ["remember", () => memory.tool_remember({ content: "내용", topic: "test", type: "fact" })],
  ["recall",   () => memory.tool_recall({ keywords: ["a"] })],
  ["context",  () => memory.tool_context({ tokenBudget: 500 })],
  ["reflect",  () => memory.tool_reflect({ summary: ["사실 하나"] })]
];

describe("응답 형태 스냅샷", () => {
  test("4종 응답의 최상위 키와 타입이 스냅샷과 일치한다", async () => {
    const current = {};
    for (const [name, call] of CASES) {
      current[name] = shapeOf(await call());
    }

    if (process.env.SNAPSHOT_UPDATE === "1") {
      writeFileSync(SNAPSHOT_PATH, JSON.stringify(current, null, 2) + "\n");
    }

    assert.ok(existsSync(SNAPSHOT_PATH), `스냅샷이 없다. SNAPSHOT_UPDATE=1 로 생성하라: ${SNAPSHOT_PATH}`);
    assert.deepEqual(current, JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")));
  });

  test("모든 응답이 success 불리언을 노출한다", async () => {
    for (const [name, call] of CASES) {
      const res = await call();
      assert.equal(typeof res.success, "boolean", `${name} 응답에 success가 없다`);
    }
  });

  test("shapeOf는 값이 아니라 타입만 본다", () => {
    assert.deepEqual(shapeOf({ a: 1, b: "x" }), shapeOf({ a: 999, b: "다른 값" }));
  });

  test("shapeOf는 키 순서에 의존하지 않는다", () => {
    assert.deepEqual(shapeOf({ b: 1, a: 2 }), shapeOf({ a: 2, b: 1 }));
  });

  test("shapeOf는 빈 배열과 채워진 배열을 구분해 기록한다", () => {
    assert.equal(shapeOf({ a: [] }).a, "array<empty>");
    assert.equal(shapeOf({ a: ["x"] }).a, "array<string>");
  });
});
