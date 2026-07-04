/**
 * morpheme-batch.test.js
 *
 * 작성자: 최진호
 * 작성일: 2026-04-27
 *
 * Phase 4: MorphemeIndex 배치 임베딩 + multi-row INSERT 단위 테스트
 *
 * 검증 대상:
 *  1. 50개 missing 형태소 → generateBatchEmbeddings 1회 호출 + pool.query INSERT 1회
 *  2. 이미 등록된 형태소는 배치 대상에서 제외
 *  3. 빈 문자열/null 포함 입력 사전 검증 통과
 *  4. generateBatchEmbeddings HTTP 400 (Invalid 'input[N]') → 문제 항목 격리 후 재시도
 *  5. 인덱스 미명시 에러 → 단건 fallback generateEmbedding 호출
 *  6. 입력 순서 보존 (반환 vectors[] 순서)
 */

import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/* ------------------------------------------------------------------ */
/*  Module mocks                                                        */
/* ------------------------------------------------------------------ */

const batchEmbedFn   = mock.fn();
const singleEmbedFn  = mock.fn();
const vectorToSqlFn  = mock.fn(v => JSON.stringify(v));

mock.module("../../lib/tools/embedding.js", {
  namedExports: {
    generateBatchEmbeddings : batchEmbedFn,
    generateEmbedding       : singleEmbedFn,
    vectorToSql             : vectorToSqlFn,
    EMBEDDING_ENABLED       : true,
    EMBEDDING_PROVIDER      : "openai",
  }
});

mock.module("../../config/memory.js", {
  namedExports: {
    MEMORY_CONFIG: { morphemeIndex: { maxMorphemes: 10 } }
  }
});

mock.module("../../lib/logger.js", {
  namedExports: {
    logInfo : mock.fn(),
    logWarn : mock.fn(),
    logError: mock.fn(),
  }
});

/* ------------------------------------------------------------------ */
/*  pool stub factory                                                   */
/* ------------------------------------------------------------------ */

/**
 * pg Pool 스텁.
 * - SELECT query (morpheme_dict 조회): existingRows 반환
 * - INSERT query: insertCalls에 기록
 */
function makePool(existingRows = []) {
  const insertCalls = [];
  const pool = {
    query: mock.fn(async (sql, params) => {
      if (/INSERT/i.test(sql)) {
        insertCalls.push({ sql, params });
        return { rowCount: params ? Math.floor(params.length / 2) : 0 };
      }
      /** SELECT — morpheme_dict 조회 */
      return { rows: existingRows };
    }),
    _insertCalls: insertCalls,
  };
  return pool;
}

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: mock.fn(() => null), /* 기본값 null, 테스트에서 교체 */
  }
});

/* ------------------------------------------------------------------ */
/*  Import after mocks                                                  */
/* ------------------------------------------------------------------ */

const { MorphemeIndex } = await import("../../lib/memory/embedding/MorphemeIndex.js");
const { getPrimaryPool } = await import("../../lib/tools/db.js");

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/** 더미 벡터 생성 */
const makeVec = (seed) => [seed, seed + 0.1, seed + 0.2];

const resetMocks = () => {
  batchEmbedFn.mock.resetCalls();
  singleEmbedFn.mock.resetCalls();
  vectorToSqlFn.mock.resetCalls();
};

/* ------------------------------------------------------------------ */
/*  Tests                                                               */
/* ------------------------------------------------------------------ */

