/**
 * validate-memory-config.js 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-04
 */

import { describe, it } from "node:test";
import assert            from "node:assert/strict";
import { validateMemoryConfig } from "../../config/validate-memory-config.js";
import { MEMORY_CONFIG }        from "../../config/memory.js";

describe("validateMemoryConfig", () => {
  it("현행 MEMORY_CONFIG는 검증을 통과한다", () => {
    assert.doesNotThrow(() => validateMemoryConfig(MEMORY_CONFIG));
  });

  it("ranking weights 합계가 1.0이 아니면 에러", () => {
    const bad = structuredClone(MEMORY_CONFIG);
    bad.ranking.importanceWeight = 0.9;
    assert.throws(() => validateMemoryConfig(bad), /ranking weights.*sum.*1\.0/i);
  });

  it("rankWeights 합계가 1.0이 아니면 에러", () => {
    const bad = structuredClone(MEMORY_CONFIG);
    bad.contextInjection.rankWeights.importance = 0.9;
    assert.throws(() => validateMemoryConfig(bad), /rankWeights.*sum.*1\.0/i);
  });

  it("minSimilarity가 0~1 범위 밖이면 에러", () => {
    const bad = structuredClone(MEMORY_CONFIG);
    bad.semanticSearch.minSimilarity = 1.5;
    assert.throws(() => validateMemoryConfig(bad), /minSimilarity.*0.*1/i);
  });

  it("halfLifeDays 값이 0 이하이면 에러", () => {
    const bad = structuredClone(MEMORY_CONFIG);
    bad.halfLifeDays.fact = -1;
    assert.throws(() => validateMemoryConfig(bad), /halfLifeDays.*positive/i);
  });

  it("gc.gracePeriodDays >= gc.inactiveDays이면 에러", () => {
    const bad = structuredClone(MEMORY_CONFIG);
    bad.gc.gracePeriodDays = 100;
    bad.gc.inactiveDays    = 10;
    assert.throws(() => validateMemoryConfig(bad), /gracePeriodDays.*inactiveDays/i);
  });

  it("양수 정수가 아닌 값이면 에러", () => {
    const bad = structuredClone(MEMORY_CONFIG);
    bad.embeddingWorker.batchSize = 0;
    assert.throws(() => validateMemoryConfig(bad), /positive integer/i);
  });
});
