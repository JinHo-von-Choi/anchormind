// tests/unit/supersede-valid-to.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("superseded_by valid_to 연동", () => {
  test("MemoryConsolidator._resolveContradiction이 valid_to를 갱신한다", async () => {
    const { MemoryConsolidator } = await import("../../lib/memory/consolidate/MemoryConsolidator.js");
    const mc = new MemoryConsolidator();
    const src = mc._resolveContradiction.toString();
    assert.ok(src.includes("valid_to"), "_resolveContradiction에 valid_to 갱신 필수");
  });

  test("MemoryConsolidator._resolveContradiction의 해소 기록은 ContradictionDetector와 같은 본문과 topic을 쓴다", async () => {
    const { MemoryConsolidator } = await import("../../lib/memory/consolidate/MemoryConsolidator.js");
    const src = new MemoryConsolidator()._resolveContradiction.toString();
    assert.ok(src.includes("contradictionAuditContent("), "해소 기록 본문은 contradictionAuditContent로 만든다");
    assert.ok(src.includes("CONTRADICTION_AUDIT_TOPIC"), "해소 기록 topic은 CONTRADICTION_AUDIT_TOPIC이다");
    assert.ok(!src.includes("substring(0, 80)"), "본문 앞부분을 직접 담지 않는다");
  });

  test("GraphLinker.linkFragment이 superseded_by 시 valid_to를 갱신한다", async () => {
    const { GraphLinker } = await import("../../lib/memory/link/GraphLinker.js");
    const gl = new GraphLinker();
    const src = gl.linkFragment.toString();
    assert.ok(src.includes("valid_to"), "linkFragment에 valid_to 갱신 필수");
  });
});
