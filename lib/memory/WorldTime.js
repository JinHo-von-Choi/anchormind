/**
 * WorldTime - 파편의 세계 시각(말한 시각, 사건 시각) 해석
 *
 * 작성자: 최진호
 * 작성일: 2026-10-12
 *
 * created_at과 valid_from은 서버가 기록한 시스템 시각이다. 세계 시각 열(migration-065)은 내용을 말한
 * 시각(mention_time)과 내용이 가리키는 사건 시각(event_time, event_time_end, event_time_precision)이다.
 *
 *   말한 시각  mention_time, 없으면 created_at. 시간 근접 랭킹과 모순 해소의 선후 판정이 쓴다
 *   세계 시각  event_time, 없으면 말한 시각. 시간순 정렬과 timeRange basis=event가 쓴다
 *
 * TTL, 감쇠, stale 판정은 시스템 시각을 그대로 쓴다. DB와 환경 변수에 닿지 않는 순수 함수만 둔다.
 */

/** 세계 시각 열. INSERT와 SELECT 목록이 같은 순서를 쓴다. */
export const WORLD_TIME_COLUMNS = Object.freeze([
  "mention_time", "event_time", "event_time_end", "event_time_precision"
]);

/** event_time_precision 허용 값 */
export const EVENT_TIME_PRECISIONS = Object.freeze(["minute", "day", "week", "month", "year"]);

/** timeRange가 비교하는 시각 */
export const TIME_BASES = Object.freeze(["created", "event"]);

/**
 * SELECT 목록 조각. alias가 있으면 "f.mention_time"처럼 붙인다.
 *
 * @param {string} [alias]
 * @returns {string[]}
 */
export function worldTimeSelectColumns(alias = "") {
  const prefix = alias ? `${alias}.` : "";
  return WORLD_TIME_COLUMNS.map(c => `${prefix}${c}`);
}

/**
 * timeRange 비교 식. basis=event는 색인(idx_fragments_world_time)의 식과 같다.
 *
 * @param {"created"|"event"|undefined|null} basis
 * @param {string} [alias]
 * @returns {string}
 */
export function timeRangeColumnSql(basis, alias = "") {
  const prefix = alias ? `${alias}.` : "";
  if (basis === "event") return `COALESCE(${prefix}event_time, ${prefix}mention_time, ${prefix}created_at)`;
  return `${prefix}created_at`;
}

/**
 * timeRangeColumnSql과 같은 기준으로 파편의 시각(epoch ms)을 구한다. 해석할 수 없으면 NaN.
 *
 * @param {object|null|undefined} fragment
 * @param {"created"|"event"|undefined} basis
 * @returns {number}
 */
export function timeRangeValueMs(fragment, basis) {
  if (basis === "event") {
    for (const value of [fragment?.event_time, fragment?.mention_time, fragment?.created_at]) {
      const ms = toMs(value);
      if (Number.isFinite(ms)) return ms;
    }
    return NaN;
  }
  return toMs(fragment?.created_at);
}

/**
 * 값을 epoch ms로 바꾼다. 해석할 수 없으면 NaN.
 *
 * @param {unknown} value
 * @returns {number}
 */
