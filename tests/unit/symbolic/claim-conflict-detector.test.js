/**
 * ClaimConflictDetector 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * 검증 대상 (Phase 3):
 *  - ClaimStore.findPolarityConflicts 결과를 PolarityConflict 배열로 정규화
 *  - 충돌 개수 기반 severity (none/low/medium/high)
 *  - 메트릭 호출 (warning 기록)
 *  - fragment 기준 반대편(f1 / f2) 정규화
 *  - findPolarityConflicts 실패 시 degraded (conflicts=[], error 반환, throw 없음)
 *  - keyId null/tenant 파라미터 전달
 */

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

const { ClaimConflictDetector, CLAIM_CONFLICT_RULE_ID } =
  await import("../../../lib/symbolic/ClaimConflictDetector.js");

/** 경량 ClaimStore stub */
function makeStubStore(findImpl) {
  return { findPolarityConflicts: mock.fn(findImpl) };
}

/** 경량 metrics stub */
function makeStubMetrics() {
  return {
    recordWarning   : mock.fn(),
    recordGateBlock : mock.fn(),
    recordClaim     : mock.fn(),
    observeLatency  : mock.fn()
  };
}

describe("ClaimConflictDetector — polarity 충돌 정규화", () => {

  test("충돌 0건: severity=none, metrics 호출 없음", async () => {
    const store    = makeStubStore(async () => []);
    const metrics  = makeStubMetrics();
    const detector = new ClaimConflictDetector({ claimStore: store, metrics });

    const result = await detector.detectPolarityConflicts("frag-a", null);
    assert.deepEqual(result, { conflicts: [], severity: "none", ruleVersion: "v1" });
    assert.equal(metrics.recordWarning.mock.callCount(), 0);
  });

  test("충돌 1건: f2 관점 정규화 + severity=low + metrics 기록", async () => {
    const rows  = [{ f1: "frag-a", f2: "frag-b", subject: "redis", predicate: "사용", object: "cache" }];
    const store = makeStubStore(async () => rows);
    const metrics  = makeStubMetrics();
    const detector = new ClaimConflictDetector({ claimStore: store, metrics });

    const result = await detector.detectPolarityConflicts("frag-a", "api-key-1");
    assert.equal(result.severity, "low");
    assert.equal(result.ruleVersion, "v1");
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].conflictWith, "frag-b");
    assert.equal(result.conflicts[0].subject, "redis");
    assert.equal(result.conflicts[0].predicate, "사용");
    assert.equal(result.conflicts[0].object, "cache");

    assert.equal(metrics.recordWarning.mock.callCount(), 1);
    const [rule, severity] = metrics.recordWarning.mock.calls[0].arguments;
    assert.equal(rule, CLAIM_CONFLICT_RULE_ID);
    assert.equal(severity, "low");
  });

  test("충돌 2~3건: severity=medium", async () => {
    const rows = [
      { f1: "frag-a", f2: "frag-b", subject: "s", predicate: "p", object: "o" },
      { f1: "frag-a", f2: "frag-c", subject: "s", predicate: "p", object: "o" }
    ];
    const detector = new ClaimConflictDetector({
      claimStore: makeStubStore(async () => rows),
      metrics   : makeStubMetrics()
    });

    const result = await detector.detectPolarityConflicts("frag-a");
    assert.equal(result.severity, "medium");
    assert.equal(result.conflicts.length, 2);
    assert.deepEqual(result.conflicts.map(c => c.conflictWith), ["frag-b", "frag-c"]);
  });

  test("충돌 4건↑: severity=high", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      f1: "frag-a", f2: `frag-${i}`, subject: "s", predicate: "p", object: null
    }));
    const detector = new ClaimConflictDetector({
      claimStore: makeStubStore(async () => rows),
      metrics   : makeStubMetrics()
    });
    const result = await detector.detectPolarityConflicts("frag-a");
    assert.equal(result.severity, "high");
  });

  test("fragmentId 가 f2 쪽인 경우 conflictWith 는 f1", async () => {
    const rows = [{ f1: "frag-x", f2: "frag-a", subject: "s", predicate: "p", object: null }];
    const detector = new ClaimConflictDetector({
      claimStore: makeStubStore(async () => rows),
      metrics   : makeStubMetrics()
    });
    const result = await detector.detectPolarityConflicts("frag-a");
    assert.equal(result.conflicts[0].conflictWith, "frag-x");
  });

  test("fragmentId 누락 시 즉시 none 반환", async () => {
    const detector = new ClaimConflictDetector({
      claimStore: makeStubStore(async () => { throw new Error("should not be called"); }),
      metrics   : makeStubMetrics()
    });
    const result = await detector.detectPolarityConflicts("", null);
    assert.equal(result.severity, "none");
    assert.equal(result.conflicts.length, 0);
  });

  test("ClaimStore 실패 시 degraded: conflicts=[], error 메시지 포함, throw 없음", async () => {
    const store = { findPolarityConflicts: mock.fn(async () => { throw new Error("DB boom"); }) };
    const detector = new ClaimConflictDetector({ claimStore: store, metrics: makeStubMetrics() });
    const result = await detector.detectPolarityConflicts("frag-a", "api-key-1");
    assert.equal(result.severity, "none");
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.error, "DB boom");
  });

  test("keyId 와 opts 가 ClaimStore 로 전달된다 (tenant 격리)", async () => {
    let capturedArgs = null;
    const store = { findPolarityConflicts: mock.fn(async (...args) => { capturedArgs = args; return []; }) };
    const detector = new ClaimConflictDetector({ claimStore: store, metrics: makeStubMetrics() });

    await detector.detectPolarityConflicts("frag-a", "api-key-5", { minConfidence: 0.85 });

    assert.deepEqual(capturedArgs, ["frag-a", "api-key-5", { minConfidence: 0.85 }]);
  });

  test("master(NULL) 호출 시 keyId=null 이 전달된다", async () => {
    let capturedKey = undefined;
    const store = { findPolarityConflicts: mock.fn(async (_, k) => { capturedKey = k; return []; }) };
    const detector = new ClaimConflictDetector({ claimStore: store, metrics: makeStubMetrics() });
    await detector.detectPolarityConflicts("frag-m");
    assert.equal(capturedKey, null);
  });
});
