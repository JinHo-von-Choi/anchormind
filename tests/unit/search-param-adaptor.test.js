/**
 * SearchParamAdaptor 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 */

import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/** db.js, logger.js, config mock 등록 (SearchParamAdaptor import 전에 실행) */
const mockQuery = mock.fn();
const mockPool  = { query: mockQuery };

mock.module("../../lib/tools/db.js", {
  namedExports: { getPrimaryPool: () => mockPool }
});
mock.module("../../lib/logger.js", {
  namedExports: { logWarn: mock.fn() }
});
mock.module("../../config/memory.js", {
  namedExports: {
    MEMORY_CONFIG: { semanticSearch: { minSimilarity: 0.35 } }
  }
});

const { SearchParamAdaptor, _resetForTesting } = await import(
  "../../lib/memory/SearchParamAdaptor.js"
);

describe("SearchParamAdaptor", () => {
  beforeEach(() => {
    delete process.env.MEMENTO_SEARCH_PARAM_ADAPTOR_ENABLED;
    mockQuery.mock.resetCalls();
    _resetForTesting();
  });

  test("sample < MIN_SAMPLE(50)이면 default 0.35 반환", async () => {
    mockQuery.mock.mockImplementationOnce(() =>
      Promise.resolve({
        rows: [{ min_similarity: 0.40, sample_count: 10, total_result_count: 30 }]
      })
    );

    const adaptor = new SearchParamAdaptor();
    const result  = await adaptor.getMinSimilarity(null, "text", 10);

    assert.strictEqual(result, 0.35);
    // null -> '-1' (TEXT) 변환 확인 (migration-030: key_id INTEGER → TEXT)
    assert.strictEqual(mockQuery.mock.calls[0].arguments[1][0], "-1");
  });

  test("sample >= MIN_SAMPLE이면 학습된 값 반환", async () => {
    mockQuery.mock.mockImplementationOnce(() =>
      Promise.resolve({
        rows: [{ min_similarity: 0.28, sample_count: 60, total_result_count: 180 }]
      })
    );

    const adaptor = new SearchParamAdaptor();
    const result  = await adaptor.getMinSimilarity(42, "text", 14);

    assert.ok(
      Math.abs(result - 0.28) < 0.001,
      `expected ~0.28, got ${result}`
    );
  });

  test("DB 조회 실패 시 default 0.35 반환", async () => {
    mockQuery.mock.mockImplementationOnce(() =>
      Promise.reject(new Error("connection refused"))
    );

    const adaptor = new SearchParamAdaptor();
    const result  = await adaptor.getMinSimilarity(null, "keywords", 8);

    assert.strictEqual(result, 0.35);
  });

  test("recordOutcome: 단일 원자적 UPSERT 호출", async () => {
    mockQuery.mock.mockImplementationOnce(() =>
      Promise.resolve({ rowCount: 1 })
    );

    const adaptor = new SearchParamAdaptor();
    await adaptor.recordOutcome(null, "text", 10, 3);

    assert.strictEqual(mockQuery.mock.callCount(), 1);
    const [sql, params] = mockQuery.mock.calls[0].arguments;

    // 단일 UPSERT 패턴 확인 (SELECT 없음)
    assert.match(sql, /INSERT.*ON CONFLICT.*DO UPDATE/is);
    // key_id: null -> '-1' (TEXT) 변환 (migration-030: key_id INTEGER → TEXT)
    assert.strictEqual(params[0], "-1");
    assert.deepStrictEqual(params, ["-1", "text", 10, 0.35, 3]);
  });

  test("recordOutcome: DB 오류 시 예외 전파 없음", async () => {
    mockQuery.mock.mockImplementationOnce(() =>
      Promise.reject(new Error("disk full"))
    );

    const adaptor = new SearchParamAdaptor();
    // 예외가 전파되지 않아야 한다
    await adaptor.recordOutcome(42, "keywords", 15, 5);
  });

  test("disabled env: getMinSimilarity returns default without DB query", async () => {
    process.env.MEMENTO_SEARCH_PARAM_ADAPTOR_ENABLED = "false";

    const adaptor = new SearchParamAdaptor();
    const result  = await adaptor.getMinSimilarity(null, "text", 10);

    assert.strictEqual(result, 0.35);
    assert.strictEqual(mockQuery.mock.callCount(), 0);
  });

  test("disabled env: recordOutcome skips DB write", async () => {
    process.env.MEMENTO_SEARCH_PARAM_ADAPTOR_ENABLED = "off";

    const adaptor = new SearchParamAdaptor();
    await adaptor.recordOutcome(null, "text", 10, 3);

    assert.strictEqual(mockQuery.mock.callCount(), 0);
  });
});

