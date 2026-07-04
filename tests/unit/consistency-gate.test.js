/**
 * consistency-gate.test.js
 *
 * 작성자: 최진호
 * 작성일: 2026-04-27
 *
 * Phase 4 Consistency Gate 단위 테스트:
 *  1. morpheme_indexed=false 파편 — keywords 검색(searchByKeywords SQL) morpheme_indexed 조건 없음
 *  2. morpheme_indexed=true  — searchBySemantic morphemeOnly=true → SQL에 조건 포함
 *  3. morphemeOnly=false → SQL에 조건 없음
 *  4. morphemeOnly=true + keyId → 두 조건 모두 포함
 *
 * 검증 방식: db.js queryWithAgentVector를 mock하여 생성된 SQL 문자열을 캡처.
 */

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

/* ------------------------------------------------------------------ */
/*  Captured SQL tracker                                                */
/* ------------------------------------------------------------------ */

let capturedSql    = "";
let capturedParams = [];

const queryWithAgentVectorMock = mock.fn(async (_agentId, sql, params) => {
  capturedSql    = sql;
  capturedParams = params ?? [];
  return { rows: [] };
});

/* ------------------------------------------------------------------ */
/*  Module mocks (반드시 import 전에 등록)                               */
/* ------------------------------------------------------------------ */

mock.module("../../lib/tools/db.js", {
  namedExports: {
    queryWithAgentVector : queryWithAgentVectorMock,
    getPrimaryPool       : mock.fn(() => null),
    shutdownPool         : mock.fn(async () => {}),
  }
});

mock.module("../../lib/tools/embedding.js", {
  namedExports: {
    vectorToSql              : mock.fn(v => JSON.stringify(v)),
    EMBEDDING_ENABLED        : true,
    generateEmbedding        : mock.fn(async () => [0.1, 0.2, 0.3]),
    generateBatchEmbeddings  : mock.fn(async (ts) => ts.map(() => [0.1, 0.2, 0.3])),
    EMBEDDING_PROVIDER       : "openai",
    EMBEDDING_SUPPORTS_DIMS_PARAM: false,
    EMBEDDING_DIMENSIONS     : null,
    EMBEDDING_MODEL          : "text-embedding-3-small",
    prepareTextForEmbedding  : mock.fn(t => t),
    EMBEDDING_API_KEY        : "test",
    OPENAI_API_KEY           : "test",
  }
});

mock.module("../../lib/logger.js", {
  namedExports: {
    logInfo : mock.fn(),
    logWarn : mock.fn(),
    logError: mock.fn(),
  }
});

mock.module("../../config/memory.js", {
  namedExports: {
    MEMORY_CONFIG: {
      morphemeIndex   : { maxMorphemes: 10 },
      semanticSearch  : { minSimilarity: 0.35, limit: 10 },
    }
  }
});

/* ------------------------------------------------------------------ */
/*  Import after mocks                                                  */
/* ------------------------------------------------------------------ */

const { FragmentReader } = await import("../../lib/memory/read/FragmentReader.js");

/* ------------------------------------------------------------------ */
/*  Tests                                                               */
/* ------------------------------------------------------------------ */

describe("Consistency Gate — morpheme_indexed SQL 조건 검증", () => {

  test("morphemeOnly=false → SQL에 morpheme_indexed 조건 없음", async () => {
    capturedSql = "";
    const reader = new FragmentReader();
    await reader.searchBySemantic(
      [0.1, 0.2, 0.3],
      10, 0.3, "default", null,
      false, null, null, null,
      false  /* morphemeOnly */
    ).catch(() => {});

    assert.ok(capturedSql.length > 0, "SQL이 캡처되어야 함");
    assert.ok(!capturedSql.includes("morpheme_indexed"),
      "morphemeOnly=false 시 morpheme_indexed 조건 미포함");
  });

  test("morphemeOnly=true → SQL에 morpheme_indexed = true 조건 포함", async () => {
    capturedSql = "";
    const reader = new FragmentReader();
    await reader.searchBySemantic(
      [0.1, 0.2, 0.3],
      10, 0.3, "default", null,
      false, null, null, null,
      true   /* morphemeOnly */
    ).catch(() => {});

    assert.ok(capturedSql.length > 0, "SQL이 캡처되어야 함");
    assert.ok(
      capturedSql.includes("morpheme_indexed = true"),
      `morphemeOnly=true 시 morpheme_indexed = true 조건 포함 (캡처된 SQL: ${capturedSql.slice(0, 200)})`
    );
  });

  test("morphemeOnly=true + keyId → 두 조건 모두 포함", async () => {
    capturedSql = "";
    const reader = new FragmentReader();
    await reader.searchBySemantic(
      [0.1, 0.2, 0.3],
      5, 0.4, "default", "key-abc",
      false, null, null, null,
      true   /* morphemeOnly */
    ).catch(() => {});

    assert.ok(capturedSql.includes("morpheme_indexed = true"), "morpheme_indexed 조건 포함");
    assert.ok(capturedSql.includes("key_id"), "keyId 격리 조건 포함");
  });

  test("searchByKeywords — SQL에 morpheme_indexed 조건 없음", async () => {
    capturedSql = "";
    const reader = new FragmentReader();
    await reader.searchByKeywords(
      ["테스트", "키워드"],
      { agentId: "default", limit: 10 }
    ).catch(() => {});

    assert.ok(!capturedSql.includes("morpheme_indexed"),
      "키워드 검색 경로에 morpheme_indexed 조건 없음");
  });
});
