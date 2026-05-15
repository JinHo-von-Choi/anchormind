/**
 * recall 정렬 안정성 통합 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-05-15
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeRecallScore } from "../../lib/memory/processors/MemoryRecaller.js";
import { MEMORY_CONFIG } from "../../config/memory.js";

const sortBy = (frags, ctx) =>
  [...frags].sort((a, b) => computeRecallScore(b, ctx) - computeRecallScore(a, ctx));

describe("recall 정렬 안정성", () => {
  it("reranker 활성 집합에서 rerankerScore 내림차순이 대체로 보존된다", () => {
    const now = Date.now();
    const frags = [
      { id: "a", rerankerScore: 0.95, topic: "x", created_at: new Date(now).toISOString() },
      { id: "b", rerankerScore: 0.80, topic: "x", created_at: new Date(now).toISOString() },
      { id: "c", rerankerScore: 0.60, topic: "x", created_at: new Date(now).toISOString() },
    ];
    const ctx = { lexicalQuery: {}, anchorTime: now, config: MEMORY_CONFIG };
    const sorted = sortBy(frags, ctx).map(f => f.id);
    assert.deepEqual(sorted, ["a", "b", "c"]);
  });

  it("페이지 경계: 동일 입력은 호출마다 동일 순서 (결정적)", () => {
    const now = Date.now();
    const frags = Array.from({ length: 20 }, (_, i) => ({
      id: `f${i}`,
      rerankerScore: 0.5 + (i % 5) * 0.05,
      topic: i % 3 === 0 ? "memento-mcp" : "other",
      created_at: new Date(now - i * 86400000).toISOString()
    }));
    const ctx = { lexicalQuery: { topic: "memento-mcp" }, anchorTime: now, config: MEMORY_CONFIG };
    const run1 = sortBy(frags, ctx).map(f => f.id);
    const run2 = sortBy(frags, ctx).map(f => f.id);
    assert.deepEqual(run1, run2, "정렬은 결정적이어야 cursor 페이지네이션이 안정적");
  });

  it("연결 파편이 동점 직접 파편을 밀어내지 못한다", () => {
    const now = Date.now();
    const direct = {
      id: "direct", topic: "memento-mcp", importance: 0.5, similarity: 0,
      created_at: new Date(now).toISOString()
    };
    const linked = {
      id: "linked", topic: "memento-mcp", importance: 0.5, similarity: 0,
      created_at: new Date(now).toISOString(), _source: "linked"
    };
    const ctx = { lexicalQuery: { topic: "memento-mcp" }, anchorTime: now, config: MEMORY_CONFIG };
    const sorted = sortBy([linked, direct], ctx).map(f => f.id);
    assert.deepEqual(sorted, ["direct", "linked"]);
  });

  it("혼합 집합: rerankerScore 보유/미보유 파편의 base 스케일 분리", () => {
    const now = Date.now();
    const reranked   = { id: "r", rerankerScore: 0.50, topic: "other",
                         created_at: new Date(now).toISOString() };
    const unreranked = { id: "u", importance: 1.0, similarity: 1.0, topic: "other",
                         created_at: new Date(now).toISOString() };
    // unreranked composite = 0.4 + 0.3*1.0(now) + 0.3 = 1.0, discount 0.85 = 0.85
    // reranked = 0.50
    // 따라서 unreranked가 우선 — discount로 인해 reranker 미통과 파편이라도 importance·similarity가
    // 압도적으로 높으면 reranker 통과 중위권을 이길 수 있음. 의도된 동작 (페널티는 0.85 한 번뿐).
    const ctx = { lexicalQuery: {}, anchorTime: now, config: MEMORY_CONFIG };
    const sorted = sortBy([reranked, unreranked], ctx).map(f => f.id);
    assert.deepEqual(sorted, ["u", "r"]);
  });
});
