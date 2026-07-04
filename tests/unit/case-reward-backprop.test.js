/**
 * CaseRewardBackprop 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 * 수정일: 2026-05-13
 */

import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/** db.js, logger.js mock 등록 (CaseRewardBackprop import 전에 실행) */
const mockQuery = mock.fn();
const mockPool  = { query: mockQuery };

mock.module("../../lib/tools/db.js", {
  namedExports: { getPrimaryPool: () => mockPool }
});
mock.module("../../lib/logger.js", {
  namedExports: { logWarn: mock.fn() }
});

const { CaseRewardBackprop } = await import("../../lib/memory/signals/CaseRewardBackprop.js");

describe("CaseRewardBackprop", () => {
  beforeEach(() => {
    mockQuery.mock.resetCalls();
    /** 본 스위트는 기능이 활성화된 상태의 동작을 검증한다. 비활성 케이스는 별도 테스트에서 다룬다. */
    process.env.MEMENTO_CASE_BACKPROP_ENABLED = "true";
  });

  test("verification_passed: atomic UPDATE delta=+0.15, quality_verified=true", async () => {
    mockQuery.mock.mockImplementationOnce(() => Promise.resolve({ rowCount: 2 }));

    await new CaseRewardBackprop().backprop("case-abc", "verification_passed", null);

    assert.strictEqual(mockQuery.mock.callCount(), 1);
    const [sql, params] = mockQuery.mock.calls[0].arguments;

    assert.match(sql, /UPDATE.*fragments/i);
    assert.match(sql, /FROM.*fragment_evidence/i);
    assert.match(sql, /importance\s*\+\s*\$2/i);
    /**
     * keyId=null(마스터 키) 경로는 keyFilter를 생략하고 전체 파편을 대상으로 UPDATE한다.
     * 따라서 파라미터는 [caseId, delta, isPass] 3개만 바인딩된다.
     * keyId가 지정된 경우만 $4로 포함되며, 해당 경로는 다음 테스트 케이스에서 검증한다.
     */
    assert.deepStrictEqual(params, ["case-abc", 0.15, true]);
  });

  test("verification_failed: atomic UPDATE delta=-0.10, quality_verified unchanged", async () => {
    mockQuery.mock.mockImplementationOnce(() => Promise.resolve({ rowCount: 1 }));

    await new CaseRewardBackprop().backprop("case-xyz", "verification_failed", 42);

    const [, params] = mockQuery.mock.calls[0].arguments;
    assert.deepStrictEqual(params, ["case-xyz", -0.10, false, 42]);
  });

  test("증거 파편 없으면 rowCount=0 (UPDATE는 실행됨)", async () => {
    mockQuery.mock.mockImplementationOnce(() => Promise.resolve({ rowCount: 0 }));

    await new CaseRewardBackprop().backprop("empty-case", "verification_passed", null);

    assert.strictEqual(mockQuery.mock.callCount(), 1);
  });

  test("잘못된 event_type은 무시", async () => {
    await new CaseRewardBackprop().backprop("case-abc", "milestone_reached", null);

    assert.strictEqual(mockQuery.mock.callCount(), 0);
  });

  test("DB 오류 시 예외 전파 없음 (fire-and-forget 안전)", async () => {
    mockQuery.mock.mockImplementationOnce(() => Promise.reject(new Error("connection lost")));

    await new CaseRewardBackprop().backprop("case-err", "verification_passed", null);
    /** 예외 없이 정상 완료되면 테스트 통과 */
  });

  test("MEMENTO_CASE_BACKPROP_ENABLED 미설정 → UPDATE 미발행 (no-op)", async () => {
    delete process.env.MEMENTO_CASE_BACKPROP_ENABLED;

    await new CaseRewardBackprop().backprop("case-disabled", "verification_passed", null);

    assert.strictEqual(mockQuery.mock.callCount(), 0, "기능이 비활성화되면 DB query가 실행되어선 안 된다");
  });

  test("MEMENTO_CASE_BACKPROP_ENABLED=false 명시 → no-op", async () => {
    process.env.MEMENTO_CASE_BACKPROP_ENABLED = "false";

    await new CaseRewardBackprop().backprop("case-disabled-2", "verification_passed", null);

    assert.strictEqual(mockQuery.mock.callCount(), 0);
  });
});