/**
 * Phase 0 Task 0.4 회귀 테스트 — _normalizeKeyId 헬퍼 + array keyId 처리
 *
 * 커밋 2661394 (migration-030: key_id INTEGER → TEXT) +
 * 커밋 8f693b6 (_normalizeKeyId 헬퍼 도입) 이후
 * array keyId 입력 시 "integer 자료형 대한 잘못된 입력" 에러가
 * 발생하지 않음을 보장한다.
 *
 * _normalizeKeyId는 module-scope private 함수이므로 직접 export 없이
 * getMinSimilarity / recordOutcome 호출 결과로 우회 검증한다.
 */
describe("SearchParamAdaptor — array keyId 회귀 (Phase 0 Task 0.4)", () => {
  beforeEach(() => {
    delete process.env.MEMENTO_SEARCH_PARAM_ADAPTOR_ENABLED;
    mockQuery.mock.resetCalls();
    _resetForTesting();
  });

  // TC-1: null → '-1' sentinel (string, migration-030 TEXT 컬럼 호환)
  test("null keyId → '-1' string sentinel 전달", async () => {
    mockQuery.mock.mockImplementationOnce(() =>
      Promise.resolve({ rows: [] })
    );

    const adaptor = new SearchParamAdaptor();
    const result  = await adaptor.getMinSimilarity(null, "text", 10);

    assert.strictEqual(result, 0.35);
    const passedKeyId = mockQuery.mock.calls[0].arguments[1][0];
    assert.strictEqual(passedKeyId, "-1");
    assert.strictEqual(typeof passedKeyId, "string");
  });

  // TC-2: undefined → '-1' sentinel
  test("undefined keyId → '-1' string sentinel 전달", async () => {
    mockQuery.mock.mockImplementationOnce(() =>
      Promise.resolve({ rows: [] })
    );

    const adaptor = new SearchParamAdaptor();
    await adaptor.getMinSimilarity(undefined, "text", 10);

    const passedKeyId = mockQuery.mock.calls[0].arguments[1][0];
    assert.strictEqual(passedKeyId, "-1");
  });

  // TC-3: UUID string → 그대로 string 유지
  test("UUID string keyId → 동일 string 그대로 전달", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    mockQuery.mock.mockImplementationOnce(() =>
      Promise.resolve({ rows: [] })
    );

    const adaptor = new SearchParamAdaptor();
    await adaptor.getMinSimilarity(uuid, "keywords", 14);

    const passedKeyId = mockQuery.mock.calls[0].arguments[1][0];
    assert.strictEqual(passedKeyId, uuid);
    assert.strictEqual(typeof passedKeyId, "string");
  });

  // TC-4: array keyId → 첫 멤버 추출
  test("array keyId ['K1','K2','K3'] → 첫 멤버 'K1' 전달", async () => {
    mockQuery.mock.mockImplementationOnce(() =>
      Promise.resolve({ rows: [] })
    );

    const adaptor = new SearchParamAdaptor();
    await adaptor.getMinSimilarity(["K1", "K2", "K3"], "text", 8);

    const passedKeyId = mockQuery.mock.calls[0].arguments[1][0];
    assert.strictEqual(passedKeyId, "K1");
    assert.strictEqual(typeof passedKeyId, "string");
  });

  // TC-5: 빈 array → '-1' sentinel
  test("빈 array keyId [] → '-1' sentinel 전달", async () => {
    mockQuery.mock.mockImplementationOnce(() =>
      Promise.resolve({ rows: [] })
    );

    const adaptor = new SearchParamAdaptor();
    await adaptor.getMinSimilarity([], "text", 10);

    const passedKeyId = mockQuery.mock.calls[0].arguments[1][0];
    assert.strictEqual(passedKeyId, "-1");
  });

  // TC-6: 단일 UUID keyId로 getMinSimilarity — sample >= MIN_SAMPLE 시 학습값 반환
  test("단일 UUID keyId getMinSimilarity — sample 충분 시 학습된 유사도 반환", async () => {
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    mockQuery.mock.mockImplementationOnce(() =>
      Promise.resolve({
        rows: [{ min_similarity: 0.42, sample_count: 55, total_result_count: 220 }]
      })
    );

    const adaptor = new SearchParamAdaptor();
    const result  = await adaptor.getMinSimilarity(uuid, "text", 9);

    assert.ok(Math.abs(result - 0.42) < 0.001, `expected 0.42, got ${result}`);
    const passedKeyId = mockQuery.mock.calls[0].arguments[1][0];
    assert.strictEqual(passedKeyId, uuid);
  });

  // TC-7: 그룹 array keyId로 getMinSimilarity — 에러 없이 default 반환
  test("그룹 array keyId getMinSimilarity — 에러 없이 default 반환", async () => {
    mockQuery.mock.mockImplementationOnce(() =>
      Promise.resolve({ rows: [] })
    );

    const adaptor = new SearchParamAdaptor();
    const result  = await adaptor.getMinSimilarity(
      ["group-key-1", "group-key-2"], "keywords", 12
    );

    assert.strictEqual(result, 0.35);
    const passedKeyId = mockQuery.mock.calls[0].arguments[1][0];
    assert.strictEqual(passedKeyId, "group-key-1");
  });

  // TC-8: 단일 keyId recordOutcome — UPSERT 호출, string 전달
  test("단일 keyId recordOutcome — UPSERT 정상 호출 및 string keyId 전달", async () => {
    const uuid = "12345678-0000-0000-0000-000000000001";
    mockQuery.mock.mockImplementationOnce(() =>
      Promise.resolve({ rowCount: 1 })
    );

    const adaptor = new SearchParamAdaptor();
    await adaptor.recordOutcome(uuid, "text", 10, 4);

    assert.strictEqual(mockQuery.mock.callCount(), 1);
    const [sql, params] = mockQuery.mock.calls[0].arguments;
    assert.match(sql, /INSERT.*ON CONFLICT.*DO UPDATE/is);
    assert.strictEqual(params[0], uuid);
    assert.strictEqual(typeof params[0], "string");
  });

  // TC-9: array keyId recordOutcome — UPSERT 정상 호출, 첫 멤버 전달
  test("array keyId recordOutcome — UPSERT 정상 호출 및 첫 멤버 전달", async () => {
    mockQuery.mock.mockImplementationOnce(() =>
      Promise.resolve({ rowCount: 1 })
    );

    const adaptor = new SearchParamAdaptor();
    await adaptor.recordOutcome(["key-a", "key-b"], "text", 10, 2);

    assert.strictEqual(mockQuery.mock.callCount(), 1);
    const params = mockQuery.mock.calls[0].arguments[1];
    assert.strictEqual(params[0], "key-a");
    assert.strictEqual(typeof params[0], "string");
  });

  // TC-10: array keyId 입력 시 INTEGER 캐스팅 에러 회귀 방지
  // 이전 normalizeKeyId(keyId ?? -1) 로직에서는 array가 그대로 전달돼
  // PostgreSQL이 "integer 자료형 대한 잘못된 입력" 에러를 발생시켰다.
  // _normalizeKeyId 도입 후 에러 없이 default 반환해야 한다.
  test("array keyId 입력 시 integer 캐스팅 에러 발생하지 않음 (회귀)", async () => {
    // 실제 pg 드라이버가 array를 받으면 CAST 에러를 발생시키는 상황 시뮬레이션
    // 수정 전 코드라면 array 전달 → pg error 발생 → logWarn → default 반환 경로
    // 수정 후 코드: _normalizeKeyId가 첫 멤버 string을 반환 → 정상 query 성공
    mockQuery.mock.mockImplementationOnce(() =>
      Promise.resolve({ rows: [] })
    );

    const adaptor = new SearchParamAdaptor();

    // 예외 전파 없이 완료되어야 한다
    const result = await adaptor.getMinSimilarity(
      ["group-uuid-x", "group-uuid-y"], "text", 7
    );

    assert.strictEqual(result, 0.35);

    // query가 실제로 호출됐고 (에러 경로가 아닌 정상 경로),
    // 첫 번째 파라미터가 array가 아닌 string임을 확인
    assert.strictEqual(mockQuery.mock.callCount(), 1);
    const passedKeyId = mockQuery.mock.calls[0].arguments[1][0];
    assert.notEqual(typeof passedKeyId, "object");
    assert.ok(!Array.isArray(passedKeyId), "keyId must not be an array (regression guard)");
    assert.strictEqual(passedKeyId, "group-uuid-x");
  });
});
