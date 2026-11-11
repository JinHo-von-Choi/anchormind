/**
 * EventTimeExtractor - 파편 본문의 날짜 표현에서 사건 시각을 뽑는 규칙 기반 추출기
 *
 * 작성자: 최진호
 * 작성일: 2026-10-12
 *
 * 절대 날짜(2026-10-12, 2026년 10월 12일, October 12, 2026)와 상대 표현(어제, 3일 전, last week)을
 * 기준 시각(말한 시각, 없으면 저장 시각)으로 해석한다. 연도 없는 숫자 날짜(10/12)처럼 읽는 법이
 * 둘 이상인 표현은 뽑지 않는다. LLM을 부르지 않으며 DB와 환경 변수에 닿지 않는다.
 *
 * 날짜 계산은 UTC 달력으로 한다. 서버 시간대에 따라 결과가 달라지지 않게 하기 위해서다.
 *
 * 여러 표현이 있으면 기준 시각과 같은 날을 가리키지 않는 첫 표현을 고른다. 본문 머리의 발화 날짜
 * ("[2026/10/12] ...")가 본문 속 "지난주"보다 앞서 뽑히는 것을 막는다. 모두 같은 날이면 첫 표현을 쓴다.
 */

/** 세계 시각 해석 경고 규칙 이름 */
export const WORLD_TIME_WARNING_RULES = Object.freeze(["mentionTimeInvalid", "eventTimeInvalid", "eventTimeEndInvalid"]);

/** 본문에서 살피는 최대 길이 */
const SCAN_LIMIT = 2000;

const DAY_MS = 86400000;

const EN_MONTHS = Object.freeze({
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11
});

/** 대문자로 시작하는 영어 달 이름. 소문자 may(조동사)를 달로 읽지 않는다. */
const EN_MONTH_RE = "(January|February|March|April|May|June|July|August|September|October|November|December|" +
                    "Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\\.?";

const EN_NUMBER_WORDS = Object.freeze({
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10
});

/**
 * UTC 자정 Date.
 *
 * @param {number} y
 * @param {number} m - 0부터
 * @param {number} d
 * @returns {Date|null} 존재하지 않는 날짜면 null
 */
function utcDate(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2200 || m < 0 || m > 11 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m, d));
  return date.getUTCMonth() === m && date.getUTCDate() === d ? date : null;
}

function startOfUtcDay(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** 월요일 시작 주 */
function startOfUtcWeek(ms) {
  const day  = new Date(ms).getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  return startOfUtcDay(ms) + diff * DAY_MS;
}

function addUtcMonths(ms, n) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
}

/**
 * 정밀도별 결과.
 *
 * @param {number} startMs
 * @param {"day"|"week"|"month"|"year"} precision
 * @returns {{event_time: string, event_time_end: string|null, event_time_precision: string}}
 */
function result(startMs, precision) {
  let endMs = null;
  if (precision === "week")  endMs = startMs + 7 * DAY_MS;
  if (precision === "month") endMs = addUtcMonths(startMs, 1);
  if (precision === "year")  endMs = addUtcMonths(startMs, 12);
  return {
    event_time          : new Date(startMs).toISOString(),
    event_time_end      : endMs === null ? null : new Date(endMs).toISOString(),
    event_time_precision: precision
  };
}

function monthStart(y, m) { return Date.UTC(y, m, 1); }
function yearStart(y)     { return Date.UTC(y, 0, 1); }

/**
 * 상대 단위 이동.
 *
 * @param {number} refMs
 * @param {number} n - 음수면 과거
 * @param {"day"|"week"|"month"|"year"} unit
 * @returns {{start: number, precision: string}}
 */
function shift(refMs, n, unit) {
  const ref = new Date(refMs);
  switch (unit) {
    case "day"  : return { start: startOfUtcDay(refMs) + n * DAY_MS, precision: "day" };
    case "week" : return { start: startOfUtcDay(refMs) + n * 7 * DAY_MS, precision: "day" };
    case "month": return { start: Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + n, ref.getUTCDate()), precision: "day" };
    default     : return { start: Date.UTC(ref.getUTCFullYear() + n, ref.getUTCMonth(), ref.getUTCDate()), precision: "day" };
  }
}

const KO_UNIT = Object.freeze({ "일": "day", "주": "week", "주일": "week", "개월": "month", "달": "month", "년": "year" });