describe("MorphemeIndex — Phase 4 배치 임베딩 + multi-row INSERT", () => {

  beforeEach(() => resetMocks());

  test("50개 missing 형태소 → generateBatchEmbeddings 1회 + INSERT 1회", async () => {
    const morphemes = Array.from({ length: 50 }, (_, i) => `형태소_${i}`);
    const vecs      = morphemes.map((_, i) => makeVec(i * 0.01));

    batchEmbedFn.mock.mockImplementation(async () => vecs);

    const pool = makePool([]); /* 기존 등록 없음 */
    getPrimaryPool.mock.mockImplementation(() => pool);

    const idx    = new MorphemeIndex();
    const result = await idx.getOrRegisterEmbeddings(morphemes);

    assert.equal(batchEmbedFn.mock.callCount(), 1, "generateBatchEmbeddings 1회 호출");
    assert.equal(singleEmbedFn.mock.callCount(), 0, "단건 embed 호출 없음");

    const insertCalls = pool._insertCalls.filter(c => /INSERT/i.test(c.sql));
    assert.equal(insertCalls.length, 1, "INSERT 1회");

    assert.equal(result.length, 50, "벡터 50개 반환");
  });

  test("이미 등록된 형태소는 배치 대상 제외", async () => {
    const existing   = [{ morpheme: "형태소_0", embedding: JSON.stringify(makeVec(0)) }];
    const morphemes  = ["형태소_0", "형태소_1"];
    const missingVec = [makeVec(1)];

    batchEmbedFn.mock.mockImplementation(async () => missingVec);

    const pool = makePool(existing);
    getPrimaryPool.mock.mockImplementation(() => pool);

    const idx    = new MorphemeIndex();
    const result = await idx.getOrRegisterEmbeddings(morphemes);

    /** 배치 호출 인자: missing만 포함 */
    assert.equal(batchEmbedFn.mock.callCount(), 1);
    const batchInput = batchEmbedFn.mock.calls[0].arguments[0];
    assert.deepEqual(batchInput, ["형태소_1"], "형태소_0은 이미 등록됐으므로 배치 제외");

    assert.equal(result.length, 2, "결과 2개 (기존 1 + 신규 1)");
  });

  test("빈 문자열/null 포함 입력 사전 검증 — valid 항목만 처리", async () => {
    const morphemes  = ["valid", "", null, "  ", "also_valid"];
    const vecs       = [makeVec(0.1), makeVec(0.2)];

    batchEmbedFn.mock.mockImplementation(async () => vecs);

    const pool = makePool([]);
    getPrimaryPool.mock.mockImplementation(() => pool);

    const idx    = new MorphemeIndex();
    const result = await idx.getOrRegisterEmbeddings(morphemes);

    const batchInput = batchEmbedFn.mock.calls[0].arguments[0];
    assert.deepEqual(batchInput, ["valid", "also_valid"], "valid 항목 2개만 배치 전달");

    assert.equal(result.length, 2, "valid 항목 2개의 벡터 반환");
  });

  test("generateBatchEmbeddings HTTP 400 Invalid 'input[N]' → 해당 인덱스 격리 후 재시도", async () => {
    const morphemes = ["good_0", "bad_1", "good_2"];
    /** 첫 호출: 400 에러 (input[1] 문제) */
    const err400 = new Error("Invalid 'input[1]': some_error");

    let callCount = 0;
    batchEmbedFn.mock.mockImplementation(async (batch) => {
      callCount++;
      if (callCount === 1) throw err400;
      /** 재시도 시 ["good_0","good_2"] 처리 */
      return batch.map((_, i) => makeVec(i));
    });

    const pool = makePool([]);
    getPrimaryPool.mock.mockImplementation(() => pool);

    const idx = new MorphemeIndex();
    /** 에러 없이 완료되어야 함 */
    await assert.doesNotReject(() => idx.getOrRegisterEmbeddings(morphemes));

    assert.equal(batchEmbedFn.mock.callCount(), 2, "첫 실패 + 재시도 = 2회");
  });

  test("인덱스 미명시 에러 → 단건 fallback generateEmbedding 호출", async () => {
    const morphemes = ["a", "b", "c"];
    batchEmbedFn.mock.mockImplementation(async () => {
      throw new Error("network timeout");
    });
    singleEmbedFn.mock.mockImplementation(async (m) => makeVec(m.charCodeAt(0) * 0.01));

    const pool = makePool([]);
    getPrimaryPool.mock.mockImplementation(() => pool);

    const idx = new MorphemeIndex();
    await assert.doesNotReject(() => idx.getOrRegisterEmbeddings(morphemes));

    assert.equal(singleEmbedFn.mock.callCount(), 3, "단건 fallback 3회");
  });

  test("반환 vectors[] 입력 순서 보존", async () => {
    const morphemes = ["m0", "m1", "m2"];
    const vecs      = morphemes.map((_, i) => makeVec(i));

    batchEmbedFn.mock.mockImplementation(async () => vecs);

    const pool = makePool([]);
    getPrimaryPool.mock.mockImplementation(() => pool);

    const idx    = new MorphemeIndex();
    const result = await idx.getOrRegisterEmbeddings(morphemes);

    assert.equal(result.length, 3);
    for (let i = 0; i < morphemes.length; i++) {
      assert.deepEqual(result[i], vecs[i], `인덱스 ${i} 순서 보존`);
    }
  });
});
