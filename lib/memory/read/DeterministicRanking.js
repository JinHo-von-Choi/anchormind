/**
 * 모든 랭킹 표면이 공유하는 결정적 동점 정렬 계약.
 *
 * 1. 호출자가 제공한 기존 primary score 내림차순
 * 2. created_at 내림차순
 * 3. id 오름차순
 */

import { createHash } from "node:crypto";

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

/** cursor의 이미 돌려준 파편 표지 길이(문자). id의 SHA-256을 base64url로 적은 앞부분이다. */
const SEEN_KEY_LENGTH = 8;
const SEEN_PATTERN    = /^[A-Za-z0-9_-]*$/;

/**
 * cursor에 담는 파편 표지. 원본 id를 cursor에 드러내지 않고 길이를 고정한다.
 *
 * @param {string} id
 * @returns {string}
 */
export function rankingSeenKey(id) {
  return createHash("sha256").update(String(id)).digest("base64url").slice(0, SEEN_KEY_LENGTH);
}

/**
 * cursor를 엄격하게 읽는다. offset(기존 위치 cursor)과 seen(이미 돌려준 파편 표지를 이어 붙인 문자열) 중
 * 하나 이상이 올바라야 하며, 그렇지 않으면 첫 페이지로 처리한다.
 *
 * @param {string} [cursor]
 * @returns {{offset: number, anchorTime: number|null, seen: Set<string>}|null}
 */
export function decodeRankingCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (!decoded || typeof decoded !== "object") return null;
    const offsetOk = Number.isInteger(decoded.offset) && decoded.offset >= 0;
    const seenOk   = typeof decoded.seen === "string"
      && decoded.seen.length % SEEN_KEY_LENGTH === 0
      && SEEN_PATTERN.test(decoded.seen);
    if (!offsetOk && !seenOk) return null;
    const seen = new Set();
    if (seenOk) {
      for (let i = 0; i < decoded.seen.length; i += SEEN_KEY_LENGTH) seen.add(decoded.seen.slice(i, i + SEEN_KEY_LENGTH));
    }
    return {
      offset    : offsetOk ? decoded.offset : 0,
      anchorTime: Number.isFinite(decoded.anchorTime) ? decoded.anchorTime : null,
      seen
    };
  } catch { /* 잘못된 cursor는 첫 페이지로 처리 */ }
  return null;
}

/** offset과 고정 anchorTime을 담은 cursor를 만든다. */
export function encodeRankingCursor(offset, anchorTime) {
  return Buffer.from(JSON.stringify({ offset, anchorTime })).toString("base64url");
}

/**
 * 이미 돌려준 파편 표지와 고정 anchorTime을 담은 cursor를 만든다. 다음 페이지는 후보 집합이 호출마다 달라져도
 * 이 파편들을 빼고 고르므로 중복이 생기지 않는다.
 *
 * @param {Iterable<string>} seenKeys rankingSeenKey 값
 * @param {number} anchorTime
 * @returns {string}
 */
export function encodeSeenCursor(seenKeys, anchorTime) {
  return Buffer.from(JSON.stringify({ seen: [...seenKeys].join(""), anchorTime })).toString("base64url");
}

/**
 * recall 결과의 페이지 상태 응답 필드. 페이지 정보가 없는 결과는 이 페이지가 전부인 것으로 본다.
 *
 * @param {{totalCount?: number, nextCursor?: string|null, hasMore?: boolean}} result
 * @param {number} count 응답 파편 수
 * @returns {{totalCount: number, nextCursor: string|null, hasMore: boolean}}
 */
export function recallPageState(result, count) {
  return {
    totalCount: result.totalCount ?? count,
    nextCursor: result.nextCursor ?? null,
    hasMore   : result.hasMore === true
  };
}

/** 결정적으로 정렬된 결과를 기존 offset cursor 계약으로 자른다. */
export function paginateRankedFragments(fragments, { cursor, pageSize, anchorTime }) {
  const decoded = decodeRankingCursor(cursor);
  const offset  = decoded?.offset ?? 0;
  const paged   = fragments.slice(offset, offset + pageSize);
  const hasMore = offset + pageSize < fragments.length;
  const nextCursor = hasMore
    ? encodeRankingCursor(offset + pageSize, anchorTime)
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
