/**
 * RRF 하이브리드 검색 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-03
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import {
  mergeRRF,
  resolveL3SearchOptions,
  resolveRrfLayerWeights,
  withTimeout
} from "../../lib/memory/FragmentSearch.js";

const l1Ids     = ["b"];
const l2Results = [
  { id: "a", content: "foo", importance: 0.8 },
  { id: "b", content: "bar", importance: 0.6 }
];
const l3Results = [
  { id: "b", content: "bar", similarity: 0.9 },
  { id: "c", content: "baz", similarity: 0.7 }
];

describe("mergeRRF", () => {
  const layers = [
    { name: "l1", results: l1Ids,     weightFactor: 2.0 },
    { name: "l2", results: l2Results, weightFactor: 1.0 },
    { name: "l3", results: l3Results, weightFactor: 1.0 },
  ];

  test("L1, L2, L3 결과가 모두 병합되어야 한다", () => {
    const merged = mergeRRF(layers);
    const ids    = merged.map(f => f.id);
    assert.ok(ids.includes("a"));
    assert.ok(ids.includes("b"));
    assert.ok(ids.includes("c"));
  });

  test("L1에 있는 파편(b)이 가장 높은 점수여야 한다", () => {
    const merged = mergeRRF(layers);
    assert.strictEqual(merged[0].id, "b");
  });

  test("중복 파편이 없어야 한다", () => {
    const merged = mergeRRF(layers);
    const ids    = merged.map(f => f.id);
    assert.strictEqual(ids.length, new Set(ids).size);
  });

  test("빈 L1으로도 동작해야 한다", () => {
    assert.doesNotThrow(() => mergeRRF([
      { name: "l1", results: [],         weightFactor: 2.0 },
      { name: "l2", results: l2Results,  weightFactor: 1.0 },
      { name: "l3", results: l3Results,  weightFactor: 1.0 },
    ]));
  });
});

describe("resolveRrfLayerWeights", () => {
  test("text-only 경로는 기본 L3 가중치를 유지해야 한다", () => {
    const weights = resolveRrfLayerWeights({ text: "explain deployment failure" }, {
      l1WeightFactor: 2.0,
      l2WeightFactor: 1.0,
      l3WeightFactor: 1.0,
      graphWeightFactor: 1.5,
      mixed: {
        l1WeightFactor: 2.5,
        l2WeightFactor: 1.7,
        l3WeightFactor: 0.6,
        graphWeightFactor: 1.5
      }
    });

    assert.deepStrictEqual(weights, { l1: 2.0, l2: 1.0, graph: 1.5, l3: 1.0 });
  });

  test("mixed text+keywords 경로는 L1/L2를 올리고 L3를 낮춰야 한다", () => {
    const weights = resolveRrfLayerWeights({ text: "deploy failure", keywords: ["deploy"] }, {
      l1WeightFactor: 2.0,
      l2WeightFactor: 1.0,
      l3WeightFactor: 1.0,
      graphWeightFactor: 1.5,
      mixed: {
        l1WeightFactor: 2.5,
        l2WeightFactor: 1.7,
        l3WeightFactor: 0.6,
        graphWeightFactor: 1.5
      }
    });

    assert.deepStrictEqual(weights, { l1: 2.5, l2: 1.7, graph: 1.5, l3: 0.6 });
  });

  test("topic+text mixed 경로도 구조화 신호 가중치를 적용해야 한다", () => {
    const weights = resolveRrfLayerWeights({ text: "latency", topic: "memento" }, {
      l1WeightFactor: 2.0,
      l2WeightFactor: 1.0,
      l3WeightFactor: 1.0,
      graphWeightFactor: 1.5,
      mixed: { l2WeightFactor: 1.6, l3WeightFactor: 0.7 }
    });

    assert.equal(weights.l1, 2.0);
    assert.equal(weights.l2, 1.6);
    assert.equal(weights.l3, 0.7);
    assert.equal(weights.graph, 1.5);
  });

  test("type filter alone must keep text-only semantic weighting", () => {
    const weights = resolveRrfLayerWeights({ text: "why did it fail", type: "error" }, {
      l1WeightFactor: 2.0,
      l2WeightFactor: 1.0,
      l3WeightFactor: 1.0,
      graphWeightFactor: 1.5,
      mixed: {
        l1WeightFactor: 2.5,
        l2WeightFactor: 1.7,
        l3WeightFactor: 0.6,
        graphWeightFactor: 1.5
      }
    });

    assert.deepStrictEqual(weights, { l1: 2.0, l2: 1.0, graph: 1.5, l3: 1.0 });
  });
});

describe("L3 latency guards", () => {
  test("resolveL3SearchOptions clamps invalid values", () => {
    const options = resolveL3SearchOptions({
      timeoutMs: -1,
      statementTimeoutMs: 999999,
      hnswEfSearch: 0
    });

    assert.deepStrictEqual(options, {
      timeoutMs: 1,
      statementTimeoutMs: 120000,
      hnswEfSearch: 1
    });
  });

  test("withTimeout returns fallback on deadline", async () => {
    const value = await withTimeout(
      new Promise(resolve => setTimeout(() => resolve("late"), 25)),
      1,
      []
    );

    assert.deepStrictEqual(value, []);
  });
});
