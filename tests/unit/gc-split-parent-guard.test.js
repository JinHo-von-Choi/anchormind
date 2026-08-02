/**
 * Unit tests: GC가 분할 자식이 남아 있는 원본 파편을 물리 삭제하지 않는지 검증한다.
 *
 * split은 원본을 valid_to + importance 하향 + ttl_tier='cold'로 바꾸는데,
 * deleteExpired의 utility 분기에는 valid_to 조건도 링크 보호도 없으므로
 * 원본 보존은 명시적인 자식 존재 검사에 의존한다.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("GC split 원본 보호", () => {
  test("deleteExpired SQL이 분할 자식 존재 시 원본을 후보에서 제외한다", async () => {
    const { FragmentWriter } = await import("../../lib/memory/write/FragmentWriter.js");
    const src = new FragmentWriter().deleteExpired.toString();

    assert.ok(src.includes("NOT EXISTS"), "자식 존재 검사 필수");
    assert.ok(src.includes("'split:' || fragments.id"), "split 자식 source 상관 조건 필수");
  });

  test("기존 GC 조건이 함께 유지된다", async () => {
    const { FragmentWriter } = await import("../../lib/memory/write/FragmentWriter.js");
    const src = new FragmentWriter().deleteExpired.toString();

    assert.ok(src.includes("is_anchor = FALSE"), "anchor 보호 유지");
    assert.ok(src.includes("ttl_tier NOT IN ('permanent')"), "permanent 보호 유지");
    assert.ok(src.includes("type IS NULL"), "NULL type 조건 유지");
  });
});
