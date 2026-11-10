/**
 * Admin 정리 주기 핸들러
 *
 * 작성자: 최진호
 * 작성일: 2026-11-10
 *
 *   GET  /consolidation/cycles                 최근 정리 주기 목록(limit). 주기마다 단계별, 동작별 변경 건수와 되돌림 여부
 *   POST /consolidation/cycles/:id/rollback    한 주기의 변경을 되돌린다(lib/memory/consolidate/ConsolidationRollback.js)
 *
 * 되돌리기는 감사 기록(consolidation.rollback)을 남긴다.
 */

import { logError }                         from "../logger.js";
import { safeErrorMessage, ADMIN_BASE }     from "./admin-auth.js";
import { getPrimaryPool }                   from "../tools/db.js";
import { deindexRows }                      from "../memory/FragmentIndex.js";
import {
  listCycles, rollbackCycle, CycleNotFoundError, CYCLE_ID_PATTERN, CYCLE_LIST_MAX
} from "../memory/consolidate/ConsolidationRollback.js";

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {Object} body
 */
function send(res, status, body) {
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

/** GET /consolidation/cycles */
async function listHandler(req, res) {
  // iron-laws: ignore[AI-101] 요청 경로를 해석하는 기준 URL이며 접속 주소가 아니다
  const url      = new URL(req.url || "/", "http://localhost");
  const limitRaw = url.searchParams.get("limit");
  const limit    = limitRaw === null ? 20 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > CYCLE_LIST_MAX) {
    send(res, 400, { error: `limit must be an integer from 1 to ${CYCLE_LIST_MAX}`, field: "limit" });
    return;
  }
  try {
    const cycles = await listCycles(getPrimaryPool(), { limit });
    send(res, 200, { success: true, count: cycles.length, cycles });
  } catch (err) {
    logError("[Admin] consolidation cycles error:", err);
    send(res, 500, { error: safeErrorMessage(err) });
  }
}

/** POST /consolidation/cycles/:id/rollback */
async function rollbackHandler(req, res, m) {
  const cycleId = m[1];
  if (!CYCLE_ID_PATTERN.test(cycleId)) {
    send(res, 400, { error: "cycle id is invalid", field: "id" });
    return;
  }
  try {
    const result = await rollbackCycle(getPrimaryPool(), cycleId, { deindex: deindexRows });
    send(res, 200, { success: true, ...result });
  } catch (err) {
    if (err instanceof CycleNotFoundError) {
      send(res, 404, { error: err.message });
      return;
    }
    logError("[Admin] consolidation rollback error:", err);
    send(res, 500, { error: safeErrorMessage(err) });
  }
}

const exact = (path) => (pathname) => (pathname === path ? [] : null);
const regex = (re)   => (pathname) => pathname.match(re);

export const CONSOLIDATION_ROUTES = Object.freeze([
  { method: "GET",  match: exact(`${ADMIN_BASE}/consolidation/cycles`), handler: listHandler },
  { method: "POST", match: regex(new RegExp(`^${ADMIN_BASE}/consolidation/cycles/([^/]+)/rollback$`)), handler: rollbackHandler }
]);

/**
 * /consolidation 라우트를 표에서 찾아 위임한다.
 *
 * @returns {Promise<boolean>} 처리 여부
 */
export async function handleConsolidation(req, res, url) {
  for (const route of CONSOLIDATION_ROUTES) {
    if (req.method !== route.method) continue;
    const m = route.match(url.pathname);
    if (!m) continue;
    await route.handler(req, res, m);
    return true;
  }
  return false;
}
