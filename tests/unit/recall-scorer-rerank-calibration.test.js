/**
 * buildRecallScorer: cross-encoder 점수와 복합 점수의 척도 보정
 *
 * 재정렬 점수(sigmoid, 관련 있어도 0.2~0.3 수준)와 복합 점수(중요도/최신성/유사도, 0.5 안팎)를 한 줄로 정렬하면
 * reranker가 검증하지 않은 파편(연결 파편, 재정렬 창 밖)이 검증된 파편 위로 올라간다. calibrate()가 이를 막는다.
 */

import { describe, it, mock } from "node:test";
import assert                  from "node:assert/strict";

mock.module("../../lib/redis.js", { namedExports: { redisClient: { status: "stub" } } });
mock.module("../../lib/logger.js", {
  namedExports: { logDebug: mock.fn(), logInfo: mock.fn(), logWarn: mock.fn(), logError: mock.fn() }
});

const { buildRecallScorer } = await import("../../lib/memory/processors/MemoryRecaller.js");

const NOW = Date.UTC(2026, 9, 8);
const fresh = (id, extra = {}) => ({ id, content: `c-${id}`, importance: 0.5, created_at: new Date(NOW).toISOString(), similarity: 0.5, keywords: [], ...extra });

describe("buildRecallScorer — rerank calibration", () => {
  const params = { text: "질문", topic: "t" };

  it("재정렬 점수가 없으면 calibrate를 불러도 computeRecallScore와 같은 값이다", () => {
    const scorer = buildRecallScorer(params, NOW, null);
    const frags  = [fresh("a"), fresh("b", { importance: 0.9 }), fresh("c", { similarity: 0.1 })];
    const before = frags.map(scorer);
    scorer.calibrate(frags);
    assert.deepEqual(frags.map(scorer), before);
  });

  it("보정 전에는 비검증 파편이 재정렬된 파편 위로 올라가고, 보정 후에는 아래에 있다", () => {
    const scorer     = buildRecallScorer(params, NOW, null);
    const reranked   = [fresh("r1", { rerankerScore: 0.30 }), fresh("r2", { rerankerScore: 0.19 }), fresh("r3", { rerankerScore: 0.02 })];
    const unverified = [fresh("l1", { _source: "linked" }), fresh("l2", { importance: 0.9, _source: "linked" })];
    const all        = [...reranked, ...unverified];

    const rawTop = [...all].sort((a, b) => scorer(b) - scorer(a))[0].id;
    assert.ok(rawTop.startsWith("l"), "보정 전: 비검증 파편이 1위");

    scorer.calibrate(all);
    const ordered = [...all].sort((a, b) => scorer(b) - scorer(a)).map(f => f.id);
    assert.deepEqual(ordered.slice(0, 3), ["r1", "r2", "r3"]);
    assert.ok(Math.max(...unverified.map(scorer)) < Math.min(...reranked.map(scorer)));
  });

  it("재정렬된 파편끼리, 비검증 파편끼리의 상대 순서는 유지된다", () => {
    const scorer = buildRecallScorer(params, NOW, null);
    const r = [fresh("r1", { rerankerScore: 0.3 }), fresh("r2", { rerankerScore: 0.2 })];
    const u = [fresh("u1", { importance: 0.9 }), fresh("u2", { importance: 0.2 }), fresh("u3", { importance: 0.5 })];
    const rawU = [...u].sort((a, b) => scorer(b) - scorer(a)).map(f => f.id);
    scorer.calibrate([...r, ...u]);
    assert.deepEqual([...u].sort((a, b) => scorer(b) - scorer(a)).map(f => f.id), rawU);
    assert.deepEqual([...r].sort((a, b) => scorer(b) - scorer(a)).map(f => f.id), ["r1", "r2"]);
  });

  it("calibrate를 다시 불러 재정렬 점수가 없는 집합이 오면 보정이 풀린다", () => {
    const scorer = buildRecallScorer(params, NOW, null);
    const f = fresh("x");
    const plain = scorer(f);
    scorer.calibrate([fresh("r", { rerankerScore: 0.1 }), f]);
    assert.ok(scorer(f) < plain);
    scorer.calibrate([f]);
    assert.equal(scorer(f), plain);
  });
});
