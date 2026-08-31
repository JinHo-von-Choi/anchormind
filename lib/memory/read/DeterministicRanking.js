/**
 * 모든 랭킹 표면이 공유하는 결정적 동점 정렬 계약.
 *
 * 1. 호출자가 제공한 기존 primary score 내림차순
 * 2. created_at 내림차순 (NULL/invalid last)
 * 3. id 오름차순
 */

/**
 * PostgreSQL ORDER BY 절을 공통 계약으로 만든다.
 * primaryExpression에는 방향까지 포함한다(예: "f.importance DESC").
 */
export function deterministicOrderBy(primaryExpression = "", alias = "") {
  const prefix = alias ? `${alias}.` : "";
  const primary = primaryExpression ? `${primaryExpression}, ` : "";
  return `ORDER BY ${primary}${prefix}created_at DESC NULLS LAST, ${prefix}id ASC`;
}

/** Date/ISO 문자열/epoch를 비교 가능한 epoch ms로 정규화한다. */
export function normalizeCreatedAt(value) {
  if (value === null || value === undefined || value === "") return null;
  const timestamp = value instanceof Date
    ? value.getTime()
    : (typeof value === "number" ? value : Date.parse(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** 임의 timestamp 필드 DESC NULLS LAST, id ASC 비교. */
export function compareTimestampDescThenId(a, b, timestampField = "created_at") {
  const aCreatedAt = normalizeCreatedAt(a?.[timestampField]);
  const bCreatedAt = normalizeCreatedAt(b?.[timestampField]);

  if (aCreatedAt !== bCreatedAt) {
    if (aCreatedAt === null) return 1;
    if (bCreatedAt === null) return -1;
    return bCreatedAt - aCreatedAt;
  }

  const aId = a?.id == null ? null : String(a.id);
  const bId = b?.id == null ? null : String(b.id);
  if (aId === bId) return 0;
  if (aId === null) return 1;
  if (bId === null) return -1;
  return aId < bId ? -1 : 1;
}

/** created_at DESC NULLS LAST, id ASC 비교. */
export function compareDeterministicTies(a, b) {
  return compareTimestampDescThenId(a, b, "created_at");
}

/** 기존 점수 의미는 건드리지 않고 완전 동점일 때만 공통 계약을 적용한다. */
export function compareRankedFragments(a, b, scoreOf) {
  const aScore = Number(scoreOf(a));
  const bScore = Number(scoreOf(b));
  const aValid = !Number.isNaN(aScore);
  const bValid = !Number.isNaN(bScore);

  if (aValid && bValid && aScore !== bScore) return bScore - aScore;
  if (aValid !== bValid) return aValid ? -1 : 1;
  return compareDeterministicTies(a, b);
}

export function byDescendingScore(scoreOf) {
  return (a, b) => compareRankedFragments(a, b, scoreOf);
}

/** cursor에 직렬화할 최소 랭킹 튜플을 만든다. */
export function toRankingTuple(fragment, score) {
  return {
    score     : Number(score),
    created_at: normalizeCreatedAt(fragment?.created_at),
    id        : fragment?.id == null ? null : String(fragment.id)
  };
}

/** 두 cursor 튜플을 실제 결과 정렬과 같은 방향으로 비교한다. */
export function compareRankingTuples(a, b) {
  return compareTupleValues(a, b);
}

export function encodeRankingCursor(fragment, score, anchorTime) {
  const tuple = toRankingTuple(fragment, score);
  if (!Number.isFinite(tuple.score) || tuple.id === null) return null;
  return Buffer.from(JSON.stringify({ v: 1, anchorTime, ...tuple })).toString("base64url");
}

/** 신규 tuple cursor와 이전 offset cursor를 모두 읽어 롤링 업그레이드를 허용한다. */
export function decodeRankingCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (!decoded || typeof decoded !== "object") return null;
    if (decoded.v === 1 && Number.isFinite(decoded.score) && typeof decoded.id === "string") {
      return {
        v         : 1,
        anchorTime: Number.isFinite(decoded.anchorTime) ? decoded.anchorTime : null,
        score     : decoded.score,
        created_at: normalizeCreatedAt(decoded.created_at ?? decoded.createdAt),
        id        : decoded.id
      };
    }
    if (Number.isInteger(decoded.offset) && decoded.offset >= 0) {
      return {
        v         : 0,
        offset    : decoded.offset,
        anchorTime: Number.isFinite(decoded.anchorTime) ? decoded.anchorTime : null
      };
    }
  } catch { /* 잘못된 cursor는 첫 페이지로 처리 */ }
  return null;
}

/** 이미 공통 comparator로 정렬된 결과에 동일 튜플의 역조건을 적용한다. */
export function paginateRankedFragments(fragments, { cursor, pageSize, anchorTime, scoreOf }) {
  const decoded = decodeRankingCursor(cursor);
  let candidates = fragments;

  if (decoded?.v === 1) {
    candidates = fragments.filter(fragment => {
      const tuple = toRankingTuple(fragment, scoreOf(fragment));
      return compareTupleValues(tuple, decoded) > 0;
    });
  } else if (decoded?.v === 0) {
    candidates = fragments.slice(decoded.offset);
  }

  const paged   = candidates.slice(0, pageSize);
  const hasMore = candidates.length > pageSize;
  const last    = paged[paged.length - 1];
  const nextCursor = hasMore && last
    ? encodeRankingCursor(last, scoreOf(last), anchorTime)
    : null;

  return {
    fragments : paged,
    count     : paged.length,
    totalCount: fragments.length,
    nextCursor,
    hasMore
  };
}

function compareTupleValues(a, b) {
  const aScore = Number(a?.score);
  const bScore = Number(b?.score);
  if (aScore !== bScore) return bScore - aScore;
  return compareDeterministicTies(
    { id: a?.id, created_at: a?.created_at },
    { id: b?.id, created_at: b?.created_at }
  );
}
