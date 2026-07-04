/**
 * parseTemporalExpression 자연어 시간 파싱 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-28
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { parseTemporalExpression, parseTimeRange } from "../../lib/memory/read/FragmentSearch.js";

/** 고정 기준 시각: 2026-03-28 토요일 15:30:00 */
const NOW = new Date(2026, 2, 28, 15, 30, 0);

function dayStr(d) {
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("parseTemporalExpression - 상대 표현 (N단위 전)", () => {

  test("3일 전", () => {
    const result = parseTemporalExpression("3일 전", NOW);
    assert.strictEqual(dayStr(result), "2026-03-25");
  });

  test("1주 전", () => {
    const result = parseTemporalExpression("1주 전", NOW);
    assert.strictEqual(dayStr(result), "2026-03-21");
  });

  test("3주 전", () => {
    const result = parseTemporalExpression("3주 전", NOW);
    assert.strictEqual(dayStr(result), "2026-03-07");
  });

  test("2개월 전", () => {
    const result = parseTemporalExpression("2개월 전", NOW);
    assert.strictEqual(dayStr(result), "2026-01-28");
  });

  test("1달 전", () => {
    const result = parseTemporalExpression("1달 전", NOW);
    assert.strictEqual(dayStr(result), "2026-02-28");
  });

  test("1년 전", () => {
    const result = parseTemporalExpression("1년 전", NOW);
    assert.strictEqual(dayStr(result), "2025-03-28");
  });
});

describe("parseTemporalExpression - 고정 키워드", () => {

  test("오늘", () => {
    const result = parseTemporalExpression("오늘", NOW);
    assert.strictEqual(dayStr(result), "2026-03-28");
    assert.strictEqual(result.getHours(), 0);
  });

  test("어제", () => {
    const result = parseTemporalExpression("어제", NOW);
    assert.strictEqual(dayStr(result), "2026-03-27");
  });

  test("그제", () => {
    const result = parseTemporalExpression("그제", NOW);
    assert.strictEqual(dayStr(result), "2026-03-26");
  });

  test("그저께", () => {
    const result = parseTemporalExpression("그저께", NOW);
    assert.strictEqual(dayStr(result), "2026-03-26");
  });

  test("이번 주 (월요일 시작)", () => {
    const result = parseTemporalExpression("이번 주", NOW);
    /** 2026-03-28은 토요일 → 이번 주 월요일은 3/23 */
    assert.strictEqual(dayStr(result), "2026-03-23");
  });

  test("지난 주", () => {
    const result = parseTemporalExpression("지난 주", NOW);
    /** 지난 주 월요일: 3/16 */
    assert.strictEqual(dayStr(result), "2026-03-16");
  });

  test("이번 달", () => {
    const result = parseTemporalExpression("이번 달", NOW);
    assert.strictEqual(dayStr(result), "2026-03-01");
  });

  test("지난 달", () => {
    const result = parseTemporalExpression("지난 달", NOW);
    assert.strictEqual(dayStr(result), "2026-02-01");
  });
});

describe("parseTemporalExpression - 지난 X요일", () => {

  test("지난 월요일 (토요일 기준 → 5일 전)", () => {
    const result = parseTemporalExpression("지난 월요일", NOW);
    assert.strictEqual(dayStr(result), "2026-03-23");
  });

  test("지난 화요일", () => {
    const result = parseTemporalExpression("지난 화요일", NOW);
    assert.strictEqual(dayStr(result), "2026-03-24");
  });

  test("지난 금요일", () => {
    const result = parseTemporalExpression("지난 금요일", NOW);
    assert.strictEqual(dayStr(result), "2026-03-27");
  });

  test("지난 토요일 (같은 요일 → 7일 전)", () => {
    const result = parseTemporalExpression("지난 토요일", NOW);
    assert.strictEqual(dayStr(result), "2026-03-21");
  });

  test("지난 일요일 (토요일 기준 → 6일 전)", () => {
    const result = parseTemporalExpression("지난 일요일", NOW);
    assert.strictEqual(dayStr(result), "2026-03-22");
  });
});

describe("parseTemporalExpression - ISO 8601 폴백", () => {

  test("ISO 날짜 문자열", () => {
    const result = parseTemporalExpression("2026-01-15T00:00:00Z", NOW);
    assert.ok(result instanceof Date);
    assert.strictEqual(result.toISOString(), "2026-01-15T00:00:00.000Z");
  });

  test("단순 날짜 형식", () => {
    const result = parseTemporalExpression("2026-03-01", NOW);
    assert.ok(result instanceof Date);
    assert.ok(dayStr(result).startsWith("2026-03-01"));
  });

  test("파싱 불가능한 문자열 → null", () => {
    const result = parseTemporalExpression("알수없는표현", NOW);
    assert.strictEqual(result, null);
  });

  test("null 입력 → null", () => {
    assert.strictEqual(parseTemporalExpression(null, NOW), null);
  });

  test("빈 문자열 → null", () => {
    assert.strictEqual(parseTemporalExpression("", NOW), null);
  });
});

describe("parseTimeRange - 자연어 통합", () => {

  test("from: 자연어, to: ISO", () => {
    const result = parseTimeRange({ from: "3일 전", to: "2026-03-28" });
    assert.ok(result);
    assert.ok(result.from instanceof Date);
    assert.ok(result.to   instanceof Date);
  });

  test("from만 자연어", () => {
    const result = parseTimeRange({ from: "지난 주" });
    assert.ok(result);
    assert.ok(result.from instanceof Date);
    assert.strictEqual(result.to, null);
  });

  test("기존 ISO 호환 유지", () => {
    const result = parseTimeRange({ from: "2026-03-01", to: "2026-03-28" });
    assert.ok(result);
    assert.ok(result.from instanceof Date);
    assert.ok(result.to   instanceof Date);
  });

  test("무효한 자연어 → null", () => {
    const result = parseTimeRange({ from: "알수없음" });
    assert.strictEqual(result, null);
  });

  test("null 입력 → null", () => {
    assert.strictEqual(parseTimeRange(null), null);
  });
});
