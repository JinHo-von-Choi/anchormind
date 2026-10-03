/**
 * ContextLines - context 주입 줄 렌더러
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 앵커, core, learning, working 구획을 주입 줄로 만든다. 헤더 문자열([ANCHOR MEMORY] 등)과
 * 줄 머리 "- "는 고정이고, annotate가 켜지면 기억 줄 끝에만 " (YYYY-MM-DD, assertion)"을 붙인다.
 * 날짜는 UTC 기준 저장일이며 상대 날짜는 쓰지 않는다. assertion은 저장소 CHECK 제약의 네 값만
 * 싣고, 그 밖의 값은 버린다. origin이 켜지면 출처 값(ORIGINS)을 괄호 끝에 덧붙인다.
 * DB, 설정, 환경 변수에 닿지 않는 순수 함수만 둔다.
 */

import { ORIGINS, originLabel } from "../provenance.js";

/** fragments.assertion_status가 가질 수 있는 값 */
export const ASSERTION_STATUSES = Object.freeze(["observed", "inferred", "verified", "rejected"]);

const KNOWN_ASSERTIONS = new Set(ASSERTION_STATUSES);

/** 가장 긴 주석 " (YYYY-MM-DD, observed)"의 문자 수. 네 assertion 값은 모두 8자다. */
export const CONTEXT_ANNOTATION_MAX_CHARS = 23;

/** 주석 한 줄의 고정 선택 비용. context 선택이 쓰는 문자 수 / 4 올림 추정과 같은 단위다. */
export const CONTEXT_ANNOTATION_TOKENS = Math.ceil(CONTEXT_ANNOTATION_MAX_CHARS / 4);

/** 출처를 실을 때 더해지는 가장 긴 꼬리 ", external_content"의 문자 수. ORIGINS에서 구한다. */
export const CONTEXT_ANNOTATION_ORIGIN_CHARS = 2 + Math.max(...ORIGINS.map(o => o.length));

/**
 * 주석 한 줄의 고정 선택 비용. withOrigin이면 출처 꼬리까지 센 가장 긴 주석의 문자 수 / 4 올림이다.
 *
 * @param {{withOrigin?: boolean}} [options]
 * @returns {number}
 */
export function contextAnnotationTokens({ withOrigin = false } = {}) {
  const chars = CONTEXT_ANNOTATION_MAX_CHARS + (withOrigin ? CONTEXT_ANNOTATION_ORIGIN_CHARS : 0);
  return Math.ceil(chars / 4);
}

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
 * withOrigin이면 알려진 출처 값을 마지막에 싣는다.
 *
 * @param {{created_at?: unknown, added_at?: unknown, assertion_status?: unknown, origin?: unknown}|null} fragment
 * @param {{withOrigin?: boolean}} [options]
 * @returns {string} 붙일 것이 없으면 빈 문자열
 */
export function contextAnnotation(fragment, { withOrigin = false } = {}) {
  if (!fragment) return "";
  const date      = formatUtcDate(fragment.created_at) ?? formatUtcDate(fragment.added_at);
  const assertion = assertionLabel(fragment.assertion_status);
  const origin    = withOrigin ? originLabel(fragment.origin) : null;
  const parts     = [date, assertion, origin].filter(Boolean);
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
 * 구획별 주입 줄을 만든다. 앵커 파편에 비식별 주체 표지(principal)가 있으면 줄 머리 뒤에 `[principal]`을 붙인다.
 *
 * @param {{anchor?: object[], core?: object[], learning?: object[], working?: object[]}} sections
 * @param {{annotate?: boolean, origin?: boolean, metaOf?: (fragment: object) => object}} [options]
 *   metaOf는 주석에 쓸 필드를 가진 객체를 돌려준다(기본: 파편 자신). origin이면 주석에 출처를 싣는다.
 * @returns {string[]}
 */
export function renderContextSectionLines(sections, { annotate = false, origin = false, metaOf = fragment => fragment } = {}) {
  const tail     = fragment => (annotate ? contextAnnotation(metaOf(fragment), { withOrigin: origin }) : "");
  const line     = fragment => `- ${fragment.content}${tail(fragment)}`;
  const anchorOf = fragment => (fragment.principal ? `- [${fragment.principal}] ${fragment.content}${tail(fragment)}` : line(fragment));
  const lines    = [];
  const anchor   = sections.anchor   || [];
  const learning = sections.learning || [];
  const working  = sections.working  || [];
  const core     = groupByType(sections.core || []);

  if (anchor.length > 0) {
    lines.push("[ANCHOR MEMORY]", ...anchor.map(anchorOf));
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
