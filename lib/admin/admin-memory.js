/**
 * Admin 메모리 운영 핸들러
 *
 * 작성자: 최진호
 * 작성일: 2026-03-27
 */

import { getPrimaryPool }       from "../tools/db.js";
import { getSearchMetrics }     from "../memory/signals/SearchMetrics.js";
import { logError }             from "../logger.js";
import { readJsonBody }         from "../utils.js";
import { ADMIN_BASE }           from "./admin-auth.js";
import { keyScopeClause }       from "../memory/keyScope.js";

/**
 * MemoryManager 지연 로딩.
 * 상위 import는 무거운 메모리 스택을 끌어와 경량 admin 테스트(db.js mock)와
 * 충돌하므로, 처리기 호출 시점에만 동적 import 한다.
 * @returns {Promise<import("../memory/MemoryManager.js").MemoryManager>}
 */
async function getManager() {
  const { MemoryManager } = await import("../memory/MemoryManager.js");
  return MemoryManager.getInstance();
}

const MEMORY_PREFIX = `${ADMIN_BASE}/memory`;

/** 목록 detail=true 시 추가하는 파편 확장 컬럼 (기본 SELECT의 access_count 제외) */
const DETAIL_COLUMNS =
  "assertion_status, ttl_tier, is_anchor, case_id, accessed_at, valid_to, affect, workspace";

/**
 * key_ids 콤마 구분 쿼리 파라미터를 스코프 객체로 파싱한다.
 * keyScopeClause / 처리기(_keyId/_groupKeyIds) 양쪽에서 재사용한다.
 * key_ids 미지정(마스터 전체 접근)이면 { keyId: null, groupKeyIds: null }.
 *
 * @param {URL} url
 * @returns {{ keyId: string|null, groupKeyIds: string[]|null }}
 */
export function parseKeyIdsScope(url) {
  const raw = url.searchParams.get("key_ids");
  if (!raw) return { keyId: null, groupKeyIds: null };
  const ids = raw.split(",").map(s => s.trim()).filter(Boolean);
  if (ids.length === 0) return { keyId: null, groupKeyIds: null };
  return { keyId: ids[0], groupKeyIds: ids };
}

/** LIKE 패턴 내 와일드카드 문자(%, _, \) 이스케이프 */
export function escapeLike(str) {
  return str.replace(/[%_\\]/g, "\\$&");
}

/**
 * group_id에 속한 key_id 목록 조회
 * @param {import('pg').Pool} pool
 * @param {string} groupId
 * @returns {Promise<string[]>}
 */
export async function fetchGroupKeyIds(pool, groupId) {
  const { rows } = await pool.query(
    `SELECT key_id FROM agent_memory.api_key_group_members WHERE group_id = $1`,
    [groupId]
  );
  return rows.map(r => r.key_id);
}

/**
 * /memory/* 핸들러
 * @returns {boolean} 처리 여부
 */
