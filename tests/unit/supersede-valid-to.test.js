// tests/unit/supersede-valid-to.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("superseded_by valid_to 연동", () => {
  test("MemoryConsolidator._resolveContradiction은 ContradictionDetector의 해소 규칙에 위임한다", async () => {
    const { MemoryConsolidator }    = await import("../../lib/memory/consolidate/MemoryConsolidator.js");
    const { ContradictionDetector } = await import("../../lib/memory/link/ContradictionDetector.js");
    const src     = new MemoryConsolidator()._resolveContradiction.toString();
    const resolve = ContradictionDetector.prototype.resolveContradiction.toString();
    assert.ok(src.includes("contradictionDetector.resolveContradiction("), "통합 경로도 같은 해소 규칙을 쓴다");
    assert.ok(resolve.includes("valid_to"), "해소는 패자의 valid_to를 갱신한다");
  });

  test("해소 기록은 ContradictionDetector의 감사 기록 함수와 topic을 쓴다", async () => {
    const { ContradictionDetector } = await import("../../lib/memory/link/ContradictionDetector.js");
    const resolve = ContradictionDetector.prototype.resolveContradiction.toString();
    const audit   = ContradictionDetector.prototype.recordResolutionAudit.toString();
    assert.ok(resolve.includes("recordResolutionAudit("), "해소 기록은 감사 기록 함수로 남긴다");
    assert.ok(audit.includes("contradictionAuditContent("), "해소 기록 본문은 contradictionAuditContent로 만든다");
    assert.ok(resolve.includes("CONTRADICTION_AUDIT_TOPIC"), "해소 기록 topic은 CONTRADICTION_AUDIT_TOPIC이다");
    assert.ok(!resolve.includes("substring(0, 80)"), "본문 앞부분을 직접 담지 않는다");
  });

  test("재탐지를 막는 contradicts 링크는 패자를 닫은 뒤에 만든다", async () => {
    const { ContradictionDetector } = await import("../../lib/memory/link/ContradictionDetector.js");
    const resolve = ContradictionDetector.prototype.resolveContradiction.toString();
    const closeAt = resolve.indexOf("valid_to = NOW()");
    const linkAt  = resolve.lastIndexOf('"contradicts"');
    assert.ok(closeAt > 0 && linkAt > closeAt, "contradicts 링크는 닫기 뒤에 와야 한다");
    assert.match(resolve, /importance = importance \* 0\.5, valid_to = NOW\(\)/);
  });

  test("GraphLinker.linkFragment이 superseded_by 시 valid_to를 갱신한다", async () => {
    const { GraphLinker } = await import("../../lib/memory/link/GraphLinker.js");
    const gl = new GraphLinker();
    const src = gl.linkFragment.toString();
    assert.ok(src.includes("valid_to"), "linkFragment에 valid_to 갱신 필수");
  });
});
