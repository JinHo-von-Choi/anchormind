/**
 * SymbolicOrchestrator 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * 검증 포인트 (Phase 0):
 * 1. enabled=false → 즉시 Noop
 * 2. 지원하지 않는 mode → errorCode=UNSUPPORTED_MODE, degraded=false
 * 3. 지원하지 않는 ruleVersion → errorCode=RULE_VERSION_UNSUPPORTED
 * 4. explain 모드 성공 경로 → reason code 배열 반환
 * 5. timeout 초과 → errorCode=TIMEOUT, degraded=true, throw 하지 않음
 * 6. rule evaluate 내부 에러 → errorCode=EVAL_ERROR, degraded=true
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SymbolicOrchestrator, SYMBOLIC_ERROR_CODES } from "../../../lib/symbolic/SymbolicOrchestrator.js";

/** 테스트용 stub metrics (no-op) */
const stubMetrics = {
  recordWarning  : () => {},
  recordGateBlock: () => {},
  recordClaim    : () => {},
  observeLatency : () => {}
};

/** 기본 enabled config */
function enabledConfig(overrides = {}) {
  return {
    enabled         : true,
    claimExtraction : false,
    explain         : true,
    linkCheck       : false,
    polarityConflict: false,
    policyRules     : false,
    cbrFilter       : false,
    proactiveGate   : false,
    shadow          : false,
    ruleVersion     : "v1",
    timeoutMs       : 50,
    maxCandidates   : 32,
    ...overrides
  };
}

