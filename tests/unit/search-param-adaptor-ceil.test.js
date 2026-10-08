/**
 * SearchParamAdaptor: MEMENTO_RECALL_MIN_SIM_CEIL 옵트인 상한
 *
 * 학습값이 CLAMP_MAX(0.60)에 고착된 행을 상한 값으로 낮춰 돌려주는지, 미설정이면 기존 동작인지,
 * 하한과 같이 있으면 하한이 우선인지 본다.
 */

import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

const mockQuery = mock.fn();
const mockPool  = { query: mockQuery };

mock.module("../../lib/tools/db.js",     { namedExports: { getPrimaryPool: () => mockPool } });
mock.module("../../lib/logger.js",       { namedExports: { logWarn: mock.fn() } });
mock.module("../../config/memory.js",    { namedExports: { MEMORY_CONFIG: { semanticSearch: { minSimilarity: 0.40 } } } });

const { SearchParamAdaptor, _resetForTesting } = await import("../../lib/memory/signals/SearchParamAdaptor.js");

const row = (sim, samples) => () => Promise.resolve({ rows: [{ min_similarity: sim, sample_count: samples }] });

describe("SearchParamAdaptor — MEMENTO_RECALL_MIN_SIM_CEIL", () => {
  beforeEach(() => { mockQuery.mock.resetCalls(); _resetForTesting(); });
  afterEach(() => { delete process.env.MEMENTO_RECALL_MIN_SIM_CEIL; delete process.env.MEMENTO_RECALL_MIN_SIM_FLOOR; });

  test("미설정이면 고착된 학습값 0.60을 그대로 돌려준다", async () => {
    mockQuery.mock.mockImplementationOnce(row(0.60, 500));
    assert.equal(await new SearchParamAdaptor().getMinSimilarity("k", "text", 3), 0.60);
  });

  test("상한 0.40이면 학습값 0.60을 0.40으로 낮춘다", async () => {
    process.env.MEMENTO_RECALL_MIN_SIM_CEIL = "0.40";
    mockQuery.mock.mockImplementationOnce(row(0.60, 500));
    assert.equal(await new SearchParamAdaptor().getMinSimilarity("k", "text", 3), 0.40);
  });

  test("상한보다 낮은 학습값은 건드리지 않는다", async () => {
    process.env.MEMENTO_RECALL_MIN_SIM_CEIL = "0.40";
    mockQuery.mock.mockImplementationOnce(row(0.25, 500));
    assert.equal(await new SearchParamAdaptor().getMinSimilarity("k", "text", 3), 0.25);
  });

  test("표본 부족(기본값 경로)에도 상한을 적용한다", async () => {
    process.env.MEMENTO_RECALL_MIN_SIM_CEIL = "0.30";
    mockQuery.mock.mockImplementationOnce(row(0.55, 10));
    assert.equal(await new SearchParamAdaptor().getMinSimilarity("k", "text", 3), 0.30);
  });

  test("하한과 상한이 모두 있으면 하한이 우선한다", async () => {
    process.env.MEMENTO_RECALL_MIN_SIM_CEIL  = "0.40";
    process.env.MEMENTO_RECALL_MIN_SIM_FLOOR = "0.45";
    mockQuery.mock.mockImplementationOnce(row(0.60, 500));
    assert.equal(await new SearchParamAdaptor().getMinSimilarity("k", "text", 3), 0.45);
  });

  test("숫자가 아닌 값은 무시한다", async () => {
    process.env.MEMENTO_RECALL_MIN_SIM_CEIL = "abc";
    mockQuery.mock.mockImplementationOnce(row(0.60, 500));
    assert.equal(await new SearchParamAdaptor().getMinSimilarity("k", "text", 3), 0.60);
  });

  test("DB 풀이 오류를 던지면 기본값에 상한을 적용해 돌려준다", async () => {
    process.env.MEMENTO_RECALL_MIN_SIM_CEIL = "0.30";
    mockQuery.mock.mockImplementationOnce(() => Promise.reject(new Error("db down")));
    assert.equal(await new SearchParamAdaptor().getMinSimilarity("k", "text", 3), 0.30);
  });
});
