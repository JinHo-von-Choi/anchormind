import { getPrimaryPool } from "../tools/db.js";
import { queryScoped, ROW_SUBJECT } from "../tools/row-scope.js";
import { SCHEMA } from "../memory/schema.js";
import { keyScopeCondition } from "../memory/keyScope.js";
import { NOT_WM_ROW } from "../memory/WorkingMemorySql.js";
import { deterministicOrderBy } from "../memory/read/DeterministicRanking.js";
import { adminFragmentListDuration } from "../metrics.js";
import { logError } from "../logger.js";
import { adminScopeOf } from "./AdminAuthz.js";
import { scopePredicate } from "./ScopeFilter.js";
import { fetchGroupKeyIds, parseKeyIdsScope } from "./admin-key-filter.js";
import {
  decodeFragmentListCursor, encodeFragmentListCursor, fragmentListAfter, fragmentListContext, fragmentListCursorEnabled
} from "./fragment-list-cursor.js";

/** 목록 detail=true 시 추가하는 파편 확장 컬럼 (기본 SELECT의 access_count 제외) */
const DETAIL_COLUMNS =
  "assertion_status, ttl_tier, is_anchor, case_id, accessed_at, valid_to, affect, workspace";

/** LIKE 패턴 내 와일드카드 문자(%, _, \) 이스케이프 */
export function escapeLike(str) {
  return str.replace(/[%_\\]/g, "\\$&");
}

/**
 * 파편 목록 질의의 단순 필터 사상표.
 *
 * 조회 인자마다 컬럼과 비교 연산이 다를 뿐 조립 절차는 같다. 차이를 표로 두고
 * 절차는 한 번만 쓴다. 키 격리와 그룹 조회는 별도 판정이 필요해 표 밖에 둔다.
 */
const FRAGMENT_FILTERS = [
  { param: "q",                column: "content",          op: "ILIKE", like: true },
  { param: "topic",            column: "topic",            op: "ILIKE", like: true },
  { param: "type",             column: "type",             op: "=" },
  { param: "assertion_status", column: "assertion_status", op: "=" },
  { param: "ttl_tier",         column: "ttl_tier",         op: "=" },
  { param: "case_id",          column: "case_id",          op: "=" },
  { param: "created_from",     column: "created_at",       op: ">=" },
  { param: "created_to",       column: "created_at",       op: "<=" }
];

/**
 * 조회 인자에서 WHERE 조건과 바인딩을 만든다.
 *
 * @param {URL}   url
 * @param {Array} params 바인딩 배열 (in-place로 push된다)
 * @param {Object} pool  그룹 조회용 커넥션 풀
 * @returns {Promise<string[]>} 조건 문자열 배열
 */
async function buildFragmentFilters(url, params, pool) {
  const conditions = [NOT_WM_ROW];

  for (const spec of FRAGMENT_FILTERS) {
    const raw = url.searchParams.get(spec.param);
    if (!raw) continue;
    params.push(spec.like ? `%${escapeLike(raw)}%` : raw);
    conditions.push(`${spec.column} ${spec.op} $${params.length}`);
  }

  const isAnchorRaw = url.searchParams.get("is_anchor");
  if (isAnchorRaw === "true" || isAnchorRaw === "false") {
    params.push(isAnchorRaw === "true");
    conditions.push(`is_anchor = $${params.length}`);
  }

  const minAccess = parseInt(url.searchParams.get("min_access_count"), 10);
  if (!Number.isNaN(minAccess)) {
    params.push(minAccess);
    conditions.push(`access_count >= $${params.length}`);
  }

  /** 키 격리. 단일 키, 콤마 구분 목록, 그룹 소속 세 경로가 있다. */
  const keyId = url.searchParams.get("key_id");
  if (keyId) conditions.push(keyScopeCondition(params, "key_id", keyId));

  const listScope = parseKeyIdsScope(url);
  if (listScope.groupKeyIds) conditions.push(keyScopeCondition(params, "key_id", listScope.groupKeyIds));

  const groupId = url.searchParams.get("group_id") || null;
  if (groupId) {
    const memberKeyIds = await fetchGroupKeyIds(pool, groupId);
    /** 구성원이 없는 그룹은 결과가 없어야 한다. 조건을 빼면 전체가 보인다. */
    conditions.push(memberKeyIds.length > 0
      ? keyScopeCondition(params, "key_id", memberKeyIds)
      : "FALSE");
  }

  return conditions;
}

