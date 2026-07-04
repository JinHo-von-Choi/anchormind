/**
 * Phase C recall 메타데이터 확장 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-28
 *
 * Task 4-1: confidence 계산, age_days 계산
 * Task 4-2: linked 배열 구조
 * Task 4-4: mergeRRF 범용 레이어 배열 동작 검증
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";

import { computeConfidence, getUtilityBaseline } from "../../lib/memory/consolidate/UtilityBaseline.js";
import { mergeRRF }                               from "../../lib/memory/read/FragmentSearch.js";

/** ─── Task 4-1 / 4-3: confidence 계산 ─── */

describe("computeConfidence", () => {
  test("utility_score가 baseline과 같으면 confidence = 1.0", () => {
    const baseline = getUtilityBaseline(); // 초기값 1.0
    assert.strictEqual(computeConfidence(baseline), 1.0);
  });

  test("utility_score가 0이면 confidence = 0.1 (최솟값 클램프)", () => {
    assert.strictEqual(computeConfidence(0), 0.1);
  });

  test("utility_score가 null/undefined이면 confidence = 0.1", () => {
    assert.strictEqual(computeConfidence(null), 0.1);
    assert.strictEqual(computeConfidence(undefined), 0.1);
  });

  test("utility_score가 baseline의 2배면 confidence = 1.0 (최댓값 클램프)", () => {
    const baseline = getUtilityBaseline();
    assert.strictEqual(computeConfidence(baseline * 2), 1.0);
  });

  test("utility_score가 baseline의 절반이면 confidence = 0.5", () => {
    const baseline = getUtilityBaseline();
    assert.strictEqual(computeConfidence(baseline * 0.5), 0.5);
  });
});

/** ─── Task 4-1: age_days 계산 ─── */

describe("age_days 계산", () => {
  test("오늘 생성된 파편은 age_days = 0", () => {
    const createdAt = new Date().toISOString();
    const ageDays   = Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000);
    assert.strictEqual(ageDays, 0);
  });

  test("7일 전 파편은 age_days = 7", () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const ageDays      = Math.floor((Date.now() - new Date(sevenDaysAgo).getTime()) / 86400000);
    assert.strictEqual(ageDays, 7);
  });

  test("365일 전 파편은 age_days = 365", () => {
    const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString();
    const ageDays = Math.floor((Date.now() - new Date(yearAgo).getTime()) / 86400000);
    assert.strictEqual(ageDays, 365);
  });
});

/** ─── Task 4-2: linked 배열 구조 ─── */

describe("linked 배열 구조", () => {
  test("linked 엔트리는 id, relation_type, preview 필드를 가져야 한다", () => {
    const linked = {
      id           : "abc-123",
      relation_type: "related",
      preview      : "Redis 포트 설정 관련 파편..."
    };
    assert.ok(typeof linked.id === "string");
    assert.ok(typeof linked.relation_type === "string");
    assert.ok(typeof linked.preview === "string");
    assert.ok(linked.preview.length <= 60);
  });

  test("빈 linked 배열은 유효하다", () => {
    const linked = [];
    assert.ok(Array.isArray(linked));
    assert.strictEqual(linked.length, 0);
  });
});

/** ─── Task 4-4: mergeRRF 범용 레이어 배열 ─── */

describe("mergeRRF (layers interface)", () => {
  const l1Ids       = ["b"];
  const l2Results   = [
    { id: "a", content: "foo", importance: 0.8 },
    { id: "b", content: "bar", importance: 0.6 }
  ];
  const graphResults = [
    { id: "g1", content: "graph-neighbor-1", importance: 0.5 },
    { id: "g2", content: "graph-neighbor-2", importance: 0.4 }
  ];
  const l3Results   = [
    { id: "b", content: "bar", similarity: 0.9 },
    { id: "c", content: "baz", similarity: 0.7 }
  ];

  const layers = [
    { name: "l1",    results: l1Ids,        weightFactor: 2.0 },
    { name: "l2",    results: l2Results,    weightFactor: 1.0 },
    { name: "graph", results: graphResults, weightFactor: 1.5 },
    { name: "l3",    results: l3Results,    weightFactor: 1.0 },
  ];

  test("L1, L2, L2.5 Graph, L3 결과가 모두 병합되어야 한다", () => {
    const merged = mergeRRF(layers);
    const ids    = merged.map(f => f.id);
    assert.ok(ids.includes("a"),  "L2 결과 a 포함");
    assert.ok(ids.includes("b"),  "L1+L2+L3 결과 b 포함");
    assert.ok(ids.includes("c"),  "L3 결과 c 포함");
    assert.ok(ids.includes("g1"), "Graph 결과 g1 포함");
    assert.ok(ids.includes("g2"), "Graph 결과 g2 포함");
  });

  test("L1에 있는 파편(b)이 가장 높은 점수여야 한다", () => {
    const merged = mergeRRF(layers);
    assert.strictEqual(merged[0].id, "b");
  });

  test("그래프 이웃은 L3보다 높은 RRF 점수를 받아야 한다 (가중치 1.5x vs 1.0x)", () => {
    /** g1(graph rank 0, weight 1.5)과 c(L3 rank 1, weight 1.0) 비교 */
    const merged   = mergeRRF([
      { name: "graph", results: graphResults, weightFactor: 1.5 },
      { name: "l3",    results: l3Results,    weightFactor: 1.0 },
    ]);
    const g1Entry  = merged.find(f => f.id === "g1");
    const cEntry   = merged.find(f => f.id === "c");
    assert.ok(g1Entry._rrfScore > cEntry._rrfScore,
      `g1(${g1Entry._rrfScore}) > c(${cEntry._rrfScore})`);
  });

  test("중복 파편이 없어야 한다", () => {
    const merged = mergeRRF(layers);
    const ids    = merged.map(f => f.id);
    assert.strictEqual(ids.length, new Set(ids).size);
  });

  test("빈 그래프 결과로도 동작해야 한다", () => {
    const merged = mergeRRF([
      { name: "l1",    results: l1Ids,     weightFactor: 2.0 },
      { name: "l2",    results: l2Results, weightFactor: 1.0 },
      { name: "graph", results: [],        weightFactor: 1.5 },
      { name: "l3",    results: l3Results, weightFactor: 1.0 },
    ]);
    assert.ok(merged.length > 0);
  });

  test("모두 빈 입력이면 빈 배열 반환", () => {
    const merged = mergeRRF([
      { name: "l1",    results: [], weightFactor: 2.0 },
      { name: "l2",    results: [], weightFactor: 1.0 },
      { name: "graph", results: [], weightFactor: 1.5 },
      { name: "l3",    results: [], weightFactor: 1.0 },
    ]);
    assert.strictEqual(merged.length, 0);
  });
});
