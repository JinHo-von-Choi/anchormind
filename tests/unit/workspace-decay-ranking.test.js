/**
 * workspace 스코프 랭킹 감쇠 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-08-15
 *
 * computeWorkspaceDecayFactor(FragmentSearch)와 이를 소비하는
 * computeRecallScore(MemoryRecaller) / buildRankedInjection(ContextBuilder)의
 * 감쇠 적용·미적용 경계를 검증한다.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { computeWorkspaceDecayFactor } from "../../lib/memory/read/FragmentSearch.js";
import { computeRecallScore }          from "../../lib/memory/processors/MemoryRecaller.js";
import { buildRankedInjection }        from "../../lib/memory/read/ContextBuilder.js";
import { MEMORY_CONFIG }               from "../../config/memory.js";

const baseCtx = (over = {}) => ({
  lexicalQuery: {},
  anchorTime  : Date.now(),
  config      : MEMORY_CONFIG,
  ...over
});

describe("computeWorkspaceDecayFactor", () => {
  it("scope workspace 미지정 시 감쇠 없음", () => {
    assert.equal(computeWorkspaceDecayFactor({ workspace: "other" }, null), 1);
  });

  it("fragment.workspace가 scope와 일치하면 감쇠 없음", () => {
    assert.equal(computeWorkspaceDecayFactor({ workspace: "proj-a" }, "proj-a"), 1);
  });

  it("fragment.workspace가 scope와 불일치하면 penalty 적용", () => {
    assert.equal(
      computeWorkspaceDecayFactor({ workspace: "proj-b" }, "proj-a"),
      MEMORY_CONFIG.workspaceDecay.penalty
    );
  });

  it("fragment.workspace가 NULL(전역)이면 penalty 적용", () => {
    assert.equal(
      computeWorkspaceDecayFactor({ workspace: null }, "proj-a"),
      MEMORY_CONFIG.workspaceDecay.penalty
    );
  });

  describe("workspaceDecay.enabled=false", () => {
    let original;
    beforeEach(() => { original = MEMORY_CONFIG.workspaceDecay.enabled; });
    afterEach(()  => { MEMORY_CONFIG.workspaceDecay.enabled = original; });

    it("비활성화 시 불일치 파편에도 감쇠 미적용", () => {
      MEMORY_CONFIG.workspaceDecay.enabled = false;
      assert.equal(computeWorkspaceDecayFactor({ workspace: null }, "proj-a"), 1);
    });
  });
});

describe("computeRecallScore 워크스페이스 감쇠", () => {
  it("scope 미지정(ctx.workspace undefined) 시 무감쇠 — 기존 순위 보존", () => {
    const now = Date.now();
    const inScope  = { importance: 0.5, similarity: 0, workspace: "proj-a", created_at: new Date(now).toISOString() };
    const mismatch = { importance: 0.5, similarity: 0, workspace: "proj-b", created_at: new Date(now).toISOString() };
    const ctx = baseCtx({ anchorTime: now });
    assert.equal(computeRecallScore(inScope, ctx), computeRecallScore(mismatch, ctx));
  });

  it("scope 지정 시 workspace 일치 파편이 불일치 파편보다 상위", () => {
    const now = Date.now();
    const inScope  = { importance: 0.5, similarity: 0, workspace: "proj-a", created_at: new Date(now).toISOString() };
    const mismatch = { importance: 0.5, similarity: 0, workspace: "proj-b", created_at: new Date(now).toISOString() };
    const ctx = baseCtx({ anchorTime: now, workspace: "proj-a" });
    assert.ok(
      computeRecallScore(inScope, ctx) > computeRecallScore(mismatch, ctx),
      "동일 조건이면 workspace 일치 파편이 상위여야 함"
    );
  });

  it("scope 지정 시 NULL(전역) 파편도 penalty만큼 감쇠", () => {
    const now = Date.now();
    const inScope = { importance: 0.5, similarity: 0, workspace: "proj-a", created_at: new Date(now).toISOString() };
    const global   = { importance: 0.5, similarity: 0, workspace: null,     created_at: new Date(now).toISOString() };
    const ctx = baseCtx({ anchorTime: now, workspace: "proj-a" });
    const scoreInScope = computeRecallScore(inScope, ctx);
    const scoreGlobal  = computeRecallScore(global, ctx);
    assert.ok(scoreGlobal < scoreInScope);
    assert.ok(Math.abs(scoreGlobal - scoreInScope * MEMORY_CONFIG.workspaceDecay.penalty) < 1e-9);
  });
});

describe("buildRankedInjection 워크스페이스 감쇠", () => {
  const weights = { importance: 1.0, ema_activation: 0.5 };

  it("workspace 미지정 시 감쇠 없이 importance 순", () => {
    const others = [
      { id: "mismatch", importance: 0.9, workspace: "proj-b" },
      { id: "inscope",  importance: 0.5, workspace: "proj-a" },
    ];
    const result = buildRankedInjection([], others, 2000, weights);
    assert.equal(result.items[0].id, "mismatch");
  });

  it("workspace 지정 시 불일치 파편의 순위가 하향된다", () => {
    const others = [
      { id: "mismatch", importance: 0.6, workspace: "proj-b" },
      { id: "inscope",  importance: 0.5, workspace: "proj-a" },
    ];
    // penalty(0.7) 적용 전: mismatch(0.6) > inscope(0.5). 적용 후: 0.6*0.7=0.42 < 0.5.
    const result = buildRankedInjection([], others, 2000, weights, "proj-a");
    assert.equal(result.items[0].id, "inscope");
  });
});
