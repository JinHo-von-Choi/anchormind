/**
 * recall 최종 정렬 점수 함수 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-05-15
 *
 * computeRecallScore: rerankerScore 보존 + 제한된 lexical 보정 + origin 분기 검증
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeRecallScore } from "../../lib/memory/processors/MemoryRecaller.js";
import { MEMORY_CONFIG } from "../../config/memory.js";

const baseCtx = (over = {}) => ({
  lexicalQuery : {},
  anchorTime   : Date.now(),
  config       : MEMORY_CONFIG,
  ...over
});

describe("computeRecallScore", () => {
  it("rerankerScore가 있으면 그것을 base로 사용 (cross-encoder 보존)", () => {
    const frag = { rerankerScore: 0.9, importance: 0.1, similarity: 0.1 };
    const score = computeRecallScore(frag, baseCtx());
    assert.ok(score >= 0.9, `rerankerScore base 보존 기대, got ${score}`);
  });

  it("rerankerScore 미보유 파편 base는 디스카운트 계수 적용", () => {
    const frag = { importance: 1.0, similarity: 1.0, created_at: new Date().toISOString() };
    // composite = 0.4 + 0.3 + 0.3 = 1.0, discount 0.85 = 0.85
    const score = computeRecallScore(frag, baseCtx({ anchorTime: new Date(frag.created_at).getTime() }));
    assert.ok(score >= 0.84 && score <= 0.86, `discount base ~0.85 기대, got ${score}`);
  });

  it("lexWeight는 파편별 rerankerScore 유무로 결정 (집합 단위 아님)", () => {
    // 같은 lexical 신호(topic exact)에 대해 rerankerScore 보유/미보유가 다른 lexWeight를 받는지
    const reranked   = { rerankerScore: 0.50, topic: "memento-mcp" };
    const unreranked = { topic: "memento-mcp", importance: 0.5, similarity: 0,
                         created_at: new Date().toISOString() };
    const ctx = baseCtx({ lexicalQuery: { topic: "memento-mcp" } });
    const r = computeRecallScore(reranked, ctx);
    const u = computeRecallScore(unreranked, ctx);
    // reranked: 0.50 + lexNorm*0.12,  unreranked: composite*0.85 + lexNorm*0.18
    // 핵심: 두 파편이 동일 lexicalQuery·_source라도 lexWeight가 다르므로 lexical 기여도가 다름
    assert.notStrictEqual(r, u, "rerankerScore 유무로 점수가 달라야 lexWeight 파편별 판정 검증");
  });

  it("rerankerScore 격차를 lexical 보정이 무조건 뒤집지 않는다", () => {
    const high   = { rerankerScore: 0.80, topic: "other" };
    const lowLex = { rerankerScore: 0.70, topic: "memento-mcp" };
    const ctx = baseCtx({ lexicalQuery: { topic: "memento-mcp" } });
    // high: 0.80 + 0,  lowLex: 0.70 + log1p(4)/log1p(8) * 0.12 ≈ 0.70 + 0.0915 ≈ 0.79
    assert.ok(
      computeRecallScore(high, ctx) > computeRecallScore(lowLex, ctx),
      "rerankerScore 0.10 격차가 reranked lexWeight(0.12) 보정으로 뒤집히지 않아야 함"
    );
  });

  it("reranker 비활성 시 직접 topic 일치가 무관 최신 파편보다 상위", () => {
    const now = Date.now();
    const onTopicOld = {
      topic: "memento-mcp", importance: 0.5,
      created_at: new Date(now - 30 * 86400000).toISOString(), similarity: 0
    };
    const offTopicNew = {
      topic: "unrelated", importance: 0.5,
      created_at: new Date(now).toISOString(), similarity: 0
    };
    const ctx = baseCtx({ anchorTime: now, lexicalQuery: { topic: "memento-mcp" } });
    assert.ok(
      computeRecallScore(onTopicOld, ctx) > computeRecallScore(offTopicNew, ctx),
      "정확 topic 매치가 최신 무관 파편보다 위여야 함"
    );
  });

  it("연결 파편(_source=linked)은 lexical 가중치가 절반", () => {
    const direct = { topic: "memento-mcp", importance: 0.3, similarity: 0, created_at: new Date().toISOString() };
    const linked = { ...direct, _source: "linked" };
    const ctx = baseCtx({ lexicalQuery: { topic: "memento-mcp" } });
    assert.ok(
      computeRecallScore(direct, ctx) > computeRecallScore(linked, ctx),
      "동일 내용이면 직접 파편이 연결 파편보다 상위"
    );
  });

  it("log 스케일: lexRaw 강도 차이가 변별력을 유지", () => {
    // lexRaw 4 vs 12 — min clamp(8)였다면 모두 1.0이 되지만 log 스케일은 차이 보존
    const ctx = baseCtx({ lexicalQuery: { topic: "memento-mcp", keywords: ["a","b","c"] } });
    const weak   = { topic: "memento-mcp", importance: 0, similarity: 0,
                     created_at: new Date().toISOString() }; // topic exact = 4
    const strong = { ...weak, keywords: ["memento-mcp", "a", "b", "c"], content: "a b c" };
    const wScore = computeRecallScore(weak, ctx);
    const sScore = computeRecallScore(strong, ctx);
    assert.ok(sScore > wScore, "강한 lexical 신호가 약한 신호보다 높은 점수 (log 변별력 유지)");
  });

  it("hard tier 없음 — content 1회 매치가 완벽 의미매치를 압도하지 않음", () => {
    const perfectSemantic = { rerankerScore: 1.0, content: "" };
    const weakLexical     = { rerankerScore: 0.3, content: "memento 등장" };
    const ctx = baseCtx({ lexicalQuery: { keywords: ["memento"] } });
    assert.ok(
      computeRecallScore(perfectSemantic, ctx) > computeRecallScore(weakLexical, ctx),
      "lexical hard override 회귀 방지"
    );
  });
});
