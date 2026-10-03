/**
 * Unit tests: GC가 분할 자식이 남아 있는 원본 파편을 물리 삭제하지 않는지 검증한다.
 *
 * split은 원본을 valid_to + importance 하향 + ttl_tier='cold'로 바꾸는데,
 * 만료 후보 조건의 utility 분기에는 valid_to 조건도 링크 보호도 없으므로
 * 원본 보존은 명시적인 자식 존재 검사에 의존한다.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("GC split 원본 보호", () => {
  test("만료 후보 조건이 분할 자식 존재 시 원본을 후보에서 제외한다", async () => {
    const { GC_CANDIDATE_FROM: src } = await import("../../lib/memory/consolidate/FragmentGC.js");

    assert.ok(src.includes("NOT EXISTS"), "자식 존재 검사 필수");
    assert.ok(src.includes("'split:' || f.id"), "split 자식 source 상관 조건 필수");
  });

  test("만료 후보의 보호 조건이 함께 유지된다", async () => {
    const { GC_CANDIDATE_FROM: src } = await import("../../lib/memory/consolidate/FragmentGC.js");

    assert.ok(src.includes("f.is_anchor = FALSE"), "anchor 보호 유지");
    assert.ok(src.includes("f.ttl_tier NOT IN ('permanent')"), "permanent 보호 유지");
    assert.ok(src.includes("f.type IS NULL"), "NULL type 조건 유지");
  });
});
