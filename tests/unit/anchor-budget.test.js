/**
 * context 앵커 토큰 예산 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-20
 *
 * 순수 판정(anchorBudgetReport, anchorBudgetForCandidate), anchor 단계의 경고와 reject, 저장 통계의
 * workspace별 앵커 토큰 요약을 확인한다. DB는 쓰지 않는다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { anchorBudgetReport, anchorBudgetForCandidate, ANCHOR_BUDGET_RULE } from "../../lib/memory/anchorBudget.js";
import { anchorStep, isGateEligible } from "../../lib/memory/write/WriteGate.js";
import { summarizeWorkspaceDistribution } from "../../lib/memory/consolidate/MemoryConsolidator.js";

const tokensOfLength = (content) => content.length;

describe("anchorBudgetReport", () => {
  it("예산 이하이면 내릴 후보가 없다", () => {
    const out = anchorBudgetReport([{ id: "a", content: "x".repeat(300) }, { id: "b", content: "y".repeat(200) }], 600, tokensOfLength);
    assert.deepEqual(out, { used: 500, limit: 600, exceeded: false, demote_candidates: [] });
  });

  it("넘으면 순위가 낮은 쪽부터 예산 이하가 될 때까지 고른다", () => {
    const anchors = [
      { id: "a", content: "x".repeat(400) }, { id: "b", content: "x".repeat(300) },
      { id: "c", content: "x".repeat(200) }, { id: "d", content: "x".repeat(100) }
    ];
    const out = anchorBudgetReport(anchors, 650, tokensOfLength);
    assert.equal(out.used, 1000);
    assert.equal(out.exceeded, true);
    assert.deepEqual(out.demote_candidates, ["d", "c", "b"], "1000에서 d, c를 빼도 700이라 b까지 빼야 650 이하");
  });

  it("예산 0이면 보고하지 않는다", () => {
    assert.equal(anchorBudgetReport([{ id: "a", content: "x" }], 0, tokensOfLength), null);
  });
});

describe("anchorBudgetForCandidate", () => {
  const injected = [
    { id: "a", importance: 0.9, tokens: 400 },
    { id: "b", importance: 0.8, tokens: 300 },
    { id: "c", importance: 0.5, tokens: 200 }
  ];

  it("후보가 주입 상위에 들고 합이 예산을 넘으면 후보를 뺀 하위부터 내릴 후보로 고른다", () => {
    const out = anchorBudgetForCandidate({ injected, candidate: { importance: 0.85, tokens: 250 }, maxAnchors: 20, limit: 1000 });
    assert.equal(out.exceeded, true);
    assert.equal(out.used, 1150);
    assert.deepEqual(out.demote_candidates, ["c"]);
  });

  it("후보가 상위 maxAnchors 밖이면 주입되지 않으므로 판정하지 않는다", () => {
    const out = anchorBudgetForCandidate({ injected, candidate: { importance: 0.1, tokens: 900 }, maxAnchors: 3, limit: 500 });
    assert.equal(out.exceeded, false);
  });

  it("갱신으로 이미 앵커인 행은 자기 자신을 두 번 세지 않는다", () => {
    const out = anchorBudgetForCandidate({ injected, candidate: { id: "b", importance: 0.8, tokens: 300 }, maxAnchors: 20, limit: 900 });
    assert.deepEqual(out, { exceeded: false, used: 900, demote_candidates: [] });
  });
});

function stateOf(draft) {
  return {
    entry: "remember", op: "create", mode: "production", metrics: "all", fields: {}, base: null,
    draft: { is_anchor: true, importance: 0.9, content: "x".repeat(10), estimated_tokens: 600, workspace: "ws", ...draft },
    ctx: { keyId: null, agentId: "default", isMaster: true }, violations: []
  };
}

function depsOf(mode, injected = [{ id: "old-1", importance: 0.8, tokens: 500 }]) {
  const calls = [];
  return {
    calls,
    anchorPermissionMode    : () => "warn",
    anchorTokenBudgetMode   : () => mode,
    contextAnchorTokenBudget: () => 1000,
    loadInjectedAnchors     : async (scope) => { calls.push(scope); return injected; }
  };
}

describe("anchorStep 토큰 예산", () => {
  it("warn은 앵커로 두고 경고와 내릴 후보를 싣는다", async () => {
    const deps = depsOf("warn");
    const next = await anchorStep(stateOf(), deps);
    assert.equal(next.draft.is_anchor, true);
    const v = next.violations.find(x => x.rule === ANCHOR_BUDGET_RULE);
    assert.ok(v, "예산 경고");
    assert.match(v.detail, /1100 tokens > budget 1000; demote candidates: old-1/);
    assert.deepEqual(deps.calls, [{ keyId: null, workspace: "ws", limit: 20 }]);
    assert.equal(isGateEligible(v), false, "예산 경고는 hard gate 대상이 아니다");
  });

  it("reject는 앵커 지정을 거두고 경고를 싣는다", async () => {
    const next = await anchorStep(stateOf(), depsOf("reject"));
    assert.equal(next.draft.is_anchor, false);
    assert.match(next.violations.find(x => x.rule === ANCHOR_BUDGET_RULE).detail, /not applied/);
  });

  it("예산 안이면 아무것도 싣지 않는다", async () => {
    const next = await anchorStep(stateOf({ estimated_tokens: 100 }), depsOf("warn"));
    assert.equal(next.violations.length, 0);
  });

  it("off이거나 조회 함수가 없으면 조회하지 않는다", async () => {
    const off = depsOf("off");
    await anchorStep(stateOf(), off);
    assert.equal(off.calls.length, 0);
    const { loadInjectedAnchors: _drop, ...noLoader } = depsOf("warn");
    const next = await anchorStep(stateOf(), noLoader);
    assert.equal(next.violations.length, 0);
  });

  it("조회 실패는 판정하지 않고 저장을 막지 않는다", async () => {
    const deps = { ...depsOf("reject"), loadInjectedAnchors: async () => { throw new Error("db down"); } };
    const next = await anchorStep(stateOf(), deps);
    assert.equal(next.draft.is_anchor, true);
  });
});

describe("summarizeWorkspaceDistribution 앵커 토큰", () => {
  it("workspace마다 앵커 수와 토큰 합을 싣고 NULL은 따로 센다", () => {
    const out = summarizeWorkspaceDistribution([
      { workspace: "a", cnt: "10", anchors: "2", anchor_tokens: "300" },
      { workspace: null, cnt: "5", anchors: "1", anchor_tokens: "120" }
    ]);
    assert.deepEqual(out.top, [{ workspace: "a", count: 10, anchors: 2, anchor_tokens: 300 }]);
    assert.equal(out.null_anchors, 1);
    assert.equal(out.null_anchor_tokens, 120);
  });

  it("앵커 열이 없는 행은 이전 모양을 유지한다", () => {
    const out = summarizeWorkspaceDistribution([{ workspace: "a", cnt: 3 }]);
    assert.deepEqual(out, { top: [{ workspace: "a", count: 3 }], null_count: 0, distinct_count: 1 });
  });
});
