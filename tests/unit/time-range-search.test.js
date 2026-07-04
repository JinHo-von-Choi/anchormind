/**
 * timeRange 파라미터 파싱 및 검증 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-28
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseTimeRange } from "../../lib/memory/read/FragmentSearch.js";

describe("parseTimeRange", () => {
  test("유효한 from/to 모두 제공 시 Date 객체 반환", () => {
    const result = parseTimeRange({ from: "2026-03-15", to: "2026-03-16" });
    assert.ok(result);
    assert.ok(result.from instanceof Date);
    assert.ok(result.to instanceof Date);
    assert.equal(result.from.toISOString().slice(0, 10), "2026-03-15");
    assert.equal(result.to.toISOString().slice(0, 10), "2026-03-16");
  });

  test("from만 제공 시 to는 null", () => {
    const result = parseTimeRange({ from: "2026-03-15" });
    assert.ok(result);
    assert.ok(result.from instanceof Date);
    assert.equal(result.to, null);
  });

  test("to만 제공 시 from은 null", () => {
    const result = parseTimeRange({ to: "2026-03-16T12:00:00Z" });
    assert.ok(result);
    assert.equal(result.from, null);
    assert.ok(result.to instanceof Date);
  });

  test("null 입력 시 null 반환", () => {
    assert.equal(parseTimeRange(null), null);
  });

  test("undefined 입력 시 null 반환", () => {
    assert.equal(parseTimeRange(undefined), null);
  });

  test("빈 객체 입력 시 null 반환 (from/to 모두 미제공)", () => {
    assert.equal(parseTimeRange({}), null);
  });

  test("문자열 입력 시 null 반환 (object가 아닌 경우)", () => {
    assert.equal(parseTimeRange("2026-03-15"), null);
  });

  test("유효하지 않은 from 날짜 시 null 반환", () => {
    const result = parseTimeRange({ from: "not-a-date" });
    assert.equal(result, null);
  });

  test("유효하지 않은 to 날짜 시 null 반환", () => {
    const result = parseTimeRange({ from: "2026-03-15", to: "invalid" });
    assert.equal(result, null);
  });

  test("ISO 8601 전체 형식 파싱", () => {
    const result = parseTimeRange({
      from: "2026-03-15T09:30:00+09:00",
      to  : "2026-03-16T18:00:00Z"
    });
    assert.ok(result);
    assert.ok(Number.isFinite(result.from.getTime()));
    assert.ok(Number.isFinite(result.to.getTime()));
  });
});