export async function handleMemory(req, res, url) {
  if (!url.pathname.startsWith(MEMORY_PREFIX)) {
    return false;
  }

  const subPath = url.pathname.slice(MEMORY_PREFIX.length);

  /** 파편 쓰기·이력 라우트 (POST/PATCH/DELETE + GET :id/history) */
  const fragPathMatch = subPath.match(/^\/fragments\/([^/]+)(\/history)?$/);
  if (subPath === "/fragments" && req.method === "POST") {
    return handleFragmentCreate(req, res);
  }
  if (fragPathMatch) {
    const fragId    = decodeURIComponent(fragPathMatch[1]);
    const isHistory = Boolean(fragPathMatch[2]);
    if (isHistory && req.method === "GET") {
      return handleFragmentHistory(req, res, url, fragId);
    }
    if (!isHistory && req.method === "PATCH") {
      return handleFragmentPatch(req, res, url, fragId);
    }
    if (!isHistory && req.method === "DELETE") {
      return handleFragmentDelete(req, res, url, fragId);
    }
  }

  /** 이하 라우트는 모두 GET 전용 */
  if (req.method !== "GET") {
    return false;
  }

  /** GET /memory/overview */
  if (subPath === "/overview") {
    try {
      const pool = getPrimaryPool();

      const [totalR, typeR, topicR, pendingR, supersededR, recentR] = await Promise.all([
        pool.query("SELECT COUNT(*)::int AS total FROM agent_memory.fragments"),
        pool.query(`SELECT type, COUNT(*)::int AS count
                      FROM agent_memory.fragments
                     GROUP BY type ORDER BY count DESC`),
        pool.query(`SELECT topic, COUNT(*)::int AS count
                      FROM agent_memory.fragments
                     WHERE topic IS NOT NULL
                     GROUP BY topic ORDER BY count DESC
                     LIMIT 50`),
        pool.query(`SELECT COUNT(*)::int AS count
                      FROM agent_memory.fragments
                     WHERE quality_verified IS NULL`),
        pool.query(`SELECT COUNT(DISTINCT from_id)::int AS count
                      FROM agent_memory.fragment_links
                     WHERE relation_type = 'superseded_by'`),
        pool.query(`SELECT id, topic, type, agent_id, LEFT(content, 200) AS preview,
                           importance, created_at
                      FROM agent_memory.fragments
                     ORDER BY created_at DESC
                     LIMIT 10`)
      ]);

      res.statusCode = 200;
      res.end(JSON.stringify({
        totalFragments:  totalR.rows[0]?.total ?? 0,
        byType:          Object.fromEntries(typeR.rows.map(r => [r.type, r.count])),
        byTopic:         topicR.rows.map(r => ({ topic: r.topic, count: r.count })),
        qualityPending:  pendingR.rows[0]?.count ?? 0,
        supersededCount: supersededR.rows[0]?.count ?? 0,
        recentActivity:  recentR.rows
      }));
    } catch (err) {
      logError("[Admin] /memory/overview error:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return true;
  }

  /** GET /memory/search-events?days=7 */
  if (subPath === "/search-events") {
    try {
      const pool   = getPrimaryPool();
      const rawDay = parseInt(url.searchParams.get("days"), 10);
      const days   = Math.min(365, Math.max(1, Number.isNaN(rawDay) ? 7 : rawDay));

      const [summaryR, failedR, feedbackR] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS total_searches
                      FROM agent_memory.search_events
                     WHERE created_at > NOW() - ($1 || ' days')::INTERVAL`, [days]),
        pool.query(`SELECT id, query_type, result_count, latency_ms, created_at
                      FROM agent_memory.search_events
                     WHERE result_count = 0
                       AND created_at > NOW() - ($1 || ' days')::INTERVAL
                     ORDER BY created_at DESC
                     LIMIT 10`, [days]),
        pool.query(`SELECT
                      COUNT(*) FILTER (WHERE relevant  = true)::int AS relevant_count,
                      COUNT(*) FILTER (WHERE sufficient = true)::int AS sufficient_count,
                      COUNT(*)::int AS total
                    FROM agent_memory.tool_feedback
                    WHERE created_at > NOW() - ($1 || ' days')::INTERVAL`, [days])
      ]);

      const fb             = feedbackR.rows[0] ?? {};
      const fbTotal        = fb.total ?? 0;
      const avgRelevance   = fbTotal > 0 ? parseFloat(((fb.relevant_count ?? 0) / fbTotal).toFixed(4)) : null;
      const avgSufficiency = fbTotal > 0 ? parseFloat(((fb.sufficient_count ?? 0) / fbTotal).toFixed(4)) : null;

      const metrics       = await getSearchMetrics();
      const searchMetrics = await metrics.getStats();

      const totalSearches = summaryR.rows[0]?.total_searches ?? 0;
      const failedCount   = failedR.rows.length;

      /** 추가 집계 — 개별 쿼리 실패가 전체 응답을 크래시하지 않도록 allSettled 사용 */
      const [pathDistS, latencyS, topKwS] = await Promise.allSettled([
        pool.query(
          `SELECT search_path, COUNT(*)::int AS cnt
             FROM agent_memory.search_events
            WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
            GROUP BY search_path
            ORDER BY cnt DESC
            LIMIT 20`,
          [days]
        ),
        pool.query(
          `SELECT
             PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY latency_ms) AS p50,
             PERCENTILE_CONT(0.9)  WITHIN GROUP (ORDER BY latency_ms) AS p90,
             PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms) AS p99,
             AVG(latency_ms)::numeric(10,2) AS avg_ms
           FROM agent_memory.search_events
           WHERE created_at > NOW() - ($1 || ' days')::INTERVAL`,
          [days]
        ),
        pool.query(
          `SELECT kw, COUNT(*)::int AS cnt
             FROM agent_memory.search_events,
                  LATERAL unnest(filter_keys) AS kw
            WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
              AND filter_keys IS NOT NULL
            GROUP BY kw
            ORDER BY cnt DESC
            LIMIT 10`,
          [days]
        )
      ]);

      const pathDistribution = pathDistS.status === "fulfilled" ? pathDistS.value.rows : [];
      const latency          = latencyS.status  === "fulfilled" ? (latencyS.value.rows[0] ?? null) : null;
      const topKeywords      = topKwS.status     === "fulfilled" ? topKwS.value.rows : [];

      res.statusCode = 200;
      res.end(JSON.stringify({
        totalSearches,
        avgRelevance,
        avgSufficiency,
        failedQueries:  failedR.rows,
        searchMetrics,
        pathDistribution,
        latency,
        topKeywords,
        zeroResultRate: totalSearches > 0
          ? parseFloat((failedCount / totalSearches).toFixed(4))
          : null
      }));
    } catch (err) {
      logError("[Admin] /memory/search-events error:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return true;
  }

  /** GET /memory/fragments/:id — 파편 상세 (전문 + 1-hop 링크) */
  if (subPath.startsWith("/fragments/")) {
    const fragId = decodeURIComponent(subPath.slice("/fragments/".length));
    if (!fragId || fragId.includes("/")) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Not found" }));
      return true;
    }
    try {
      const pool       = getPrimaryPool();
      const conditions = ["id = $1"];
      const params     = [fragId];

      const groupId = url.searchParams.get("group_id") || null;
      const keyId   = url.searchParams.get("key_id") || null;
      if (groupId) {
        const memberKeyIds = await fetchGroupKeyIds(pool, groupId);
        if (memberKeyIds.length === 0) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "Not found" }));
          return true;
        }
        params.push(memberKeyIds);
        conditions.push(`key_id = ANY($${params.length})`);
      } else if (keyId) {
        params.push(keyId);
        conditions.push(`key_id = $${params.length}`);
      }

      /** key_ids 스코프 (콤마 구분): keyScopeClause 패턴 재사용, 불일치 시 404 */
      const kidScope = parseKeyIdsScope(url);
      if (kidScope.keyId) {
        const clause = keyScopeClause(params, "key_id", kidScope);
        conditions.push(clause.replace(/^ AND /, ""));
      }

      const fragR = await pool.query(
        `SELECT id, content, type, topic, keywords, importance, agent_id, key_id,
                case_id, assertion_status, resolution_status, is_anchor,
                created_at, verified_at, valid_to, access_count,
                ttl_tier, accessed_at, affect, workspace
           FROM agent_memory.fragments
          WHERE ${conditions.join(" AND ")}`,
        params
      );
      if (fragR.rows.length === 0) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Not found" }));
        return true;
      }

      const linkR = await pool.query(
        `SELECT l.relation_type,
                CASE WHEN l.from_id = $1 THEN 'out' ELSE 'in' END AS direction,
                f.id, f.type, f.topic,
                LEFT(f.content, 200) AS preview
           FROM agent_memory.fragment_links l
           JOIN agent_memory.fragments f
             ON f.id = CASE WHEN l.from_id = $1 THEN l.to_id ELSE l.from_id END
          WHERE l.from_id = $1 OR l.to_id = $1
          LIMIT 20`,
        [fragId]
      );

      res.statusCode = 200;
      res.end(JSON.stringify({ fragment: fragR.rows[0], links: linkR.rows }));
    } catch (err) {
      logError("[Admin] /memory/fragments/:id error:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return true;
  }

  /** GET /memory/fragments?topic=&type=&key_id=&page=1&limit=20 */
  if (subPath === "/fragments") {
    try {
      const pool     = getPrimaryPool();
      const page     = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      const rawLimit = parseInt(url.searchParams.get("limit") || "20", 10);
      const limit    = Math.min(100, Math.max(1, Number.isNaN(rawLimit) ? 20 : rawLimit));
      const offset   = (page - 1) * limit;

      const conditions = [];
      const params     = [];
      let   paramIdx   = 1;

      const topic = url.searchParams.get("topic");
      const type  = url.searchParams.get("type");
      const keyId = url.searchParams.get("key_id");
      const q     = url.searchParams.get("q");

      if (q) {
        conditions.push(`content ILIKE $${paramIdx++}`);
        params.push(`%${escapeLike(q)}%`);
      }
      if (topic) {
        conditions.push(`topic ILIKE $${paramIdx++}`);
        params.push(`%${escapeLike(topic)}%`);
      }
      if (type) {
        conditions.push(`type = $${paramIdx++}`);
        params.push(type);
      }
      if (keyId) {
        conditions.push(`key_id = $${paramIdx++}`);
        params.push(keyId);
      }

      /** 확장 필터 */
      const assertionStatus = url.searchParams.get("assertion_status");
      const ttlTier         = url.searchParams.get("ttl_tier");
      const isAnchorRaw     = url.searchParams.get("is_anchor");
      const caseId          = url.searchParams.get("case_id");
      const createdFrom     = url.searchParams.get("created_from");
      const createdTo       = url.searchParams.get("created_to");
      const minAccessRaw    = url.searchParams.get("min_access_count");
      const detail          = url.searchParams.get("detail") === "true";

      if (assertionStatus) {
        conditions.push(`assertion_status = $${paramIdx++}`);
        params.push(assertionStatus);
      }
      if (ttlTier) {
        conditions.push(`ttl_tier = $${paramIdx++}`);
        params.push(ttlTier);
      }
      if (isAnchorRaw === "true" || isAnchorRaw === "false") {
        conditions.push(`is_anchor = $${paramIdx++}`);
        params.push(isAnchorRaw === "true");
      }
      if (caseId) {
        conditions.push(`case_id = $${paramIdx++}`);
        params.push(caseId);
      }
      if (createdFrom) {
        conditions.push(`created_at >= $${paramIdx++}`);
        params.push(createdFrom);
      }
      if (createdTo) {
        conditions.push(`created_at <= $${paramIdx++}`);
        params.push(createdTo);
      }
      const minAccess = parseInt(minAccessRaw, 10);
      if (!Number.isNaN(minAccess)) {
        conditions.push(`access_count >= $${paramIdx++}`);
        params.push(minAccess);
      }

      /** key_ids 스코프 (콤마 구분): key_id = ANY 필터 */
      const listScope = parseKeyIdsScope(url);
      if (listScope.groupKeyIds) {
        conditions.push(`key_id = ANY($${paramIdx++}::text[])`);
        params.push(listScope.groupKeyIds);
      }

      const groupId = url.searchParams.get("group_id") || null;
      if (groupId) {
        const memberKeyIds = await fetchGroupKeyIds(pool, groupId);
        if (memberKeyIds.length > 0) {
          conditions.push(`key_id = ANY($${paramIdx++})`);
          params.push(memberKeyIds);
        } else {
          conditions.push("FALSE");
        }
      }

      const whereClause = conditions.length > 0
        ? "WHERE " + conditions.join(" AND ")
        : "";

      const countParams = [...params];
      const countSql    = `SELECT COUNT(*)::int AS total FROM agent_memory.fragments ${whereClause}`;

      params.push(limit);
      const limitParam = `$${paramIdx++}`;
      params.push(offset);
      const offsetParam = `$${paramIdx++}`;

      const detailSelect = detail ? `,\n               ${DETAIL_COLUMNS}` : "";
      const itemsSql = `
        SELECT id, topic, type, key_id, agent_id,
               LEFT(content, 200) AS content,
               keywords, access_count,
               importance, created_at${detailSelect}
          FROM agent_memory.fragments
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ${limitParam} OFFSET ${offsetParam}`;

      const [countR, itemsR] = await Promise.all([
        pool.query(countSql, countParams),
        pool.query(itemsSql, params)
      ]);

      res.statusCode = 200;
      res.end(JSON.stringify({
        items: itemsR.rows,
        total: countR.rows[0]?.total ?? 0,
        page,
        limit
      }));
    } catch (err) {
      logError("[Admin] /memory/fragments error:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return true;
  }

  /** GET /memory/anomalies */
  if (subPath === "/anomalies") {
    try {
      const pool = getPrimaryPool();

      const [unverifiedR, supersessionR, failedR, staleR] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS count
                      FROM agent_memory.fragments
                     WHERE quality_verified IS NULL`),
        pool.query(`SELECT COUNT(DISTINCT f.id)::int AS count
                      FROM agent_memory.fragments f
                      JOIN agent_memory.fragment_links fl ON fl.from_id = f.id
                     WHERE NOT EXISTS (
                             SELECT 1 FROM agent_memory.fragment_links sl
                              WHERE sl.from_id = f.id AND sl.relation_type = 'superseded_by'
                           )
                     GROUP BY f.id
                    HAVING COUNT(fl.id) >= 3`),
        pool.query(`SELECT id, query_type, result_count, latency_ms, filter_keys, created_at
                      FROM agent_memory.search_events
                     WHERE result_count = 0
                     ORDER BY created_at DESC
                     LIMIT 10`),
        pool.query(`SELECT COUNT(*)::int AS count
                      FROM agent_memory.fragments
                     WHERE accessed_at < NOW() - INTERVAL '30 days'`)
      ]);

      res.statusCode = 200;
      res.end(JSON.stringify({
        qualityUnverified:     unverifiedR.rows[0]?.count ?? 0,
        possibleSupersessions: supersessionR.rows.length,
        failedSearches:        failedR.rows,
        staleFragments:        staleR.rows[0]?.count ?? 0
      }));
    } catch (err) {
      logError("[Admin] /memory/anomalies error:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return true;
  }

  /** GET /memory/graph?topic=xxx&key_id=N&group_id=N&limit=50 */
  if (subPath === "/graph") {
    try {
      const pool    = getPrimaryPool();
      const topic   = url.searchParams.get("topic")  || null;
      const keyId   = url.searchParams.get("key_id") || null;
      const groupId = url.searchParams.get("group_id") || null;
      const limit   = Math.min(10000, Math.max(10, parseInt(url.searchParams.get("limit") || "50", 10)));

      let fragQuery = `SELECT id, content, topic, type, importance, created_at,
                              context_summary, session_id, is_anchor, agent_id,
                              ema_activation, access_count, accessed_at
                       FROM agent_memory.fragments
                       WHERE embedding IS NOT NULL`;
      const fragParams = [];

      if (topic) {
        fragParams.push(topic);
        fragQuery += ` AND topic = $${fragParams.length}`;
      }

      if (keyId) {
        fragParams.push(keyId);
        fragQuery += ` AND key_id = $${fragParams.length}`;
      } else if (groupId) {
        const memberKeyIds = await fetchGroupKeyIds(pool, groupId);
        if (memberKeyIds.length > 0) {
          fragParams.push(memberKeyIds);
          fragQuery += ` AND key_id = ANY($${fragParams.length})`;
        } else {
          fragQuery += ` AND FALSE`;
        }
      }

      fragQuery += ` ORDER BY importance DESC, created_at DESC LIMIT $${fragParams.length + 1}`;
      fragParams.push(limit);

      const fragR = await pool.query(fragQuery, fragParams);
      const ids   = fragR.rows.map(r => r.id);

      let edges = [];
      if (ids.length > 0) {
        const linkR = await pool.query(`
          SELECT from_id, to_id, relation_type, weight
          FROM agent_memory.fragment_links
          WHERE from_id = ANY($1) OR to_id = ANY($1)
        `, [ids]);
        edges = linkR.rows;
      }

      const nodes = fragR.rows.map(r => ({
        id:              r.id,
        label:           r.content.slice(0, 60),
        content:         r.content.slice(0, 300),
        topic:           r.topic,
        type:            r.type,
        importance:      parseFloat(r.importance),
        is_anchor:       r.is_anchor === true,
        agent_id:        r.agent_id ?? null,
        ema_activation:  r.ema_activation != null ? parseFloat(r.ema_activation) : null,
        access_count:    r.access_count   != null ? parseInt(r.access_count, 10)  : 0,
        accessed_at:     r.accessed_at    ?? null,
        created_at:      r.created_at     ?? null,
        context_summary: r.context_summary ?? null,
        session_id:      r.session_id ?? null,
      }));

      res.statusCode = 200;
      res.end(JSON.stringify({ nodes, edges }));
    } catch (err) {
      logError("[Admin] /memory/graph error:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return true;
  }

  return false;
}

/**
 * POST /memory/fragments — 지정 key 명의로 파편 생성 (remember 처리기 재사용)
 * body: { key_id, content, topic, type, keywords?, importance? }
 * 해당 key의 fragment_limit 검사는 MemoryRememberer 내부 QuotaChecker가 수행한다.
 * @returns {Promise<boolean>}
 */
async function handleFragmentCreate(req, res) {
  try {
    const body = await readJsonBody(req);
    const { key_id, content, topic, type, keywords, importance } = body || {};
    if (!content || !topic || !type) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "content, topic, type are required" }));
      return true;
    }

    const mgr    = await getManager();
    const result = await mgr.remember({
      content,
      topic,
      type,
      keywords  : Array.isArray(keywords) ? keywords : undefined,
      importance: typeof importance === "number" ? importance : undefined,
      _keyId    : key_id ?? null
    });

    if (result && result.success === false) {
      /** QuotaChecker: fragment_limit 초과 등 */
      const isQuota = /limit/i.test(result.error || "");
      res.statusCode = isQuota ? 409 : 400;
      res.end(JSON.stringify({ error: result.error }));
      return true;
    }

    res.statusCode = 201;
    res.end(JSON.stringify(result));
  } catch (err) {
    logError("[Admin] POST /memory/fragments error:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Internal error" }));
  }
  return true;
}

