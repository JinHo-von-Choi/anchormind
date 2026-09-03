/**
 * 모든 랭킹 표면이 공유하는 결정적 동점 정렬 계약.
 *
 * 1. 호출자가 제공한 기존 primary score 내림차순
 * 2. created_at 내림차순
 * 3. id 오름차순
 */

/**
 * PostgreSQL ORDER BY 절을 공통 계약으로 만든다.
 * primaryExpression에는 방향까지 포함한다(예: "f.importance DESC").
 */
export function deterministicOrderBy(primaryExpression = "", alias = "") {
  const prefix = alias ? `${alias}.` : "";
  const primary = primaryExpression ? `${primaryExpression}, ` : "";
  return `ORDER BY ${primary}${prefix}created_at DESC, ${prefix}id ASC`;
}

/** Date/ISO 문자열/epoch를 비교 가능한 epoch ms로 정규화한다. */
export function normalizeCreatedAt(value) {
  if (value === null || value === undefined || value === "") return null;
  const timestamp = value instanceof Date
    ? value.getTime()
    : (typeof value === "number" ? value : Date.parse(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** 임의 timestamp 필드 DESC, id ASC 비교. 기본 null 순서는 기존 JS 계약인 last다. */
export function compareTimestampDescThenId(a, b, timestampField = "created_at", nulls = "last") {
  const aCreatedAt = normalizeCreatedAt(a?.[timestampField]);
  const bCreatedAt = normalizeCreatedAt(b?.[timestampField]);

  if (aCreatedAt !== bCreatedAt) {
    if (aCreatedAt === null) return nulls === "first" ? -1 : 1;
    if (bCreatedAt === null) return nulls === "first" ? 1 : -1;
    return bCreatedAt - aCreatedAt;
  }

  const aId = a?.id == null ? null : String(a.id);
  const bId = b?.id == null ? null : String(b.id);
  if (aId === bId) return 0;
  if (aId === null) return 1;
  if (bId === null) return -1;
  return aId < bId ? -1 : 1;
}

/** PostgreSQL 기본 DESC와 같은 created_at DESC NULLS FIRST, id ASC 비교. */
export function compareDeterministicTies(a, b) {
  return compareTimestampDescThenId(a, b, "created_at", "first");
}

/** 기존 점수 의미는 건드리지 않고 완전 동점일 때만 공통 계약을 적용한다. */
export function compareRankedFragments(a, b, scoreOf) {
  const scoreOrder = compareScoresDescending(scoreOf(a), scoreOf(b));
  if (scoreOrder !== 0) return scoreOrder;
  return compareDeterministicTies(a, b);
}

export function byDescendingScore(scoreOf) {
  return (a, b) => compareRankedFragments(a, b, scoreOf);
}

/** 기존 offset cursor를 엄격하게 읽는다. */
export function decodeRankingCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (!decoded || typeof decoded !== "object") return null;
    if (Number.isInteger(decoded.offset) && decoded.offset >= 0) {
      return {
        offset    : decoded.offset,
        anchorTime: Number.isFinite(decoded.anchorTime) ? decoded.anchorTime : null
      };
    }
  } catch { /* 잘못된 cursor는 첫 페이지로 처리 */ }
  return null;
}

/** 결정적으로 정렬된 결과를 기존 offset cursor 계약으로 자른다. */
export function paginateRankedFragments(fragments, { cursor, pageSize, anchorTime }) {
  const decoded = decodeRankingCursor(cursor);
  const offset  = decoded?.offset ?? 0;
  const paged   = fragments.slice(offset, offset + pageSize);
  const hasMore = offset + pageSize < fragments.length;
  const nextCursor = hasMore
    ? Buffer.from(JSON.stringify({ offset: offset + pageSize, anchorTime })).toString("base64url")
    : null;

  return {
    fragments : paged,
    count     : paged.length,
    totalCount: fragments.length,
    nextCursor,
    hasMore
  };
}

/** 모든 JS 정렬 경로가 공유하는 score 계약. 비유한 값은 유한 score 뒤의 동점으로 취급한다. */
function compareScoresDescending(a, b) {
  const aScore = normalizeRankingScore(a);
  const bScore = normalizeRankingScore(b);
  const aValid = aScore !== null;
  const bValid = bScore !== null;

  if (aValid && bValid && aScore !== bScore) return bScore - aScore;
  if (aValid !== bValid) return aValid ? -1 : 1;
  return 0;
}

function normalizeRankingScore(value) {
  if (value === null || value === undefined || value === "") return null;
  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}