describe("SymbolicOrchestrator", () => {
  it("enabled=false → 즉시 Noop 반환 (ok=true, results=[])", async () => {
    const orch = new SymbolicOrchestrator({
      config : enabledConfig({ enabled: false }),
      metrics: stubMetrics
    });

    const r = await orch.evaluate({
      mode      : "explain",
      candidates: [{ id: "f1" }],
      ctx       : { searchPath: ["L2:1"] }
    });

    assert.equal(r.ok, true);
    assert.deepEqual(r.results, []);
    assert.equal(r.degraded, false);
    assert.equal(r.ruleVersion, "v1");
  });

  it("지원하지 않는 mode → errorCode=UNSUPPORTED_MODE, degraded=false", async () => {
    const orch = new SymbolicOrchestrator({
      config : enabledConfig(),
      metrics: stubMetrics
    });

    const r = await orch.evaluate({
      mode      : "nonsense",
      candidates: [],
      ctx       : {}
    });

    assert.equal(r.ok, false);
    assert.equal(r.errorCode, SYMBOLIC_ERROR_CODES.UNSUPPORTED_MODE);
    assert.equal(r.degraded, false);
  });

  it("지원하지 않는 ruleVersion → errorCode=RULE_VERSION_UNSUPPORTED", async () => {
    const orch = new SymbolicOrchestrator({
      config : enabledConfig(),
      metrics: stubMetrics
    });

    const r = await orch.evaluate({
      mode       : "explain",
      candidates : [],
      ctx        : {},
      ruleVersion: "v99"
    });

    assert.equal(r.ok, false);
    assert.equal(r.errorCode, SYMBOLIC_ERROR_CODES.RULE_VERSION_UNSUPPORTED);
    assert.equal(r.ruleVersion, "v99");
  });

  it("explain 모드 성공 경로 → 6종 reason code 일부 반환", async () => {
    const orch = new SymbolicOrchestrator({
      config : enabledConfig(),
      metrics: stubMetrics
    });

    const fragments = [
      { id: "f1", ema_activation: 0.8, case_id: "case-1" }
    ];

    const r = await orch.evaluate({
      mode      : "explain",
      candidates: fragments,
      ctx       : {
        searchPath : ["L2:3", "L3:5", "Graph:1"],
        caseContext: "case-1"
      }
    });

    assert.equal(r.ok, true);
    assert.equal(r.degraded, false);
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].fragmentId, "f1");
    assert.ok(Array.isArray(r.results[0].reasons));
    /** 최대 3개 제한 */
    assert.ok(r.results[0].reasons.length > 0);
    assert.ok(r.results[0].reasons.length <= 3);
    /** 각 reason 은 code/detail/ruleVersion 필드를 가진다 */
    for (const reason of r.results[0].reasons) {
      assert.equal(typeof reason.code, "string");
      assert.equal(typeof reason.detail, "string");
      assert.equal(reason.ruleVersion, "v1");
    }
  });

  it("explain 모드 → L2 태그 있으면 direct_keyword_match 포함", async () => {
    const orch = new SymbolicOrchestrator({
      config : enabledConfig(),
      metrics: stubMetrics
    });

    const r = await orch.evaluate({
      mode      : "explain",
      candidates: [{ id: "f1" }],
      ctx       : { searchPath: ["L2:1"] }
    });

    const codes = r.results[0].reasons.map((x) => x.code);
    assert.ok(codes.includes("direct_keyword_match"));
  });

  it("timeout 초과 → errorCode=TIMEOUT, degraded=true, throw 하지 않음", async () => {
    /** 느린 rule pack 을 DI 로 주입하여 timeout 분기를 트리거한다 */
    const slowRulePack = {
      version : "v1",
      evaluate: () => new Promise((resolve) => setTimeout(() => resolve([{ fragmentId: "f1", reasons: [] }]), 100))
    };

    const orch = new SymbolicOrchestrator({
      config        : enabledConfig({ timeoutMs: 10 }),
      metrics       : stubMetrics,
      rulePackLoader: () => slowRulePack
    });

    let threw = false;
    let r;
    try {
      r = await orch.evaluate({
        mode      : "explain",
        candidates: [{ id: "f1" }],
        ctx       : { searchPath: ["L2:1"] }
      });
    } catch (_err) {
      threw = true;
    }

    assert.equal(threw, false, "evaluate 는 throw 하지 않아야 한다");
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, SYMBOLIC_ERROR_CODES.TIMEOUT);
    assert.equal(r.degraded, true);
  });

  it("rule pack 내부 throw → errorCode=EVAL_ERROR, degraded=true", async () => {
    /** 실패하는 rule pack 을 DI 로 주입 */
    const failingRulePack = {
      version : "v1",
      evaluate: () => { throw new Error("boom"); }
    };

    const orch = new SymbolicOrchestrator({
      config        : enabledConfig(),
      metrics       : stubMetrics,
      rulePackLoader: () => failingRulePack
    });

    const r = await orch.evaluate({
      mode      : "explain",
      candidates: [{ id: "f1" }],
      ctx       : { searchPath: ["L2:1"] }
    });

    assert.equal(r.ok, false);
    assert.equal(r.errorCode, SYMBOLIC_ERROR_CODES.EVAL_ERROR);
    assert.equal(r.degraded, true);
  });

  it("candidates 가 빈 배열 → results=[], ok=true", async () => {
    const orch = new SymbolicOrchestrator({
      config : enabledConfig(),
      metrics: stubMetrics
    });

    const r = await orch.evaluate({
      mode      : "explain",
      candidates: [],
      ctx       : { searchPath: ["L2:1"] }
    });

    assert.equal(r.ok, true);
    assert.deepEqual(r.results, []);
  });

  it("metrics.observeLatency 는 성공 경로에서만 호출된다", async () => {
    const calls = [];
    const trackingMetrics = {
      ...stubMetrics,
      observeLatency(op, ms) {
        calls.push({ op, ms });
      }
    };

    const orch = new SymbolicOrchestrator({
      config : enabledConfig(),
      metrics: trackingMetrics
    });

    await orch.evaluate({
      mode      : "explain",
      candidates: [{ id: "f1" }],
      ctx       : { searchPath: ["L2:1"] }
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].op, "orchestrator.explain");
    assert.ok(calls[0].ms >= 0);
  });
});
