/**
 * CbrEligibility 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * 검증 포인트:
 * 1. tenant 불일치 → 차단 (master ↔ API key 혼입 방지)
 * 2. case_id 없음 → 차단
 * 3. quarantine_state='soft' → 차단
 * 4. resolution_status='in_progress' → 차단
 * 5. resolution_status='resolved' → 통과
 * 6. 모든 제약 통과 → 통과
 * 7. 빈/잘못된 입력 → 안전 반환
 * 8. metrics.recordGateBlock 호출 확인
 * 9. sq.keyId 배열 정규화
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CbrEligibility } from "../../../lib/symbolic/CbrEligibility.js";

/** 테스트용 메트릭 트래커 */
function makeTrackingMetrics() {
  const calls = [];
  return {
    calls,
    recordGateBlock(phase, reason) { calls.push({ phase, reason }); },
    recordWarning() {},
    recordClaim() {},
    observeLatency() {}
  };
}

function validFragment(overrides = {}) {
  return {
    id               : "f1",
    key_id           : "key-1",
    case_id          : "case-1",
    quarantine_state : null,
    resolution_status: "resolved",
    ...overrides
  };
}

describe("CbrEligibility", () => {
  it("빈 배열 입력 → 빈 배열 반환", async () => {
    const filter = new CbrEligibility();
    const r = await filter.filter([], { keyId: "key-1" });
    assert.deepEqual(r, []);
  });

  it("null 입력 → 빈 배열 반환", async () => {
    const filter = new CbrEligibility();
    const r = await filter.filter(null, { keyId: "key-1" });
    assert.deepEqual(r, []);
  });

  it("tenant 불일치 → 차단 (master key vs API key)", async () => {
    const metrics = makeTrackingMetrics();
    const filter  = new CbrEligibility({ metrics });
    const master  = validFragment({ key_id: null });
    const apiKey  = validFragment({ key_id: "key-1", id: "f2" });

    /** API 키 (key-1) 로 호출 → master key 파편 차단 */
    const r = await filter.filter([master, apiKey], { keyId: "key-1" });
    assert.equal(r.length, 1);
    assert.equal(r[0].id, "f2");
    assert.ok(metrics.calls.some((c) => c.reason === "tenant"));
  });

  it("master 키 호출 → API key 파편 차단 (대칭성)", async () => {
    const metrics = makeTrackingMetrics();
    const filter  = new CbrEligibility({ metrics });
    const master  = validFragment({ key_id: null });
    const apiKey  = validFragment({ key_id: "key-1", id: "f2" });

    const r = await filter.filter([master, apiKey], { keyId: null });
    assert.equal(r.length, 1);
    assert.equal(r[0].id, "f1");
    assert.ok(metrics.calls.some((c) => c.reason === "tenant"));
  });

  it("case_id 없음 → 차단", async () => {
    const metrics = makeTrackingMetrics();
    const filter  = new CbrEligibility({ metrics });
    const noCase  = validFragment({ case_id: null });

    const r = await filter.filter([noCase], { keyId: "key-1" });
    assert.equal(r.length, 0);
    assert.ok(metrics.calls.some((c) => c.reason === "no_case"));
  });

  it("quarantine_state='soft' → 차단", async () => {
    const metrics = makeTrackingMetrics();
    const filter  = new CbrEligibility({ metrics });
    const quar    = validFragment({ quarantine_state: "soft" });

    const r = await filter.filter([quar], { keyId: "key-1" });
    assert.equal(r.length, 0);
    assert.ok(metrics.calls.some((c) => c.reason === "quarantine"));
  });

  it("resolution_status='in_progress' → 차단", async () => {
    const metrics = makeTrackingMetrics();
    const filter  = new CbrEligibility({ metrics });
    const unres   = validFragment({ resolution_status: "in_progress" });

    const r = await filter.filter([unres], { keyId: "key-1" });
    assert.equal(r.length, 0);
    assert.ok(metrics.calls.some((c) => c.reason === "unresolved"));
  });

  it("resolution_status=null → 통과 (예비 상태 허용)", async () => {
    const filter = new CbrEligibility();
    const nullStatus = validFragment({ resolution_status: null });
    const r = await filter.filter([nullStatus], { keyId: "key-1" });
    assert.equal(r.length, 1);
  });

  it("resolution_status='resolved' → 통과", async () => {
    const filter = new CbrEligibility();
    const r = await filter.filter([validFragment()], { keyId: "key-1" });
    assert.equal(r.length, 1);
    assert.equal(r[0].id, "f1");
  });

  it("모든 제약 통과 → 원본 반환", async () => {
    const filter = new CbrEligibility();
    const good   = [
      validFragment({ id: "f1" }),
      validFragment({ id: "f2" }),
      validFragment({ id: "f3" })
    ];
    const r = await filter.filter(good, { keyId: "key-1" });
    assert.equal(r.length, 3);
  });

  it("혼합 입력 → 유효한 것만 통과", async () => {
    const metrics = makeTrackingMetrics();
    const filter  = new CbrEligibility({ metrics });
    const input = [
      validFragment({ id: "ok1" }),
      validFragment({ id: "no_case_f", case_id: null }),
      validFragment({ id: "quar_f", quarantine_state: "soft" }),
      validFragment({ id: "unres_f", resolution_status: "failed" }),
      validFragment({ id: "ok2" }),
      validFragment({ id: "tenant_f", key_id: "other-key" })
    ];

    const r = await filter.filter(input, { keyId: "key-1" });
    const ids = r.map((f) => f.id);
    assert.deepEqual(ids.sort(), ["ok1", "ok2"]);

    const reasons = metrics.calls.map((c) => c.reason);
    assert.ok(reasons.includes("no_case"));
    assert.ok(reasons.includes("quarantine"));
    assert.ok(reasons.includes("unresolved"));
    assert.ok(reasons.includes("tenant"));
  });

  it("sq.keyId 배열 형태 → 첫 원소로 정규화", async () => {
    const filter = new CbrEligibility();
    const frag = validFragment({ key_id: "key-a" });
    const r = await filter.filter([frag], { keyId: ["key-a", "key-b"] });
    assert.equal(r.length, 1);
  });

  it("모든 recordGateBlock 호출은 phase='cbr'", async () => {
    const metrics = makeTrackingMetrics();
    const filter  = new CbrEligibility({ metrics });
    const bad = [
      validFragment({ case_id: null }),
      validFragment({ quarantine_state: "soft" })
    ];
    await filter.filter(bad, { keyId: "key-1" });
    for (const call of metrics.calls) {
      assert.equal(call.phase, "cbr");
    }
  });
});