/**
 * PATCH /memory/fragments/:id — 파편 갱신 (amend 처리기 재사용)
 * body: { content?, topic?, keywords?, importance?, is_anchor?, assertion_status? }
 * key_ids 스코프 불일치 시 amend 처리기가 권한 없음으로 404 매핑.
 * @returns {Promise<boolean>}
 */
async function handleFragmentPatch(req, res, url, fragId) {
  try {
    const body  = await readJsonBody(req);
    const scope = parseKeyIdsScope(url);

    const mgr    = await getManager();
    const result = await mgr.amend({
      id             : fragId,
      content        : body?.content,
      topic          : body?.topic,
      keywords       : body?.keywords,
      importance     : body?.importance,
      isAnchor       : body?.is_anchor,
      assertionStatus: body?.assertion_status,
      _keyId         : scope.keyId,
      _groupKeyIds   : scope.groupKeyIds ?? undefined
    });

    if (!result || result.updated === false) {
      const notFound = /not found|permission/i.test(result?.error || "");
      res.statusCode = notFound ? 404 : 400;
      res.end(JSON.stringify({ error: result?.error || "Update failed" }));
      return true;
    }

    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (err) {
    logError("[Admin] PATCH /memory/fragments/:id error:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Internal error" }));
  }
  return true;
}