/**
 * 규칙 목록. 각 규칙은 정규식과, 일치와 기준 시각으로 {start, precision}을 만드는 함수다.
 * 같은 위치에서 여러 규칙이 일치하면 더 긴 일치를 쓴다.
 */
const RULES = [
  /** 2026-10-12, 2026/10/12, 2026.10.12 */
  {
    re: /(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g,
    at: m => { const d = utcDate(+m[1], +m[2] - 1, +m[3]); return d && { start: d.getTime(), precision: "day" }; }
  },
  /** 2026년 10월 12일, 2026년 10월 */
  {
    re: /(\d{4})\s*년\s*(\d{1,2})\s*월(?:\s*(\d{1,2})\s*일)?/g,
    at: m => {
      if (m[3]) { const d = utcDate(+m[1], +m[2] - 1, +m[3]); return d && { start: d.getTime(), precision: "day" }; }
      const mm = +m[2] - 1;
      return mm >= 0 && mm <= 11 ? { start: monthStart(+m[1], mm), precision: "month" } : null;
    }
  },
  /** 10월 12일 (연도는 기준 시각) */
  {
    re: /(?<!\d)(\d{1,2})\s*월\s*(\d{1,2})\s*일/g,
    at: (m, ref) => { const d = utcDate(new Date(ref).getUTCFullYear(), +m[1] - 1, +m[2]); return d && { start: d.getTime(), precision: "day" }; }
  },
  /** 2026년 (뒤에 월이 오지 않을 때) */
  {
    re: /(?<!\d)(\d{4})\s*년(?!\s*\d{1,2}\s*월)/g,
    at: m => { const y = +m[1]; return y >= 1900 && y <= 2200 ? { start: yearStart(y), precision: "year" } : null; }
  },
  /** October 12, 2026 / Oct 12 */
  {
    re: new RegExp(`\\b${EN_MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "g"),
    at: (m, ref) => {
      const year = m[3] ? +m[3] : new Date(ref).getUTCFullYear();
      const d    = utcDate(year, EN_MONTHS[m[1].toLowerCase()], +m[2]);
      return d && { start: d.getTime(), precision: "day" };
    }
  },
  /** 12 October 2026 / 12th Oct */
  {
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${EN_MONTH_RE}(?:,?\\s+(\\d{4}))?\\b`, "g"),
    at: (m, ref) => {
      const year = m[3] ? +m[3] : new Date(ref).getUTCFullYear();
      const d    = utcDate(year, EN_MONTHS[m[2].toLowerCase()], +m[1]);
      return d && { start: d.getTime(), precision: "day" };
    }
  },
  /** October 2026 */
  {
    re: new RegExp(`\\b${EN_MONTH_RE}\\s+(\\d{4})\\b`, "g"),
    at: m => ({ start: monthStart(+m[2], EN_MONTHS[m[1].toLowerCase()]), precision: "month" })
  },
  /** 오늘, 어제, 그제, 그저께, 내일, 모레 */
  {
    re: /(오늘(?!날)|어제|그저께|그제|내일|모레)/g,
    at: (m, ref) => {
      const offset = { "오늘": 0, "어제": -1, "그제": -2, "그저께": -2, "내일": 1, "모레": 2 }[m[1]];
      return { start: startOfUtcDay(ref) + offset * DAY_MS, precision: "day" };
    }
  },
  /** 3일 전, 2주 전, 5개월 전, 1년 후 */
  {
    re: /(?<!\d)(\d{1,3})\s*(일|주일|주|개월|달|년)\s*(전|후|뒤)/g,
    at: (m, ref) => shift(ref, (m[3] === "전" ? -1 : 1) * +m[1], KO_UNIT[m[2]])
  },
  /** 지난주, 이번 주, 다음 주 / 지난달 / 작년, 올해, 내년, 재작년 */
  {
    re: /(지난|이번|다음)\s*(주(?![제요식소장문력인차행변체석])|달(?![성러라리려콤]))|(재작년|작년|올해|내년)/g,
    at: (m, ref) => {
      if (m[3]) {
        const y = new Date(ref).getUTCFullYear() + { "재작년": -2, "작년": -1, "올해": 0, "내년": 1 }[m[3]];
        return { start: yearStart(y), precision: "year" };
      }
      const n = { "지난": -1, "이번": 0, "다음": 1 }[m[1]];
      if (m[2] === "주") return { start: startOfUtcWeek(ref) + n * 7 * DAY_MS, precision: "week" };
      return { start: addUtcMonths(ref, n), precision: "month" };
    }
  },
  /** today, yesterday, tomorrow */
  {
    re: /\b(today|yesterday|tomorrow)\b/gi,
    at: (m, ref) => {
      const offset = { today: 0, yesterday: -1, tomorrow: 1 }[m[1].toLowerCase()];
      return { start: startOfUtcDay(ref) + offset * DAY_MS, precision: "day" };
    }
  },
  /** 3 days ago, two weeks ago, a month ago */
  {
    re: /\b(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|week|month|year)s?\s+ago\b/gi,
    at: (m, ref) => {
      const word = m[1].toLowerCase();
      const n    = /^\d+$/.test(word) ? +word : EN_NUMBER_WORDS[word];
      return shift(ref, -n, m[2].toLowerCase());
    }
  },
  /** last week, this month, next year */
  {
    re: /\b(last|this|next)\s+(week|month|year)\b/gi,
    at: (m, ref) => {
      const n    = { last: -1, this: 0, next: 1 }[m[1].toLowerCase()];
      const unit = m[2].toLowerCase();
      if (unit === "week")  return { start: startOfUtcWeek(ref) + n * 7 * DAY_MS, precision: "week" };
      if (unit === "month") return { start: addUtcMonths(ref, n), precision: "month" };
      return { start: yearStart(new Date(ref).getUTCFullYear() + n), precision: "year" };
    }
  }
];

/**
 * 본문의 날짜 표현을 위치 순으로 모은다.
 *
 * @param {string} text
 * @param {number} refMs
 * @returns {Array<{index: number, length: number, start: number, precision: string}>}
 */
function collect(text, refMs) {
  const found = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const hit = rule.at(m, refMs);
      if (hit && Number.isFinite(hit.start)) found.push({ index: m.index, length: m[0].length, ...hit });
    }
  }
  found.sort((a, b) => a.index - b.index || b.length - a.length);
  /** 앞선 일치에 덮인 일치(같은 표현의 짧은 일부)는 버린다 */
  const kept = [];
  let coveredUntil = -1;
  for (const f of found) {
    if (f.index < coveredUntil) continue;
    kept.push(f);
    coveredUntil = f.index + f.length;
  }
  return kept;
}

