/**
 * 관리 API: 감사 조회, JSONL 내보내기, 체인 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 *   GET  /audit                       최근 순 목록. 조건: action(정확히 또는 'admin.*' 접두어), actor(master,
 *                                     anonymous, system 또는 키 id), target_type, target_id, outcome, workspace,
 *                                     from, to, before(seq 커서), limit(1~200, 기본 50)
 *   GET  /audit/export?format=jsonl   같은 조건(limit 제외)의 행을 seq 오름차순 JSONL로 내려 준다. 줄마다
 *                                     prev_hash와 row_hash를 담아 밖에서 다시 검증할 수 있다
 *   POST /audit/verify                체인을 다시 계산해 확인한다. 본문(선택): { fromSeq, maxRows }
 *
 * 세 라우트 모두 마스터 인증 뒤에 온다(admin-routes.js). 내보내기와 검증 요청 자신도 감사 대상이다
 * (admin-audit-actions.js).
 */

import { getPrimaryPool }  from "../tools/db.js";
import { readJsonBody }    from "../utils.js";
import { logError }        from "../logger.js";
import { ADMIN_BASE, safeErrorMessage } from "./admin-auth.js";
import { writeLine }       from "./admin-export.js";
import { AuditStore, AuditQueryError, parseAuditFilters, AUDIT_VERIFY_MAX_ROWS } from "../logging/AuditStore.js";

const MISSING_TABLE = "42P01";

/** 검증 본문 오류 */
class AuditVerifyInputError extends Error {
  /**
   * @param {string} field
   * @param {string} message
   */
  constructor(field, message) {
    super(message);
    this.name  = "AuditVerifyInputError";
    this.field = field;
  }
}

/**
 * 검증 본문의 정수 필드.
 *
 * @param {object} body
 * @param {string} field
 * @param {number} max
 * @returns {number|undefined}
 */
function bodyInt(body, field, max) {
  const value = body?.[field];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new AuditVerifyInputError(field, `${field}은 1 이상 ${max} 이하의 정수여야 한다`);
  }
  return value;
}

/**
 * 오류 응답. 조회 조건 오류는 400, 감사 표가 없으면 503, 그 밖은 500이다.
 *
 * @param {import("http").ServerResponse} res
 * @param {unknown} err
 * @param {string} route
 */
function sendAuditError(res, err, route) {
  if (err instanceof AuditQueryError || err instanceof AuditVerifyInputError) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: err.message, field: err.field }));
    return;
  }
  if (err?.statusCode === 413) {
    res.statusCode = 413;
    res.end(JSON.stringify({ error: "Payload too large" }));
    return;
  }
  if (err instanceof SyntaxError) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "body must be valid JSON" }));
    return;
  }
  if (err?.code === MISSING_TABLE) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: "audit table is not available (migration-056)" }));
    return;
  }
  logError(`[Admin] ${route} error:`, err);
  res.statusCode = 500;
  res.end(JSON.stringify({ error: safeErrorMessage(err) }));
}

/**
 * GET /audit
 *
 * @param {AuditStore} store
 */
async function listAudit(req, res, url, store) {
  try {
    const page = await store.list(parseAuditFilters(url.searchParams));
    res.statusCode = 200;
    res.end(JSON.stringify(page));
  } catch (err) {
    sendAuditError(res, err, "GET /audit");
  }
  return true;
}

/**
 * GET /audit/export
 *
 * @param {AuditStore} store
 */
async function exportAudit(req, res, url, store) {
  let started = false;
  try {
    const format = url.searchParams.get("format") ?? "jsonl";
    if (format !== "jsonl") throw new AuditQueryError("format", "format은 jsonl만 지원한다");
    const filters = parseAuditFilters(url.searchParams);
    const rows    = store.scan(filters);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=audit-events.jsonl");
    for await (const event of rows) {
      if (res.destroyed) return true;
      started = true;
      await writeLine(res, `${JSON.stringify(event)}\n`);
    }
    res.end();
  } catch (err) {
    if (!started) {
      res.removeHeader?.("Content-Disposition");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      sendAuditError(res, err, "GET /audit/export");
      return true;
    }
    logError("[Admin] GET /audit/export error:", err);
    if (typeof res.destroy === "function") res.destroy(err);
    else res.end();
  }
  return true;
}

/**
 * POST /audit/verify
 *
 * @param {AuditStore} store
 */
async function verifyAudit(req, res, store) {
  try {
    const body    = await readJsonBody(req);
    const fromSeq = bodyInt(body, "fromSeq", Number.MAX_SAFE_INTEGER);
    const maxRows = bodyInt(body, "maxRows", AUDIT_VERIFY_MAX_ROWS);
    const result  = await store.verify({ fromSeq: fromSeq ?? null, ...(maxRows ? { maxRows } : {}) });
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (err) {
    sendAuditError(res, err, "POST /audit/verify");
  }
  return true;
}

/**
 * /audit 라우트 처리기.
 *
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {URL} url
 * @param {{ store?: AuditStore }} [options] store 기본값: 주 풀의 AuditStore
 * @returns {Promise<boolean>} 처리 여부
 */
export async function handleAudit(req, res, url, { store = null } = {}) {
  if (!url.pathname.startsWith(`${ADMIN_BASE}/audit`)) return false;
  const target = store ?? new AuditStore(getPrimaryPool());
  if (req.method === "GET" && url.pathname === `${ADMIN_BASE}/audit`)        return listAudit(req, res, url, target);
  if (req.method === "GET" && url.pathname === `${ADMIN_BASE}/audit/export`) return exportAudit(req, res, url, target);
  if (req.method === "POST" && url.pathname === `${ADMIN_BASE}/audit/verify`) return verifyAudit(req, res, target);
  return false;
}
