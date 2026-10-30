// iron-laws: ignore-file[IL-307] null은 입력 없음이나 해석 불가를 뜻하는 정상 결과이고, 호출자가 timeRange 없음으로 처리한다
/**
 * TimeRangeParse - recall timeRange 인자 해석
 *
 * 작성자: 최진호
 * 작성일: 2026-10-31
 *
 * { from, to, basis }를 Date 구간으로 바꾼다. from과 to는 ISO 날짜나 자연어 표현("3일 전", "지난 주")을 받는다.
 */

import { logWarn } from "../../logger.js";

/**
 * timeRange 파라미터 파싱 및 검증
 *
 * @param {Object|undefined} raw - { from?: string, to?: string, basis?: "created"|"event" }
 * @returns {{ from: Date|null, to: Date|null, basis: "created"|"event" }|null}
 */
export function parseTimeRange(raw) {
  if (!raw || typeof raw !== "object") return null;

  const result = { from: null, to: null, basis: raw.basis === "event" ? "event" : "created" };

  if (raw.from) {
    const d = parseTemporalExpression(raw.from);
    if (!d) {
      logWarn(`[FragmentSearch] invalid timeRange.from: ${raw.from}`);
      return null;
    }
    result.from = d;
  }

  if (raw.to) {
    const d = parseTemporalExpression(raw.to);
    if (!d) {
      logWarn(`[FragmentSearch] invalid timeRange.to: ${raw.to}`);
      return null;
    }
    result.to = d;
  }

  if (!result.from && !result.to) return null;

  return result;
}

/**
 * 자연어 시간 표현을 Date로 파싱하는 순수 함수
 *
 * 지원 패턴 (한국어):
 *   - "N일 전", "N주 전", "N개월 전", "N년 전"
 *   - "오늘", "어제", "그제"/"그저께"
 *   - "이번 주", "지난 주", "이번 달", "지난 달"
 *   - "지난 월요일"~"지난 일요일"
 * ISO 8601 폴백: 위 패턴 미매칭 시 Date 생성자로 파싱
 *
 * @param {string} expr - 자연어 또는 ISO 8601 문자열
 * @param {Date}   [now] - 기준 시각 (테스트용, 기본 현재)
 * @returns {Date|null}
 */
export function parseTemporalExpression(expr, now = new Date()) {
  if (!expr || typeof expr !== "string") return null;
  const s = expr.trim();

  /** N일/주/개월/년 전 */
  const relative = relativeDaysAgo(s, now);
  if (relative) return relative;

  /** 고정 키워드 */
  const keyword = s.replace(/\s+/g, "");
  switch (keyword) {
    case "오늘":     return _startOfDay(new Date(now));
    case "어제":     { const d = new Date(now); d.setDate(d.getDate() - 1); return _startOfDay(d); }
    case "그제":
    case "그저께":   { const d = new Date(now); d.setDate(d.getDate() - 2); return _startOfDay(d); }
    case "이번주":   return _startOfWeek(now, 0);
    case "지난주":   return _startOfWeek(now, -1);
    case "이번달":   return _startOfMonth(now, 0);
    case "지난달":   return _startOfMonth(now, -1);
  }

  /** 지난 X요일 */
  const dayNames = { "월요일": 1, "화요일": 2, "수요일": 3, "목요일": 4, "금요일": 5, "토요일": 6, "일요일": 0 };
  const dayMatch = s.match(/^지난\s*(월요일|화요일|수요일|목요일|금요일|토요일|일요일)$/);
  if (dayMatch) {
    const targetDay = dayNames[dayMatch[1]];
    const d         = new Date(now);
    const currentDay = d.getDay();
    let   diff       = currentDay - targetDay;
    if (diff <= 0) diff += 7;
    d.setDate(d.getDate() - diff);
    return _startOfDay(d);
  }

  /** ISO 8601 폴백 */
  const parsed = new Date(s);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/** "N일 전" 표현의 단위별 날짜 이동 */
const RELATIVE_UNITS = Object.freeze({
  "일"  : (d, n) => d.setDate(d.getDate() - n),
  "주"  : (d, n) => d.setDate(d.getDate() - n * 7),
  "개월": (d, n) => d.setMonth(d.getMonth() - n),
  "달"  : (d, n) => d.setMonth(d.getMonth() - n),
  "년"  : (d, n) => d.setFullYear(d.getFullYear() - n)
});

/**
 * "N일/주/개월/달/년 전"을 그날 0시로 바꾼다. 형식이 다르면 null.
 *
 * @param {string} s
 * @param {Date}   now
 * @returns {Date|null}
 */
function relativeDaysAgo(s, now) {
  const match = s.match(/^(\d+)\s*(일|주|개월|달|년)\s*전$/);
  if (!match) return null;
  const d = new Date(now);
  RELATIVE_UNITS[match[2]](d, parseInt(match[1], 10));
  return _startOfDay(d);
}

function _startOfDay(d) {
  d.setHours(0, 0, 0, 0);
  return d;
}

function _startOfWeek(now, offset) {
  const d          = new Date(now);
  const currentDay = d.getDay();
  const mondayDiff = (currentDay === 0 ? -6 : 1 - currentDay) + offset * 7;
  d.setDate(d.getDate() + mondayDiff);
  return _startOfDay(d);
}

function _startOfMonth(now, offset) {
  const d = new Date(now);
  d.setMonth(d.getMonth() + offset, 1);
  return _startOfDay(d);
}