function toMs(value) {
  if (value == null || value === "") return NaN;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * 말한 시각(mention_time, 없으면 created_at)의 epoch ms. 둘 다 없으면 NaN.
 *
 * @param {object|null|undefined} fragment
 * @returns {number}
 */
export function statedAtMs(fragment) {
  const mention = toMs(fragment?.mention_time);
  return Number.isFinite(mention) ? mention : toMs(fragment?.created_at);
}

/**
 * 세계 시각(event_time, 없으면 말한 시각)의 epoch ms. 모두 없으면 NaN.
 *
 * @param {object|null|undefined} fragment
 * @returns {number}
 */
export function worldTimeMs(fragment) {
  const event = toMs(fragment?.event_time);
  return Number.isFinite(event) ? event : statedAtMs(fragment);
}

/**
 * 파편이 저장할 세계 시각 값을 가졌는지.
 *
 * @param {object|null|undefined} fragment
 * @returns {boolean}
 */
export function hasWorldTime(fragment) {
  return fragment != null && WORLD_TIME_COLUMNS.some(c => fragment[c] != null);
}

/**
 * INSERT 문에 덧붙일 세계 시각 열 조각. 값이 없고 force가 아니면 빈 조각이라 문장이 바뀌지 않는다.
 *
 * @param {object|null} fragment
 * @param {number} startIndex - 첫 자리표시자 번호
 * @param {{force?: boolean}} [options] - 같은 문장의 다른 행이 값을 가질 때 NULL로 채운다
 * @returns {{columns: string, placeholders: string, values: Array}}
 */
export function worldTimeInsertParts(fragment, startIndex, { force = false } = {}) {
  if (!force && !hasWorldTime(fragment)) return { columns: "", placeholders: "", values: [] };
  return {
    columns     : `, ${WORLD_TIME_COLUMNS.join(", ")}`,
    placeholders: `, $${startIndex}::timestamptz, $${startIndex + 1}::timestamptz, $${startIndex + 2}::timestamptz, $${startIndex + 3}`,
    values      : WORLD_TIME_COLUMNS.map(c => fragment?.[c] ?? null)
  };
}

/**
 * ISO 문자열이나 Date를 정규화한 ISO 문자열로 바꾼다. 해석할 수 없으면 null.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeInstant(value) {
  const ms = toMs(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * 정밀도에 맞춘 사건 시각 표기. day 이상은 날짜, month는 YYYY-MM, year는 YYYY, minute는 분까지(UTC).
 *
 * @param {unknown} value
 * @param {string|null|undefined} precision
 * @returns {string|null}
 */
export function formatEventTime(value, precision) {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  switch (precision) {
    case "year"  : return iso.slice(0, 4);
    case "month" : return iso.slice(0, 7);
    case "minute": return `${iso.slice(0, 16)}Z`;
    default      : return iso.slice(0, 10);
  }
}

/**
 * 세계 시각 오름차순으로 정렬한 새 배열. 시각이 없는 파편은 뒤에 두고, 같은 시각은 입력(순위) 순서를 지킨다.
 *
 * @param {object[]} fragments
 * @returns {object[]}
 */
export function orderChronologically(fragments) {
  return (fragments ?? [])
    .map((fragment, index) => ({ fragment, index, t: worldTimeMs(fragment) }))
    .sort((a, b) => {
      const af = Number.isFinite(a.t);
      const bf = Number.isFinite(b.t);
      if (af !== bf) return af ? -1 : 1;
      if (af && a.t !== b.t) return a.t - b.t;
      return a.index - b.index;
    })
    .map(entry => entry.fragment);
}

/**
 * SQL을 거치지 않은 후보(L1 보충 조회)에 timeRange를 적용한다. SQL 조건과 같이 from 이상, to 미만이다.
 * basis=event면 세계 시각, 그 밖은 created_at으로 비교하고 시각이 없는 파편은 뺀다.
 *
 * @param {object[]} fragments
 * @param {{from?: Date|string|null, to?: Date|string|null, basis?: string}|null|undefined} timeRange
 * @returns {object[]}
 */
export function filterByTimeRange(fragments, timeRange) {
  if (!timeRange?.from && !timeRange?.to) return fragments;
  const timeOf = timeRange.basis === "event" ? worldTimeMs : f => toMs(f?.created_at);
  const fromMs = timeRange.from ? toMs(timeRange.from) : -Infinity;
  const toEnd  = timeRange.to   ? toMs(timeRange.to)   : Infinity;
  return fragments.filter(f => {
    const t = timeOf(f);
    return Number.isFinite(t) && t >= fromMs && t < toEnd;
  });
}

/**
 * UPDATE SET 절에 세계 시각 열 갱신을 더한다. updates에 키가 있는 열만 바꾼다(null이면 지운다).
 *
 * @param {string[]} setClauses
 * @param {Array} params - 자리표시자 번호는 params 길이로 정한다
 * @param {Object} updates - 열 이름을 키로 한 변경
 */
export function appendWorldTimeAssignments(setClauses, params, updates) {
  for (const column of WORLD_TIME_COLUMNS) {
    if (!Object.hasOwn(updates ?? {}, column)) continue;
    params.push(updates[column] ?? null);
    const cast = column === "event_time_precision" ? "" : "::timestamptz";
    setClauses.push(`${column} = $${params.length}${cast}`);
  }
}