/**
 * 본문에서 사건 시각을 뽑는다.
 *
 * @param {string} content
 * @param {Date|string|number|null} [reference] - 상대 표현의 기준 시각. 없으면 현재
 * @returns {{event_time: string, event_time_end: string|null, event_time_precision: string}|null}
 */
export function extractEventTime(content, reference = null) {
  if (typeof content !== "string" || content.length === 0) return null;
  const refRaw = reference == null ? Date.now() : new Date(reference).getTime();
  const refMs  = Number.isFinite(refRaw) ? refRaw : Date.now();

  const hits = collect(content.slice(0, SCAN_LIMIT), refMs);
  if (hits.length === 0) return null;

  const refDay = startOfUtcDay(refMs);
  const chosen = hits.find(h => !(h.precision === "day" && h.start === refDay)) ?? hits[0];
  return result(chosen.start, chosen.precision);
}

/**
 * 명시 사건 시각 문자열을 해석한다. YYYY, YYYY-MM, YYYY-MM-DD는 해당 정밀도로, 시각이 있으면 minute로,
 * 그 밖은 날짜 표현(어제, last week)으로 읽는다.
 *
 * @param {string} raw
 * @param {number} refMs
 * @returns {{event_time: string, event_time_end: string|null, event_time_precision: string}|null}
 */
function parseExplicitEventTime(raw, refMs) {
  const s = raw.trim();
  let m = s.match(/^(\d{4})$/);
  if (m) { const y = +m[1]; return y >= 1900 && y <= 2200 ? result(yearStart(y), "year") : null; }
  m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) { const mm = +m[2] - 1; return mm >= 0 && mm <= 11 ? result(monthStart(+m[1], mm), "month") : null; }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) { const d = utcDate(+m[1], +m[2] - 1, +m[3]); return d ? result(d.getTime(), "day") : null; }
  if (/^\d{4}-\d{1,2}-\d{1,2}[T\s]\d{1,2}:\d{2}/.test(s)) {
    const ms = new Date(s).getTime();
    if (!Number.isFinite(ms)) return null;
    return { event_time: new Date(ms).toISOString(), event_time_end: null, event_time_precision: "minute" };
  }
  const hits = collect(s, refMs);
  return hits.length > 0 ? result(hits[0].start, hits[0].precision) : null;
}

