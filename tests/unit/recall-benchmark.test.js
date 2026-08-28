/**
 * RecallBenchmark 순수 함수 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { readFileSync }   from "node:fs";
import path               from "node:path";
import { fileURLToPath }  from "node:url";

import {
  computeRecallAt,
  computeMRR,
  percentile,
  summarize,
  compareToBaseline,
  validateGoldsetEntry,
  validateGoldset,
  QUERY_CLASSES,
} from "../../lib/memory/signals/RecallBenchmark.js";

const here     = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

describe("computeRecallAt", () => {
  test("k 이내 순위만 적중으로 센다", () => {
    assert.equal(computeRecallAt([1, 3, 6, null], 5), 0.5);
    assert.equal(computeRecallAt([1, 1, 1, 1], 1), 1);
    assert.equal(computeRecallAt([2, 2], 1), 0);
  });

  test("미검출(null)은 분모에 포함된다", () => {
    assert.equal(computeRecallAt([1, null], 5), 0.5);
  });

  test("빈 입력은 null", () => {
    assert.equal(computeRecallAt([], 5), null);
    assert.equal(computeRecallAt(null, 5), null);
  });

  test("0이나 음수 순위는 적중으로 세지 않는다", () => {
    assert.equal(computeRecallAt([0, -1], 5), 0);
  });
});

describe("computeMRR", () => {
  test("순위 역수의 평균을 낸다", () => {
    assert.equal(computeMRR([1, 2]), 0.75);
    assert.equal(computeMRR([1, 1]), 1);
  });

  test("미검출은 기여도 0이지만 분모에는 남는다", () => {
    assert.equal(computeMRR([1, null]), 0.5);
  });

  test("빈 입력은 null", () => {
    assert.equal(computeMRR([]), null);
  });
});

describe("percentile", () => {
  test("nearest-rank 방식으로 산출한다", () => {
    assert.equal(percentile([10, 20, 30, 40], 50), 20);
    assert.equal(percentile([10, 20, 30, 40], 100), 40);
    assert.equal(percentile([5], 95), 5);
  });

  test("입력 배열을 변형하지 않는다", () => {
    const input = [3, 1, 2];
    percentile(input, 50);
    assert.deepEqual(input, [3, 1, 2]);
  });

  test("빈 입력은 null", () => {
    assert.equal(percentile([], 50), null);
  });
});

describe("summarize", () => {
  const rows = [
    { id: "a", queryClass: "exact_symbol",   rank: 1,    latencyMs: 100 },
    { id: "b", queryClass: "exact_symbol",   rank: 4,    latencyMs: 200 },
    { id: "c", queryClass: "concept_intent", rank: null, latencyMs: 300 },
    { id: "d", queryClass: "concept_intent", rank: 2,    latencyMs: 400 },
  ];

  test("전체 지표와 클래스별 분해를 함께 낸다", () => {
    const m = summarize(rows);
    assert.equal(m.cases, 4);
    assert.equal(m.offline_recall_at_1, 0.25);
    assert.equal(m.offline_recall_at_5, 0.75);
    assert.equal(m.misses, 1);
    assert.equal(m.by_query_class.exact_symbol.cases, 2);
    assert.equal(m.by_query_class.exact_symbol.offline_recall_at_5, 1);
    assert.equal(m.by_query_class.concept_intent.offline_recall_at_5, 0.5);
  });

  test("표본이 없는 클래스는 분해 결과에 넣지 않는다", () => {
    const m = summarize(rows);
    assert.equal(m.by_query_class.temporal, undefined);
  });

  test("hit_rate@5는 recall@5와 같은 정의를 쓴다", () => {
    const m = summarize(rows);
    assert.equal(m.offline_hit_rate_at_5, m.offline_recall_at_5);
  });

  test("지연 백분위를 포함한다", () => {
    const m = summarize(rows);
    assert.equal(m.latency_ms.p50, 200);
    assert.equal(m.latency_ms.max, 400);
  });
});

describe("compareToBaseline", () => {
  const baseline = {
    offline_recall_at_5: 0.80,
    offline_mrr        : 0.60,
    latency_ms         : { p95: 100 },
  };

  test("허용 오차 안의 하락은 회귀로 보지 않는다", () => {
    const r = compareToBaseline(baseline, { offline_recall_at_5: 0.785, offline_mrr: 0.60, latency_ms: { p95: 105 } });
    assert.equal(r.regressed, false);
  });

  test("적재 간 변동폭(1pp)은 회귀로 보지 않는다", () => {
    const r = compareToBaseline(baseline, { offline_recall_at_5: 0.79, offline_mrr: 0.60, latency_ms: { p95: 100 } });
    assert.equal(r.regressed, false);
  });

  test("허용치를 좁히면 같은 하락도 회귀로 잡는다", () => {
    const r = compareToBaseline(
      baseline,
      { offline_recall_at_5: 0.79, offline_mrr: 0.60, latency_ms: { p95: 100 } },
      { recallTolerance: 0.005 }
    );
    assert.equal(r.regressed, true);
  });

  test("허용 오차를 넘는 하락은 회귀로 판정한다", () => {
    const r = compareToBaseline(baseline, { offline_recall_at_5: 0.70, offline_mrr: 0.60, latency_ms: { p95: 100 } });
    assert.equal(r.regressed, true);
    assert.ok(r.reasons.some(x => x.includes("offline_recall_at_5")));
  });

  test("지연 증가율이 허용치를 넘으면 회귀로 판정한다", () => {
    const r = compareToBaseline(baseline, { offline_recall_at_5: 0.80, offline_mrr: 0.60, latency_ms: { p95: 200 } });
    assert.equal(r.regressed, true);
    assert.ok(r.reasons.some(x => x.includes("latency")));
  });

  test("개선은 회귀가 아니며 delta가 양수로 기록된다", () => {
    const r = compareToBaseline(baseline, { offline_recall_at_5: 0.90, offline_mrr: 0.70, latency_ms: { p95: 90 } });
    assert.equal(r.regressed, false);
    assert.ok(r.deltas.offline_recall_at_5 > 0);
  });
});

describe("validateGoldsetEntry", () => {
  const valid = { id: "x-1", store: "저장문", query: "질의문", query_class: "hybrid" };

  test("정상 항목은 오류가 없다", () => {
    assert.deepEqual(validateGoldsetEntry(valid, 0), []);
  });

  test("필수 필드 누락을 잡는다", () => {
    assert.ok(validateGoldsetEntry({ ...valid, store: undefined }, 0).length > 0);
    assert.ok(validateGoldsetEntry({ ...valid, query: undefined }, 0).length > 0);
    assert.ok(validateGoldsetEntry({ ...valid, id: undefined }, 0).length > 0);
  });

  test("허용되지 않는 query_class를 잡는다", () => {
    assert.ok(validateGoldsetEntry({ ...valid, query_class: "unknown" }, 0).length > 0);
  });

  test("store와 query가 같으면 오류다", () => {
    assert.ok(validateGoldsetEntry({ ...valid, query: valid.store }, 0).length > 0);
  });
});

describe("validateGoldset", () => {
  test("id 중복을 잡는다", () => {
    const dup = [
      { id: "a", store: "s1", query: "q1", query_class: "hybrid" },
      { id: "a", store: "s2", query: "q2", query_class: "hybrid" },
    ];
    assert.ok(validateGoldset(dup).some(e => e.includes("중복")));
  });

  test("빈 골드셋은 오류다", () => {
    assert.ok(validateGoldset([]).length > 0);
  });
});

describe("동봉 골드셋 파일", () => {
  const lines = readFileSync(path.join(repoRoot, "tests/fixtures/recall-goldset.jsonl"), "utf-8")
    .split("\n").map(l => l.trim()).filter(Boolean);
  const goldset = lines.map(l => JSON.parse(l));

  test("100건 이상이며 검증을 통과한다", () => {
    assert.ok(goldset.length >= 100, `골드셋 ${goldset.length}건`);
    assert.deepEqual(validateGoldset(goldset), []);
  });

  test("네 가지 query_class를 모두 포함한다", () => {
    const present = new Set(goldset.map(g => g.query_class));
    for (const cls of QUERY_CLASSES) {
      assert.ok(present.has(cls), `${cls} 표본 없음`);
    }
  });

  test("저장문이 서로 중복되지 않는다", () => {
    const stores = goldset.map(g => g.store);
    assert.equal(new Set(stores).size, stores.length);
  });
});