/**
 * DELETE /memory/fragments/:id?dryRun=true — 파편 망각 (forget 처리기 재사용)
 * dryRun 시 삭제 없이 영향 요약만 반환.
 * @returns {Promise<boolean>}
 */
async function handleFragmentDelete(req, res, url, fragId) {
  try {
    const scope  = parseKeyIdsScope(url);
    const dryRun  = url.searchParams.get("dryRun") === "true";

    const mgr    = await getManager();
    const result = await mgr.forget({
      id          : fragId,
      dryRun,
      _keyId      : scope.keyId,
      _groupKeyIds: scope.groupKeyIds ?? undefined
    });

    if (result && result.error) {
      res.statusCode = 404;
      res.end(JSON.stringify(result));
      return true;
    }

    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (err) {
    logError("[Admin] DELETE /memory/fragments/:id error:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Internal error" }));
  }
  return true;
}

/**
 * GET /memory/fragments/:id/history — 파편 이력 (fragmentHistory 처리기 재사용)
 * @returns {Promise<boolean>}
 */
async function handleFragmentHistory(req, res, url, fragId) {
  try {
    const scope  = parseKeyIdsScope(url);
    const mgr    = await getManager();
    const result = await mgr.fragmentHistory({
      id          : fragId,
      _keyId      : scope.keyId,
      _groupKeyIds: scope.groupKeyIds ?? undefined
    });

    if (!result || result.current === null || result.error) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: result?.error || "Not found" }));
      return true;
    }

    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (err) {
    logError("[Admin] GET /memory/fragments/:id/history error:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Internal error" }));
  }
  return true;
}

