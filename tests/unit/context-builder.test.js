/**
 * ContextBuilder 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-05
 *
 * recall을 mock하여 ContextBuilder.build()의 Core/WM/Anchor 조합,
 * 중복 제거, structured 모드, 힌트 생성을 검증한다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { ContextBuilder, buildContextHint, buildRankedInjection } from "../../lib/memory/read/ContextBuilder.js";

/* ── 헬퍼: 파편 팩토리 ── */
function frag(id, type, content, extra = {}) {
  return { id, type, content, importance: 0.5, ...extra };
}

/* ── buildContextHint 단위 테스트 ── */
describe("buildContextHint", () => {
  it("error 파편이 있으면 active_errors 힌트 반환", () => {
    const hint = buildContextHint([frag("1", "error", "err"), frag("2", "fact", "ok")]);
    assert.equal(hint.signal, "active_errors");
    assert.equal(hint.trigger, "forget");
  });

  it("파편이 비어 있으면 empty_context 힌트 반환", () => {
    const hint = buildContextHint([]);
    assert.equal(hint.signal, "empty_context");
    assert.equal(hint.trigger, "remember");
  });

  it("error 없고 파편 존재 시 null 반환", () => {
    const hint = buildContextHint([frag("1", "fact", "ok")]);
    assert.equal(hint, null);
  });
});

/* ── buildRankedInjection 단위 테스트 ── */
describe("buildRankedInjection", () => {
  const weights = { importance: 1.0, ema_activation: 0.5 };

  it("anchor를 상단에 고정하고 나머지를 점수순 정렬", () => {
    const anchors = [frag("a1", "anchor", "anchor text", { importance: 1.0 })];
    const others  = [
      frag("o1", "fact", "low", { importance: 0.2, ema_activation: 0 }),
      frag("o2", "fact", "high", { importance: 0.9, ema_activation: 0.5 }),
    ];
    const result = buildRankedInjection(anchors, others, 2000, weights);
    assert.equal(result.items[0].anchor, true);
    assert.equal(result.items[0].id, "a1");
    assert.equal(result.items[1].id, "o2");
    assert.equal(result.items[2].id, "o1");
  });

  it("토큰 예산 초과 시 잘림", () => {
    const anchors = [];
    const others  = [
      frag("o1", "fact", "a".repeat(400), { importance: 0.9 }),
      frag("o2", "fact", "b".repeat(400), { importance: 0.5 }),
    ];
    const result = buildRankedInjection(anchors, others, 100, weights);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, "o1");
  });
});

/* ── ContextBuilder.build() 통합 테스트 ── */
describe("ContextBuilder.build()", () => {
  let recallMock;
  let indexMock;
  let storeMock;
  let builder;

  beforeEach(() => {
    recallMock = mock.fn(async (params) => {
      if (params.topic === "session_reflect") {
        return { fragments: [] };
      }
      return {
        fragments: [
          frag(`${params.type}-1`, params.type, `${params.type} content 1`),
          frag(`${params.type}-2`, params.type, `${params.type} content 2`),
        ]
      };
    });

    indexMock = {
      getWorkingMemory: mock.fn(async () => []),
      setSeenIds      : mock.fn(async () => {}),
    };

    storeMock = {
      searchBySource: mock.fn(async () => []),
    };

    builder = new ContextBuilder({
      recall : recallMock,
      store  : storeMock,
      index  : indexMock,
      getPool: () => null,
    });
  });

  it("기본 types로 recall을 호출하고 fragments를 반환", async () => {
    const result = await builder.build({});

    assert.ok(Array.isArray(result.fragments));
    assert.ok(result.fragments.length > 0);
    assert.equal(typeof result.totalTokens, "number");
    assert.equal(typeof result.injectionText, "string");
    assert.equal(typeof result.coreTokens, "number");
    assert.equal(typeof result.wmTokens, "number");
    assert.equal(typeof result.wmCount, "number");
    assert.equal(typeof result.anchorCount, "number");
  });

  it("recall을 types 수 + session_reflect 1회 호출", async () => {
    await builder.build({ types: ["error", "preference"] });
    /** error, preference + session_reflect = 3회 */
    assert.equal(recallMock.mock.callCount(), 3);
  });

  it("sessionId 전달 시 working memory를 로드하고 seenIds 저장", async () => {
    indexMock.getWorkingMemory = mock.fn(async () => [
      { id: "wm-1", content: "wm item", type: "fact" }
    ]);

    const result = await builder.build({ sessionId: "sess-1" });

    assert.equal(indexMock.getWorkingMemory.mock.callCount(), 1);
    assert.equal(indexMock.setSeenIds.mock.callCount(), 1);
    assert.equal(result.wmCount, 1);
  });

  it("중복 ID 파편은 첫 등장만 유지", async () => {
    recallMock = mock.fn(async (params) => {
      if (params.topic === "session_reflect") return { fragments: [] };
      return {
        fragments: [frag("dup-1", params.type, `${params.type} content`)]
      };
    });
    builder = new ContextBuilder({ recall: recallMock, store: storeMock, index: indexMock, getPool: () => null });

    const result = await builder.build({ types: ["error", "preference"] });
    const ids    = result.fragments.map(f => f.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size);
  });

  it("structured=true 시 계층적 트리 구조 반환", async () => {
    const result = await builder.build({ structured: true });

    assert.equal(result.success, true);
    assert.equal(result.structured, true);
    assert.ok(result.core);
    assert.ok(result.working);
    assert.ok(result.anchors);
    assert.ok(result.learning);
    assert.ok(result.rankedInjection);
    assert.equal(typeof result.count, "number");
  });

  it("파편이 비어 있으면 _memento_hint에 empty_context 포함", async () => {
    recallMock = mock.fn(async () => ({ fragments: [] }));
    builder    = new ContextBuilder({ recall: recallMock, store: storeMock, index: indexMock, getPool: () => null });

    const result = await builder.build({});
    assert.ok(result._memento_hint);
    assert.equal(result._memento_hint.signal, "empty_context");
  });

  it("error 파편 존재 시 _memento_hint에 active_errors 포함", async () => {
    recallMock = mock.fn(async (params) => {
      if (params.topic === "session_reflect") return { fragments: [] };
      if (params.type === "error") {
        return { fragments: [frag("err-1", "error", "some error")] };
      }
      return { fragments: [] };
    });
    builder = new ContextBuilder({ recall: recallMock, store: storeMock, index: indexMock, getPool: () => null });

    const result = await builder.build({});
    assert.ok(result._memento_hint);
    assert.equal(result._memento_hint.signal, "active_errors");
  });
});
