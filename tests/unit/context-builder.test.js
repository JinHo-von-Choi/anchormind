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

import {
  ContextBuilder,
  buildContextHint,
  buildRankedInjection,
  deduplicateContextSections
} from "../../lib/memory/read/ContextBuilder.js";

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

  it("global-only 빈 컨텍스트는 workspace 재조회 안내", () => {
    const hint = buildContextHint([], { mode: "global_only" });
    assert.equal(hint.signal, "empty_context");
    assert.equal(hint.trigger, "context");
    assert.match(hint.suggestion, /전역\(workspace 없음\).*workspace를 지정/);
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

describe("deduplicateContextSections", () => {
  it("anchor > core > learning > working 순으로 동일 ID의 섹션 소유권을 정한다", () => {
    const duplicate = id => frag("shared-id", "fact", `${id} content`);
    const result = deduplicateContextSections({
      anchor  : [duplicate("anchor")],
      core    : [duplicate("core"), frag("core-only", "fact", "core only")],
      learning: [duplicate("learning"), frag("learning-only", "fact", "learning only")],
      working : [duplicate("working"), frag("working-only", "fact", "working only")]
    });

    assert.deepEqual(result.anchor.map(item => item.content), ["anchor content"]);
    assert.deepEqual(result.core.map(item => item.id), ["core-only"]);
    assert.deepEqual(result.learning.map(item => item.id), ["learning-only"]);
    assert.deepEqual(result.working.map(item => item.id), ["working-only"]);
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
      { id: "wm-1", content: "wm item", type: "fact", workspace: null }
    ]);

    const result = await builder.build({ sessionId: "sess-1" });

    assert.equal(indexMock.getWorkingMemory.mock.callCount(), 1);
    assert.equal(indexMock.setSeenIds.mock.callCount(), 1);
    assert.equal(result.wmCount, 1);
  });

  it("working memory는 added_at 최신순, 동점이면 id 오름차순이다", async () => {
    indexMock.getWorkingMemory = mock.fn(async () => [
      { id: "wm-b", content: "b", type: "fact", added_at: 100, workspace: null },
      { id: "wm-old", content: "old", type: "fact", added_at: 50, workspace: null },
      { id: "wm-a", content: "a", type: "fact", added_at: 100, workspace: null },
      { id: "wm-new", content: "new", type: "fact", added_at: 200, workspace: null }
    ]);

    const result = await builder.build({ sessionId: "synthetic-session", structured: true });
    assert.deepEqual(
      result.working.current_session.map(item => item.id),
      ["wm-new", "wm-a", "wm-b", "wm-old"]
    );
  });

  it("workspace scope를 core와 learning source 조회에 동일하게 전달", async () => {
    await builder.build({ workspace: "ws-a" });

    for (const call of recallMock.mock.calls) {
      assert.equal(call.arguments[0].workspace, "ws-a");
      assert.equal(call.arguments[0].allWorkspaces, false);
    }
    const sourceArgs = storeMock.searchBySource.mock.calls[0].arguments;
    assert.equal(sourceArgs[4], "ws-a");
    assert.equal(sourceArgs[5], false);
  });

  it("working memory에서 다른 workspace와 legacy entry를 제외", async () => {
    indexMock.getWorkingMemory = mock.fn(async () => [
      { id: "global", content: "global", type: "fact", workspace: null },
      { id: "same", content: "same", type: "fact", workspace: "ws-a" },
      { id: "other", content: "other", type: "fact", workspace: "ws-b" },
      { id: "legacy", content: "legacy", type: "fact" }
    ]);

    const result = await builder.build({ sessionId: "session-a", workspace: "ws-a" });
    const wmIds = result.fragments.filter(f => f.id?.startsWith("g") || f.id === "same" || f.id === "other" || f.id === "legacy").map(f => f.id);
    assert.ok(wmIds.includes("global"));
    assert.ok(wmIds.includes("same"));
    assert.ok(!wmIds.includes("other"));
    assert.ok(!wmIds.includes("legacy"));
  });

  it("allWorkspaces=true이면 모든 신규 working memory entry를 허용", async () => {
    indexMock.getWorkingMemory = mock.fn(async () => [
      { id: "a", content: "a", type: "fact", workspace: "ws-a" },
      { id: "b", content: "b", type: "fact", workspace: "ws-b" },
      { id: "legacy", content: "legacy", type: "fact" }
    ]);

    const result = await builder.build({
      sessionId: "session-all", allWorkspaces: true, _isMaster: true
    });
    const ids = new Set(result.fragments.map(f => f.id));
    assert.ok(ids.has("a"));
    assert.ok(ids.has("b"));
    assert.ok(ids.has("legacy"));
    for (const call of recallMock.mock.calls) {
      assert.equal(call.arguments[0]._isMaster, true);
    }
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

  it("structured 출력의 모든 표현과 통계가 dedup 이후 ID 집합을 공유한다", async () => {
    const shared = "shared-id";
    recallMock = mock.fn(async (params) => {
      if (params.topic === "session_reflect") return { fragments: [] };
      return { fragments: [frag(shared, params.type, "core duplicate")] };
    });
    indexMock.getWorkingMemory = mock.fn(async () => [
      frag(shared, "fact", "working duplicate"),
      frag("working-only", "fact", "working only")
    ]);
    storeMock.searchBySource = mock.fn(async () => [
      frag(shared, "fact", "learning duplicate", { source: "learning_extraction", is_anchor: false }),
      frag("learning-only", "fact", "learning only", { source: "learning_extraction", is_anchor: false })
    ]);
    const pool = {
      query: mock.fn(async () => ({
        rows: [frag(shared, "fact", "anchor owner", { is_anchor: true })]
      }))
    };
    builder = new ContextBuilder({
      recall: recallMock,
      store : storeMock,
      index : indexMock,
      getPool: () => pool
    });

    const result = await builder.build({
      structured : true,
      sessionId  : "synthetic-session",
      workspace  : "synthetic-workspace",
      types      : ["fact"],
      tokenBudget: 2000
    });

    const fragmentIds = result.fragments.map(item => item.id);
    const treeIds = [
      ...result.anchors.permanent,
      ...Object.values(result.core).flat(),
      ...result.learning.recent,
      ...result.working.current_session
    ].map(item => item.id);
    const rankedIds = result.rankedInjection.items.map(item => item.id);

    assert.deepEqual(new Set(fragmentIds), new Set(treeIds));
    assert.deepEqual(new Set(fragmentIds), new Set(rankedIds));
    assert.equal(fragmentIds.length, new Set(fragmentIds).size);
    assert.equal(treeIds.length, new Set(treeIds).size);
    assert.equal(result.fragments.find(item => item.id === shared).content, "anchor owner");
    assert.equal((result.injectionText.match(/anchor owner/g) || []).length, 1);
    assert.doesNotMatch(result.injectionText, /core duplicate|learning duplicate|working duplicate/);
    assert.equal(result.count, fragmentIds.length);
    assert.equal(
      result.totalTokens,
      result.anchorTokens + result.coreTokens + result.learningTokens + result.wmTokens
    );
    assert.deepEqual(storeMock.searchBySource.mock.calls[0].arguments[4], {
      workspace: "synthetic-workspace",
      isAnchor: false
    });
  });

  it("작은 structured 토큰 예산도 tree/fragments/injection/ranked 통계를 함께 절삭한다", async () => {
    recallMock = mock.fn(async (params) => {
      if (params.topic === "session_reflect") return { fragments: [] };
      return { fragments: [frag("core-only", params.type, "c".repeat(80))] };
    });
    indexMock.getWorkingMemory = mock.fn(async () => [
      frag("working-only", "fact", "w".repeat(80))
    ]);
    storeMock.searchBySource = mock.fn(async () => [
      frag("learning-only", "fact", "l".repeat(80), { source: "learning_extraction" })
    ]);
    builder = new ContextBuilder({
      recall: recallMock,
      store : storeMock,
      index : indexMock,
      getPool: () => ({
        query: async () => ({ rows: [frag("anchor-only", "fact", "anchor", { is_anchor: true })] })
      })
    });

    const result = await builder.build({
      structured : true,
      sessionId  : "synthetic-session",
      types      : ["fact"],
      tokenBudget: 2
    });

    assert.deepEqual(result.fragments.map(item => item.id), ["anchor-only"]);
    assert.deepEqual(result.rankedInjection.items.map(item => item.id), ["anchor-only"]);
    assert.equal(result.rankedInjection.totalTokens, result.totalTokens);
    assert.equal(result.count, 1);
    assert.equal(result.coreTokens, 0);
    assert.equal(result.learningTokens, 0);
    assert.equal(result.wmTokens, 0);
    assert.match(result.injectionText, /anchor/);
    assert.doesNotMatch(result.injectionText, /c{20}|l{20}|w{20}/);
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