/**
 * POST /search — key 스코프 recall 프록시 (MemoryRecaller 재사용)
 * body: { key_ids:[], keywords?, text?, type?, topic?, pageSize? }
 * @returns {Promise<boolean>}
 */
export async function handleSearch(req, res, url) {
  if (req.method !== "POST" || url.pathname !== `${ADMIN_BASE}/search`) {
    return false;
  }
  try {
    const body    = await readJsonBody(req);
    const keyIds  = Array.isArray(body?.key_ids)
      ? body.key_ids.map(s => String(s).trim()).filter(Boolean)
      : [];
    const scope   = keyIds.length > 0
      ? { keyId: keyIds[0], groupKeyIds: keyIds }
      : { keyId: null, groupKeyIds: null };

    const mgr    = await getManager();
    const result = await mgr.recall({
      keywords    : Array.isArray(body?.keywords) ? body.keywords : undefined,
      text        : body?.text,
      type        : body?.type,
      topic       : body?.topic,
      pageSize    : body?.pageSize,
      _keyId      : scope.keyId,
      _groupKeyIds: scope.groupKeyIds ?? undefined
    });

    res.statusCode = 200;
    res.end(JSON.stringify({
      fragments : result?.fragments ?? [],
      searchPath: result?.searchPath ?? null,
      count     : result?.count ?? 0,
      totalCount: result?.totalCount ?? (result?.fragments?.length ?? 0)
    }));
  } catch (err) {
    logError("[Admin] POST /search error:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Internal error" }));
  }
  return true;
}

