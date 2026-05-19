/**
 * ProactiveRecall gate 단위 테스트 (rules/v1/proactive-gate.js)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 * 수정일: 2026-05-19
 *
 * 검증 대상 (Phase 6):
 *  - polarity 충돌 존재 시 block (reason=polarity_conflict)
 *  - quarantine_state (non-released) 시 block (reason=quarantine)
 *  - cohort mismatch (case_id 상이) 시 block (reason=cohort_mismatch)
 *  - 정상 시 allow (reason=ok)
 *  - detector throw 시 fail-open (allow)
 *  - target 누락 시 invalid_target
 *  - released quarantine 은 통과
 *  - source 혹은 target case_id 한쪽만 있으면 cohort 검사 스킵
 *  - workspace 불일치 시 block (reason=workspace_mismatch)
 *  - caseIdPolicy 정책 위반 시 block (reason=case_policy)
 */

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

const { evaluateProactiveGate, PROACTIVE_GATE_RULE_VERSION } =
  await import("../../../lib/symbolic/rules/v1/proactive-gate.js");

function makeDetector(conflicts = []) {
  return {
    detectPolarityConflicts: mock.fn(async () => ({
      conflicts,
      severity   : conflicts.length > 0 ? "low" : "none",
      ruleVersion: "v1"
    }))
  };
}

function makeThrowingDetector(msg) {
  return {
    detectPolarityConflicts: mock.fn(async () => { throw new Error(msg); })
  };
}

