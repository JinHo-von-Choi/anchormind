/**
 * ContextLines - context 주입 줄 렌더러
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 앵커, core, learning, working 구획을 주입 줄로 만든다. 헤더 문자열([ANCHOR MEMORY] 등)과
 * 줄 머리 "- "는 고정이고, annotate가 켜지면 기억 줄 끝에만 " (YYYY-MM-DD, assertion)"을 붙인다.
 * 날짜는 UTC 기준 저장일이며 상대 날짜는 쓰지 않는다. assertion은 저장소 CHECK 제약의 네 값만
 * 싣고, 그 밖의 값은 버린다. DB, 설정, 환경 변수에 닿지 않는 순수 함수만 둔다.
 */

/** fragments.assertion_status가 가질 수 있는 값 */
export const ASSERTION_STATUSES = Object.freeze(["observed", "inferred", "verified", "rejected"]);

const KNOWN_ASSERTIONS = new Set(ASSERTION_STATUSES);

/**
 * 시각 값을 UTC 기준 YYYY-MM-DD로 바꾼다.
 *
 * @param {Date|string|number|null|undefined} value
 * @returns {string|null} 해석할 수 없으면 null
 */
export function formatUtcDate(value) {
  if (!(value instanceof Date) && typeof value !== "string" && typeof value !== "number") return null;
  if (value === "") return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * 알려진 assertion 값만 돌려준다.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function assertionLabel(value) {
  return typeof value === "string" && KNOWN_ASSERTIONS.has(value) ? value : null;
}

/**
 * 주입 줄 끝에 붙일 주석. 날짜는 created_at, 없으면 작업 기억 항목의 added_at이다.
 *
 * @param {{created_at?: unknown, added_at?: unknown, assertion_status?: unknown}|null} fragment
 * @returns {string} 붙일 것이 없으면 빈 문자열
 */
export function contextAnnotation(fragment) {
  if (!fragment) return "";
  const date      = formatUtcDate(fragment.created_at) ?? formatUtcDate(fragment.added_at);
  const assertion = assertionLabel(fragment.assertion_status);
  const parts     = [date, assertion].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/**
 * 파편을 type별로 묶는다. 묶음 순서는 처음 나온 순서다.
 *
 * @param {object[]} fragments
 * @returns {Map<string, object[]>}
 */
function groupByType(fragments) {
  const groups = new Map();
  for (const f of fragments) {
    const key = f.type || "general";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  return groups;
}

/**
 * 구획별 주입 줄을 만든다.
 *
 * @param {{anchor?: object[], core?: object[], learning?: object[], working?: object[]}} sections
 * @param {{annotate?: boolean, metaOf?: (fragment: object) => object}} [options]
 *   metaOf는 주석에 쓸 필드를 가진 객체를 돌려준다(기본: 파편 자신).
 * @returns {string[]}
 */
export function renderContextSectionLines(sections, { annotate = false, metaOf = fragment => fragment } = {}) {
  const tail     = fragment => (annotate ? contextAnnotation(metaOf(fragment)) : "");
  const line     = fragment => `- ${fragment.content}${tail(fragment)}`;
  const lines    = [];
  const anchor   = sections.anchor   || [];
  const learning = sections.learning || [];
  const working  = sections.working  || [];
  const core     = groupByType(sections.core || []);

  if (anchor.length > 0) {
    lines.push("[ANCHOR MEMORY]", ...anchor.map(line));
  }

  if (core.size > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("[CORE MEMORY]");
    for (const [type, fragments] of core) {
      lines.push(`[${type.toUpperCase()}]`, ...fragments.map(line));
    }
  }

  if (learning.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("[LEARNING MEMORY]", ...learning.map(line));
  }

  if (working.length > 0) {
    lines.push("", "[WORKING MEMORY]");
    for (const wm of working) {
      const label = wm.type ? `[${wm.type.toUpperCase()}]` : "";
      lines.push(`- ${label} ${wm.content}${tail(wm)}`);
    }
  }

  return lines;
}
