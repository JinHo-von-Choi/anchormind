/**
 * mergeSegmentHits: 구간 히트를 L3 본문 후보에 합치는 규칙
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { mergeSegmentHits } from "../../lib/memory/read/SegmentMerge.js";

const frag = (id, similarity) => ({ id, similarity, content: `c-${id}` });
const O = { limit: 5, adoptLimit: 2, decay: 0.95 };

describe("mergeSegmentHits", () => {
  it("구간 히트가 없으면 본문 결과를 그대로 돌려준다", () => {
    const base = [frag("a", 0.9), frag("b", 0.8)];
    assert.strictEqual(mergeSegmentHits(base, [], O), base);
    assert.strictEqual(mergeSegmentHits(base, null, O), base);
  });

  it("본문 경로가 놓친 조각을 추가하고 감쇠를 곱한다", () => {
    const out = mergeSegmentHits([frag("a", 0.9)], [frag("n", 0.8)], O);
    const n = out.find(f => f.id === "n");
    assert.ok(n);
    assert.ok(Math.abs(n.similarity - 0.76) < 1e-9);
    assert.equal(n._segmentMatch, true);
    assert.equal(n._wholeSimilarity, null);
  });

  it("구간 유사도(감쇠 후)가 더 높은 기존 조각은 순위가 올라가고 원본 값을 보관한다", () => {
    const base = [frag("a", 0.9), frag("b", 0.5)];
    const out  = mergeSegmentHits(base, [frag("b", 0.98)], O);
    const b    = out.find(f => f.id === "b");
    assert.ok(Math.abs(b.similarity - 0.931) < 1e-9);
    assert.equal(b._wholeSimilarity, 0.5);
    assert.deepEqual(out.map(f => f.id), ["b", "a"]);
  });

  it("구간 유사도가 본문 유사도 이하면 기존 조각을 건드리지 않는다", () => {
    const base = [frag("a", 0.9)];
    const out  = mergeSegmentHits(base, [frag("a", 0.9)], O);          // 0.9 * 0.95 < 0.9
    assert.equal(out[0].similarity, 0.9);
    assert.equal(out[0]._segmentMatch, undefined);
  });

  it("영향을 주는 조각은 adoptLimit개까지만 채택하고 유사도가 높은 것부터 고른다", () => {
    const base = [frag("a", 0.5)];
    const hits = [frag("x", 0.70), frag("y", 0.90), frag("z", 0.80)];
    const out  = mergeSegmentHits(base, hits, O);                       // adoptLimit 2 -> y, z
    const ids  = out.map(f => f.id);
    assert.ok(ids.includes("y") && ids.includes("z"));
    assert.ok(!ids.includes("x"));
  });

  it("채택 상한 때문에 탈락한 기존 조각은 원래 본문 유사도로 남는다", () => {
    const base = [frag("a", 0.5), frag("b", 0.45), frag("c", 0.40)];
    const hits = [frag("a", 1.0), frag("b", 0.99), frag("c", 0.98)];     // 셋 다 상승 후보, 상한 2
    const out  = mergeSegmentHits(base, hits, O);
    const c    = out.find(f => f.id === "c");
    assert.equal(c.similarity, 0.40);
    assert.equal(c._segmentMatch, undefined);
  });

  it("본문 후보는 상한 안에서 밀려나지 않는다(합쳐도 limit 안이면 모두 남는다)", () => {
    const base = [frag("a", 0.9), frag("b", 0.8), frag("c", 0.7)];
    const out  = mergeSegmentHits(base, [frag("n1", 0.99), frag("n2", 0.98)], { ...O, limit: 5 });
    for (const id of ["a", "b", "c"]) assert.ok(out.some(f => f.id === id));
    assert.equal(out.length, 5);
  });

  it("limit으로 자른다", () => {
    const base = Array.from({ length: 5 }, (_, i) => frag(`b${i}`, 0.9 - i * 0.01));
    const out  = mergeSegmentHits(base, [frag("n", 0.99)], { limit: 5, adoptLimit: 3, decay: 1 });
    assert.equal(out.length, 5);
    assert.equal(out[0].id, "n");
  });

  it("유한하지 않은 유사도는 무시한다", () => {
    const base = [frag("a", 0.9)];
    const out  = mergeSegmentHits(base, [frag("n", NaN), { id: "m", similarity: undefined }], O);
    assert.deepEqual(out.map(f => f.id), ["a"]);
  });

  it("결과는 유사도 내림차순이고 입력 배열을 바꾸지 않는다", () => {
    const base = [frag("a", 0.9), frag("b", 0.6)];
    const copy = JSON.stringify(base);
    const out  = mergeSegmentHits(base, [frag("b", 0.97), frag("n", 0.7)], O);
    assert.equal(JSON.stringify(base), copy);
    for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].similarity >= out[i].similarity);
  });
});