/**
 * GET /search-events?key_ids=&days=30 — search_events 텔레메트리 요약
 * 최근 N일(기본 30) 검색 수·평균 result_count·zero-hit 비율.
 *
 * 주의: search_events.key_id는 INTEGER 컬럼이나 API 키 id는 TEXT(uuid)다.
 * recall 경로가 TEXT keyId를 INTEGER 컬럼에 넣으려다 INSERT가 조용히 실패하므로
 * key 스코프 검색 이벤트는 사실상 적재되지 않는다(마스터 키 검색만 기록됨).
 * 따라서 key_ids 필터는 신뢰할 수 있는 귀속이 불가하며, 응답에 keyScopeNote로 명시한다.
 * @returns {Promise<boolean>}
 */
export async function handleSearchEvents(req, res, url) {
  if (req.method !== "GET" || url.pathname !== `${ADMIN_BASE}/search-events`) {
    return false;
  }
  try {
    const pool   = getPrimaryPool();
    const rawDay = parseInt(url.searchParams.get("days"), 10);
    const days   = Math.min(365, Math.max(1, Number.isNaN(rawDay) ? 30 : rawDay));
    const keyIds = (url.searchParams.get("key_ids") || "")
      .split(",").map(s => s.trim()).filter(Boolean);

    const { rows: [summary] } = await pool.query(
      `SELECT COUNT(*)::int                                  AS total_searches,
              COALESCE(AVG(result_count), 0)::numeric(10,2)  AS avg_result_count,
              COUNT(*) FILTER (WHERE result_count = 0)::int  AS zero_hit_count
         FROM agent_memory.search_events
        WHERE created_at > NOW() - ($1 || ' days')::INTERVAL`,
      [days]
    );

    const total = summary?.total_searches ?? 0;
    res.statusCode = 200;
    res.end(JSON.stringify({
      windowDays    : days,
      totalSearches : total,
      avgResultCount: parseFloat(summary?.avg_result_count ?? 0),
      zeroHitRate   : total > 0
        ? parseFloat((summary.zero_hit_count / total).toFixed(4))
        : null,
      keyScopeNote  : keyIds.length > 0
        ? "search_events.key_id(INTEGER)와 API 키 id(TEXT) 불일치로 키별 귀속 불가 — 전역 요약을 반환함"
        : null
    }));
  } catch (err) {
    logError("[Admin] GET /search-events error:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Internal error" }));
  }
  return true;
}