function listOptions(query) {
  const page = Math.max(1, parseInt(query.get("page") || "1", 10) || 1);
  const rawLimit = parseInt(query.get("limit") || "20", 10);
  const limit = Math.min(100, Math.max(1, Number.isNaN(rawLimit) ? 20 : rawLimit));
  const cursor = query.get("cursor");
  const countOnly = query.get("count_only") === "true";
  const includeTotal = cursor === null && query.get("include_total") !== "false";
  return { page, limit, cursor, countOnly, includeTotal, detail: query.get("detail") === "true" };
}

function listQuery(pool, { cursor, countOnly, includeTotal }) {
  const mode = countOnly ? "count_only" : cursor !== null ? "cursor" : includeTotal ? "full" : "page_only";
  return (stage, sql, values) => {
    const end = adminFragmentListDuration.startTimer({ stage, mode });
    return queryScoped(pool, sql, values, ROW_SUBJECT.ADMIN).finally(end);
  };
}

async function countFragments(query, where, params, scope) {
  const values = [...params];
  const { rows } = await query("count",
    `SELECT COUNT(*)::int AS total FROM ${SCHEMA}.fragments ${where} AND ${scopePredicate(values, "workspace", scope)}`,
    values);
  return rows[0]?.total ?? 0;
}

function listItems(query, where, params, scope, { limit, includeTotal, cursor, position, page, detail }) {
  params.push(includeTotal ? limit : limit + 1);
  const limitParam = `$${params.length}`;
  const seekClause = fragmentListAfter(params, position);
  const offsetClause = cursor === null ? ` OFFSET $${params.push((page - 1) * limit)}` : "";
  const columns = detail ? `, ${DETAIL_COLUMNS}` : "";
  const cursorTime = cursor === null ? "" : ", created_at::text AS cursor_time";
  const pageSql = `
    SELECT id, topic, type, key_id, agent_id, LEFT(content, 200) AS content,
           keywords, access_count, importance, created_at${columns}${cursorTime}
      FROM ${SCHEMA}.fragments
     ${where} AND ${scopePredicate(params, "workspace", scope)}${seekClause}
     ${deterministicOrderBy()}
     LIMIT ${limitParam}${offsetClause}`;
  if (!includeTotal) return query("items", pageSql, params);
  // 두 하위 쿼리의 문장 스냅샷은 같다. 빈 페이지도 총계를 돌려준다.
  return query("items", `SELECT p.*, n.total AS total_count
    FROM (SELECT COUNT(*)::int AS total FROM ${SCHEMA}.fragments
           ${where} AND ${scopePredicate(params, "workspace", scope)}) n
    LEFT JOIN LATERAL (${pageSql}) p ON TRUE ${deterministicOrderBy("", "p")}`, params);
}

function listBody(rows, options, context) {
  const { cursor, includeTotal, page, limit } = options;
  if (includeTotal) {
    const total = rows[0]?.total_count ?? 0;
    const items = rows.filter(row => row.id !== null).map(({ total_count: _total, ...item }) => item);
    return { items, total, page, limit };
  }
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  if (cursor === null) return { items, hasMore, page, limit };
  const last = items.at(-1);
  return {
    items: items.map(({ cursor_time: _time, ...item }) => item), hasMore,
    nextCursor: hasMore ? encodeFragmentListCursor(last.cursor_time, last.id, context) : null, limit
  };
}

function reply(res, status, body) {
  res.statusCode = status;
  res.end(JSON.stringify(body));
  return true;
}

/** 관리자 목록의 기존 번호, 빠른 페이지, 총계 및 커서 응답. */
export async function handleFragmentList(req, res, url) {
  try {
    const options = listOptions(url.searchParams);
    const { cursor, countOnly, includeTotal } = options;
    if (cursor !== null && !fragmentListCursorEnabled) return reply(res, 503, { error: "cursor_unavailable" });
    const pool = getPrimaryPool();
    const params = [];
    const filters = await buildFragmentFilters(url, params, pool);
    const where = "WHERE " + filters.join(" AND ");
    const scope = adminScopeOf(req);
    const context = cursor === null ? null : fragmentListContext(filters, params, scope);
    const position = cursor ? decodeFragmentListCursor(cursor, context) : null;
    if ((cursor && !position) || (cursor !== null && countOnly)) return reply(res, 400, { error: "invalid_cursor" });
    const query = listQuery(pool, options);
    if (countOnly) return reply(res, 200, { total: await countFragments(query, where, params, scope) });
    const { rows } = await listItems(query, where, params, scope, { ...options, position });
    return reply(res, 200, listBody(rows, options, context));
  } catch (err) {
    logError("[Admin] /memory/fragments error:", err);
    return reply(res, 500, { error: "Internal error" });
  }
}
