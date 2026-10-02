/**
 * LinkIntegrityChecker — Phase 3 Advisory Link Integrity 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * 검증 범위:
 * - non-directional 관계는 cycle 검사 없이 pass-through
 * - directional 관계는 sessionLinker.wouldCreateCycle 호출
 * - keyId 4번째 인자 전파 (tenant 격리)
 * - sessionLinker 주입 없으면 안전하게 pass-through
 * - isReachable/wouldCreateCycle 예외 시 false (차단 해제)
 * - ruleVersion 반환 필드 유지
 */

import { describe, it, mock } from "node:test";
import assert                 from "node:assert/strict";

import { LinkIntegrityChecker, DIRECTIONAL_RELATIONS } from "../../../lib/symbolic/LinkIntegrityChecker.js";

describe("LinkIntegrityChecker.checkCycle", () => {

  const makeLinker = (cycleResult = false) => ({
    wouldCreateCycle: mock.fn(async () => cycleResult)
  });

  it("non-directional 'related' 는 wouldCreateCycle 호출 없이 pass-through", async () => {
    const linker  = makeLinker(false);
    const checker = new LinkIntegrityChecker({ sessionLinker: linker });

    const r = await checker.checkCycle("A", "B", "related", "default", "tenant-A");

    assert.equal(r.hasCycle, false);
    assert.equal(r.reason, "non_directional");
    assert.equal(linker.wouldCreateCycle.mock.callCount(), 0,
      "non-directional 관계는 cycle 검사를 건너뛰어야 함");
  });

  it("directional 'caused_by' 는 wouldCreateCycle을 호출하고 결과 반환", async () => {
    const linker  = makeLinker(true);
    const checker = new LinkIntegrityChecker({ sessionLinker: linker });

    const r = await checker.checkCycle("A", "B", "caused_by", "default", "tenant-A");

    assert.equal(r.hasCycle, true);
    assert.equal(r.reason, "cycle_detected");
    assert.equal(linker.wouldCreateCycle.mock.callCount(), 1);
  });

  it("directional 'caused_by' cycle 없음 → hasCycle=false, reason=ok", async () => {
    const linker  = makeLinker(false);
    const checker = new LinkIntegrityChecker({ sessionLinker: linker });

    const r = await checker.checkCycle("A", "B", "caused_by", "default", null);

    assert.equal(r.hasCycle, false);
    assert.equal(r.reason, "ok");
  });

  it("keyId를 wouldCreateCycle의 4번째 인자로 전파 (tenant 격리)", async () => {
    const linker  = makeLinker(false);
    const checker = new LinkIntegrityChecker({ sessionLinker: linker });

    await checker.checkCycle("X", "Y", "resolved_by", "agent-X", "tenant-A");

    const args = linker.wouldCreateCycle.mock.calls[0].arguments;
    assert.equal(args[0], "X");
    assert.equal(args[1], "Y");
    assert.equal(args[2], "agent-X");
    assert.equal(args[3], "tenant-A", "cross-tenant cycle 방지를 위해 keyId 전파 필수");
  });

  it("sessionLinker 미주입 시 wouldCreateCycle 호출 없이 hasCycle=false, reason=no_linker", async () => {
    const checker = new LinkIntegrityChecker({});
    const r = await checker.checkCycle("A", "B", "caused_by", "default", "tenant-A");
    assert.equal(r.hasCycle, false);
    assert.equal(r.reason, "no_linker");
  });

  it("wouldCreateCycle throw 시 hasCycle=false, reason=error (advisory는 블로킹 금지)", async () => {
    const linker = {
      wouldCreateCycle: mock.fn(async () => { throw new Error("db down"); })
    };
    const checker = new LinkIntegrityChecker({ sessionLinker: linker });

    const r = await checker.checkCycle("A", "B", "superseded_by", "default", "tenant-A");

    assert.equal(r.hasCycle, false);
    assert.equal(r.reason, "error");
  });

  it("DIRECTIONAL_RELATIONS 집합에 caused_by/resolved_by/superseded_by/preceded_by 포함", () => {
    assert.ok(DIRECTIONAL_RELATIONS.has("caused_by"));
    assert.ok(DIRECTIONAL_RELATIONS.has("resolved_by"));
    assert.ok(DIRECTIONAL_RELATIONS.has("superseded_by"));
    assert.ok(DIRECTIONAL_RELATIONS.has("preceded_by"));
    assert.ok(!DIRECTIONAL_RELATIONS.has("related"));
    assert.ok(!DIRECTIONAL_RELATIONS.has("related_to"));
  });

  it("ruleVersion 필드는 항상 포함", async () => {
    const linker  = makeLinker(false);
    const checker = new LinkIntegrityChecker({ sessionLinker: linker });

    const r1 = await checker.checkCycle("A", "B", "related", "default", null);
    const r2 = await checker.checkCycle("A", "B", "caused_by", "default", null);

    assert.ok(typeof r1.ruleVersion === "string" && r1.ruleVersion.length > 0);
    assert.ok(typeof r2.ruleVersion === "string" && r2.ruleVersion.length > 0);
  });

});