describe("evaluateProactiveGate — Phase 6 rule pack", () => {

  test("정상 케이스: allow + reason=ok", async () => {
    const res = await evaluateProactiveGate(
      { source: { id: "a" }, target: { id: "b" }, keyId: null },
      { detector: makeDetector([]) }
    );
    assert.deepEqual(res, { allowed: true, reason: "ok", ruleVersion: PROACTIVE_GATE_RULE_VERSION });
  });

  test("polarity 충돌 존재 시 block", async () => {
    const detector = makeDetector([
      { conflictWith: "a", subject: "s", predicate: "p", object: null, ruleVersion: "v1" }
    ]);
    const res = await evaluateProactiveGate(
      { source: { id: "a" }, target: { id: "b" }, keyId: "api-key-1" },
      { detector }
    );
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "polarity_conflict");
    assert.equal(res.ruleVersion, "v1");
    assert.equal(detector.detectPolarityConflicts.mock.callCount(), 1);
    const [tid, kid] = detector.detectPolarityConflicts.mock.calls[0].arguments;
    assert.equal(tid, "b");
    assert.equal(kid, "api-key-1");
  });

  test("target.quarantine_state=soft 시 block, polarity 검사는 skip", async () => {
    const detector = makeDetector([]);
    const res = await evaluateProactiveGate(
      { source: { id: "a" }, target: { id: "b", quarantine_state: "soft" } },
      { detector }
    );
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "quarantine");
    assert.equal(detector.detectPolarityConflicts.mock.callCount(), 0);
  });

  test("quarantine_state=released 는 통과 (quarantine 해제됨)", async () => {
    const res = await evaluateProactiveGate(
      { source: { id: "a" }, target: { id: "b", quarantine_state: "released" } },
      { detector: makeDetector([]) }
    );
    assert.equal(res.allowed, true);
    assert.equal(res.reason, "ok");
  });

  test("case_id 불일치 시 block (cohort_mismatch), polarity 검사는 skip", async () => {
    const detector = makeDetector([]);
    const res = await evaluateProactiveGate(
      { source: { id: "a", case_id: "case-1" }, target: { id: "b", case_id: "case-2" } },
      { detector }
    );
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "cohort_mismatch");
    assert.equal(detector.detectPolarityConflicts.mock.callCount(), 0);
  });

  test("case_id 한쪽만 있으면 cohort 검사 스킵", async () => {
    const res1 = await evaluateProactiveGate(
      { source: { id: "a", case_id: "case-1" }, target: { id: "b" } },
      { detector: makeDetector([]) }
    );
    const res2 = await evaluateProactiveGate(
      { source: { id: "a" }, target: { id: "b", case_id: "case-2" } },
      { detector: makeDetector([]) }
    );
    assert.equal(res1.allowed, true);
    assert.equal(res2.allowed, true);
  });

  test("같은 case_id 는 통과", async () => {
    const res = await evaluateProactiveGate(
      { source: { id: "a", case_id: "case-1" }, target: { id: "b", case_id: "case-1" } },
      { detector: makeDetector([]) }
    );
    assert.equal(res.allowed, true);
    assert.equal(res.reason, "ok");
  });

  test("detector throw 시 fail-open (allow)", async () => {
    const detector = makeThrowingDetector("DB down");
    const res = await evaluateProactiveGate(
      { source: { id: "a" }, target: { id: "b" } },
      { detector }
    );
    assert.equal(res.allowed, true);
    assert.equal(res.reason, "ok");
  });

  test("target 누락 시 invalid_target block", async () => {
    const res = await evaluateProactiveGate(
      { source: { id: "a" }, target: null },
      { detector: makeDetector([]) }
    );
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "invalid_target");
  });

  test("target.id 없을 때 invalid_target block", async () => {
    const res = await evaluateProactiveGate(
      { source: { id: "a" }, target: {} },
      { detector: makeDetector([]) }
    );
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "invalid_target");
  });

  test("deps.detector 없으면 기본 통과 (I/O 생략)", async () => {
    const res = await evaluateProactiveGate(
      { source: { id: "a" }, target: { id: "b" } },
      {}
    );
    assert.equal(res.allowed, true);
    assert.equal(res.reason, "ok");
  });

  test("requireSameWorkspace=true + 다른 workspace이면 workspace_mismatch block", async () => {
    const res = await evaluateProactiveGate(
      {
        source: { id: "a", workspace_id: "ws-1" },
        target: { id: "b", workspace_id: "ws-2" },
      },
      {
        detector       : makeDetector([]),
        proactiveConfig: { requireSameWorkspace: true, caseIdPolicy: "loose" },
      }
    );
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "workspace_mismatch");
  });

  test("requireSameWorkspace=true + 동일 workspace이면 통과", async () => {
    const res = await evaluateProactiveGate(
      {
        source: { id: "a", workspace_id: "ws-1" },
        target: { id: "b", workspace_id: "ws-1" },
      },
      {
        detector       : makeDetector([]),
        proactiveConfig: { requireSameWorkspace: true, caseIdPolicy: "loose" },
      }
    );
    assert.equal(res.allowed, true);
    assert.equal(res.reason, "ok");
  });

  test("caseIdPolicy=both-required + 한쪽 null이면 case_policy block", async () => {
    const res = await evaluateProactiveGate(
      {
        source: { id: "a", case_id: "case-1" },
        target: { id: "b", case_id: null },
      },
      {
        detector       : makeDetector([]),
        proactiveConfig: {
          requireSameWorkspace: false,
          caseIdPolicy        : "both-required",
          adjacencyWindowMs   : 86400000,
        },
      }
    );
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "case_policy");
  });

  test("caseIdPolicy=strict-or-adjacent + 한쪽 null + sessionId 동일이면 통과", async () => {
    const res = await evaluateProactiveGate(
      {
        source: { id: "a", case_id: "case-1", session_id: "sess-x", created_at: new Date().toISOString() },
        target: { id: "b", case_id: null, session_id: "sess-x", created_at: new Date().toISOString() },
      },
      {
        detector       : makeDetector([]),
        proactiveConfig: {
          requireSameWorkspace: false,
          caseIdPolicy        : "strict-or-adjacent",
          adjacencyWindowMs   : 86400000,
        },
      }
    );
    assert.equal(res.allowed, true);
    assert.equal(res.reason, "ok");
  });

  test("caseIdPolicy=strict-or-adjacent + 한쪽 null + 다른 세션 + 25h 초과이면 case_policy block", async () => {
    const oldDate = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    const res = await evaluateProactiveGate(
      {
        source: { id: "a", case_id: "case-1", session_id: "sess-new", created_at: new Date().toISOString() },
        target: { id: "b", case_id: null, session_id: "sess-old", created_at: oldDate },
      },
      {
        detector       : makeDetector([]),
        proactiveConfig: {
          requireSameWorkspace: false,
          caseIdPolicy        : "strict-or-adjacent",
          adjacencyWindowMs   : 24 * 3600 * 1000,
        },
      }
    );
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "case_policy");
  });
});