/**
 * 쓰기 파라미터와 본문에서 세계 시각 열 값을 정한다.
 *
 *   mentionTime   ISO 시각. 해석할 수 없으면 버리고 경고(mentionTimeInvalid)
 *   eventTime     YYYY, YYYY-MM, YYYY-MM-DD, ISO 시각, 또는 날짜 표현. 해석할 수 없으면 버리고 경고(eventTimeInvalid)
 *   eventTimeEnd  ISO 시각. eventTime보다 늦어야 하며 아니면 버리고 경고(eventTimeEndInvalid)
 *
 * eventTime이 없고 extract가 참이면 본문에서 뽑는다. 상대 표현의 기준은 mentionTime, 없으면 now다.
 *
 * @param {{mentionTime?: unknown, eventTime?: unknown, eventTimeEnd?: unknown}} params
 * @param {string} content
 * @param {{extract?: boolean, now?: number}} [options]
 * @returns {{fields: {mention_time: string|null, event_time: string|null, event_time_end: string|null, event_time_precision: string|null}, warnings: Array<{rule: string}>}}
 */
export function resolveWorldTime(params, content, { extract = true, now = Date.now() } = {}) {
  const warnings = [];
  const mention  = parseMentionTime(params?.mentionTime, warnings);
  const refMs    = mention ? new Date(mention).getTime() : now;
  const event    = resolveEvent(params?.eventTime, content, refMs, extract, warnings);
  const fields   = {
    mention_time        : mention,
    event_time          : event?.event_time ?? null,
    event_time_end      : event?.event_time_end ?? null,
    event_time_precision: event?.event_time_precision ?? null
  };
  if (isGiven(params?.eventTimeEnd)) {
    const end = validEnd(params.eventTimeEnd, fields.event_time);
    if (end) fields.event_time_end = end;
    else warnings.push({ rule: "eventTimeEndInvalid" });
  }
  return { fields, warnings };
}

function isGiven(value) {
  return value != null && value !== "";
}

/** mentionTime을 ISO 문자열로. 없으면 null, 해석할 수 없으면 경고 후 null */
function parseMentionTime(value, warnings) {
  if (!isGiven(value)) return null;
  const ms = typeof value === "string" ? new Date(value).getTime() : NaN;
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  warnings.push({ rule: "mentionTimeInvalid" });
  return null;
}

/** 명시 eventTime을 해석하고, 없으면 extract일 때 본문에서 뽑는다 */
function resolveEvent(value, content, refMs, extract, warnings) {
  if (!isGiven(value)) return extract ? extractEventTime(content, refMs) : null;
  const event = typeof value === "string" ? parseExplicitEventTime(value, refMs) : null;
  if (!event) warnings.push({ rule: "eventTimeInvalid" });
  return event;
}

/** eventTimeEnd가 사건 시작보다 늦으면 ISO 문자열, 아니면 null */
function validEnd(value, eventTime) {
  const endMs   = typeof value === "string" ? new Date(value).getTime() : NaN;
  const startMs = eventTime ? new Date(eventTime).getTime() : NaN;
  return Number.isFinite(endMs) && Number.isFinite(startMs) && endMs > startMs ? new Date(endMs).toISOString() : null;
}

/**
 * amend의 세계 시각 변경. 본문에서 뽑지 않고 준 값만 해석한다. eventTime의 날짜 표현은 같은 호출의
 * mentionTime(없으면 지금) 기준이며, eventTimeEnd는 같은 호출에 eventTime이 있을 때만 받는다.
 *
 * @param {Object} params
 * @returns {{changes: Object, warnings: Array<{rule: string}>}}
 */
export function amendWorldTime(params) {
  if (params.mentionTime === undefined && params.eventTime === undefined && params.eventTimeEnd === undefined) {
    return { changes: {}, warnings: [] };
  }
  const { fields, warnings } = resolveWorldTime(params, "", { extract: false });
  const changes = {};
  if (fields.mention_time) changes.mention_time = fields.mention_time;
  if (fields.event_time) {
    changes.event_time           = fields.event_time;
    changes.event_time_end       = fields.event_time_end;
    changes.event_time_precision = fields.event_time_precision;
  }
  return { changes, warnings };
}
