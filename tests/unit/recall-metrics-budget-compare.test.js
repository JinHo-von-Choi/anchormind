/**
 * 검색 지표 측정 스크립트의 예산 내 nDCG 비교 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 데이터베이스와 임베딩에 접속하지 않는다. 지표 행은 F1의 scoreQuery로 만들고, 비교는
 * --compare --metric ndcg_at_budget 경로(짝지은 부트스트랩)로 낸다.
 */

import { test, describe, mock } from "node:test";
import assert                   from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir }               from "node:os";
import path                     from "node:path";

import {
  MeasureRefusalError, buildRecallParams, compareFiles, comparisonWarnings, metricOption, main
} from "../../scripts/measure/recall-metrics.mjs";
import { scoreQuery }      from "../../lib/memory/signals/RecallMetrics.js";
import { COMPARE_METRICS } from "../../lib/memory/signals/PairedBootstrap.js";

const BUDGET = 300;

/**
 * 질의 하나의 지표 행. 정답 r(등급 3, 100토큰)이 반환 목록의 rank 위치에 있다(0이면 없음).
 *
 * @param {string} id
 * @param {number} rank
 * @returns {Object}
 */
function rowFor(id, rank) {
  const entry    = { id, subset: "human_ko", tags: [], domain: null, distractors: [] };
  const relevant = new Map([["r", { grade: 3, tokens: 100 }]]);
  const fillers  = [{ id: "n1", tokens: 100 }, { id: "n2", tokens: 100 }];
  const returned = rank === 0 ? fillers : [...fillers.slice(0, rank - 1), { id: "r", tokens: 100 }, ...fillers.slice(rank - 1)];
  return scoreQuery({ entry, returned, relevant, budgetTokens: BUDGET });
}

const metricsDoc = (rows, params) => ({ schema: "recall-metrics/v1", embeddings: { mode: "off" }, params, rows });

async function withFiles(docs, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "recall-budget-compare-"));
  try {
    const paths = [];
    for (const [i, d] of docs.entries()) {
      const p = path.join(dir, `m${i}.json`);
      await writeFile(p, JSON.stringify(d));
      paths.push(p);
    }
    return await fn(paths);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("예산 내 nDCG 비교", () => {
  const ids       = Array.from({ length: 30 }, (_, i) => `q${i}`);
  const baseRows  = ids.map((id, i) => rowFor(id, i % 3 === 0 ? 0 : 3));
  const candRows  = ids.map((id, i) => rowFor(id, i % 3 === 0 ? 2 : 1));
  const baseParam = { token_budget: BUDGET, query_keywords: "whitespace", include_links: "off", rank_before_budget: "off" };
  const candParam = { ...baseParam, rank_before_budget: "on" };

  test("--metric ndcg_at_budget는 그 지표만 남기고 구간 값은 전체 비교와 같다", async () => {
    await withFiles([metricsDoc(baseRows, baseParam), metricsDoc(candRows, candParam)], async ([pa, pb]) => {
      const opts     = { iterations: 500, seed: 11, confidence: 0.95, minN: 10 };
      const full     = await compareFiles(pa, pb, opts);
      const filtered = await compareFiles(pa, pb, { ...opts, metric: "ndcg_at_budget" });

      assert.equal(filtered.metric, "ndcg_at_budget");
      assert.ok(filtered.comparisons.length > 0);
      assert.ok(filtered.comparisons.every(c => c.metric === "ndcg_at_budget"));
      assert.deepEqual(filtered.comparisons, full.comparisons.filter(c => c.metric === "ndcg_at_budget"));
      assert.equal(full.metric, undefined);

      const overall = filtered.comparisons.find(c => c.group === "overall");
      assert.equal(overall.n, ids.length);
      assert.ok(overall.mean_diff > 0);
      assert.ok(overall.ci_low > 0);
      assert.equal(overall.excludes_zero, true);
    });
  });

  test("rank_before_budget만 다른 두 실행은 경고하지 않는다", () => {
    assert.deepEqual(comparisonWarnings(metricsDoc([], baseParam), metricsDoc([], candParam)), []);
  });

  test("include_links가 다르면 경고한다", () => {
    const warnings = comparisonWarnings(metricsDoc([], baseParam), metricsDoc([], { ...candParam, include_links: "on" }));
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("include_links"));
  });

  test("main --compare --metric은 지정 지표만 파일에 쓴다", async () => {
    await withFiles([metricsDoc(baseRows, baseParam), metricsDoc(candRows, candParam)], async ([pa, pb]) => {
      const out  = path.join(path.dirname(pa), "out.json");
      const code = await main(["--compare", pa, pb, "--iterations", "50", "--metric", "ndcg_at_budget", "--out", out]);
      assert.equal(code, 0);
      const doc = JSON.parse(await readFile(out, "utf-8"));
      assert.equal(doc.metric, "ndcg_at_budget");
      assert.ok(doc.comparisons.every(c => c.metric === "ndcg_at_budget"));
    });
  });

  test("알 수 없는 --metric은 MeasureRefusalError로 거부한다", async () => {
    assert.equal(metricOption({}), null);
    for (const name of COMPARE_METRICS) assert.equal(metricOption({ metric: name }), name);
    assert.throws(() => metricOption({ metric: "ndcg" }), MeasureRefusalError);
    assert.throws(() => metricOption({ metric: true }), MeasureRefusalError);
    await withFiles([metricsDoc(baseRows, baseParam), metricsDoc(candRows, candParam)], async ([pa, pb]) => {
      const log = mock.method(console, "error", () => {});
      try {
        await assert.rejects(main(["--compare", pa, pb, "--metric", "nope"]), MeasureRefusalError);
      } finally {
        log.mock.restore();
      }
    });
  });

  test("recall 인자의 includeLinks는 기본 false이고 옵션으로 켠다", () => {
    const opts = { budgetTokens: 1000, pageSize: 10, keywordMode: "none" };
    assert.equal(buildRecallParams({ query: "예산" }, opts).includeLinks, false);
    assert.equal(buildRecallParams({ query: "예산" }, { ...opts, includeLinks: true }).includeLinks, true);
  });
});
