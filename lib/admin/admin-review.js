/**
 * Admin 검토 대기열 핸들러
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 *   GET  /review                 검토 대기 목록(key_id, limit, cursor)
 *   POST /review/:id/approve     승인(body: note, idempotencyKey. 헤더 Idempotency-Key도 받는다)
 *   POST /review/:id/reject      거절(같은 본문)
 *
 * 결정은 ReviewStore가 파편 상태 변경과 결정 기록을 한 트랜잭션으로 남긴다. 결정마다 감사 기록
 * (admin review_decision) 한 줄을 남긴다. 결정자는 서버가 확인한 관리 행위자 표기다.
 */

import { readJsonBody }                          from "../utils.js";
import { logError }                              from "../logger.js";
import { logAudit }                              from "../logging/audit.js";
import { safeErrorMessage, adminAuditActor, ADMIN_BASE } from "./admin-auth.js";
import {
  decideReview,
  listReviewQueue,
  parseReviewCursor,
  ReviewNotFoundError,
  ReviewStateError,
  ReviewIdempotencyConflictError,
  REVIEW_NOTE_MAX,
  REVIEW_IDEMPOTENCY_KEY_MAX,
  REVIEW_LIST_MAX
} from "./ReviewStore.js";

/** 멱등 키에 쓸 수 있는 문자 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** 키 id로 받을 수 있는 문자 */
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** 감사 기록에 남기는 대상 파편 id 길이 */
const AUDIT_TARGET_LENGTH = 8;

/** 요청 값이 규칙에 맞지 않을 때의 오류. field는 문제가 된 필드 이름이다. */
export class ReviewInputError extends Error {
  /**
   * @param {string} field
   * @param {string} message
   */
  constructor(field, message) {
    super(message);
    this.name  = "ReviewInputError";
    this.field = field;
  }
}

/**
 * 결정 요청 본문과 헤더를 검증한다. 본문의 idempotencyKey가 헤더 Idempotency-Key보다 앞선다.
 *
 * @param {unknown} body
 * @param {Record<string, string|string[]|undefined>} [headers]
 * @returns {{note: string|null, idempotencyKey: string|null}}
 * @throws {ReviewInputError}
 */
export function parseDecisionBody(body, headers = {}) {
  const input = body ?? {};
  if (typeof input !== "object" || Array.isArray(input)) throw new ReviewInputError("body", "body must be a JSON object");
  for (const field of Object.keys(input)) {
    if (!["note", "idempotencyKey"].includes(field)) throw new ReviewInputError(field, `unknown field: ${field}`);
  }
  const note = input.note ?? null;
  if (note !== null && (typeof note !== "string" || Array.from(note).length > REVIEW_NOTE_MAX)) {
    throw new ReviewInputError("note", `note must be a string of at most ${REVIEW_NOTE_MAX} characters`);
  }
  const header = headers["idempotency-key"];
  const key    = input.idempotencyKey ?? (typeof header === "string" ? header : null);
  if (key !== null && (typeof key !== "string" || key.length > REVIEW_IDEMPOTENCY_KEY_MAX || !IDEMPOTENCY_KEY_PATTERN.test(key))) {
    throw new ReviewInputError("idempotencyKey", `idempotencyKey must be 1 to ${REVIEW_IDEMPOTENCY_KEY_MAX} characters of [A-Za-z0-9._:-]`);
  }
  return { note, idempotencyKey: key };
}

/**
 * 목록 질의 문자열을 검증한다. key_id=master는 마스터 키가 쓴 대기 파편이다.
 *
 * @param {URLSearchParams} search
 * @returns {{keyId: string|null, master: boolean, limit: number, cursor: {createdAt: string, id: string}|null}}
 * @throws {ReviewInputError}
 */
export function parseListQuery(search) {
  const keyParam = search.get("key_id");
  if (keyParam !== null && !KEY_ID_PATTERN.test(keyParam)) throw new ReviewInputError("key_id", "key_id is invalid");
  const limitRaw = search.get("limit");
  const limit    = limitRaw === null ? 50 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > REVIEW_LIST_MAX) {
    throw new ReviewInputError("limit", `limit must be an integer from 1 to ${REVIEW_LIST_MAX}`);
  }
  const cursorRaw = search.get("cursor");
  const cursor    = cursorRaw === null ? null : parseReviewCursor(cursorRaw);
  if (cursorRaw !== null && cursor === null) throw new ReviewInputError("cursor", "cursor is invalid");
  return { keyId: keyParam === "master" ? null : keyParam, master: keyParam === "master", limit, cursor };
}

/**
 * 결정자 표기. 서버가 확인한 관리 행위자에서 만든다.
 *
 * @param {{keyId: string, sessionId: string|null}} actor
 * @returns {string}
 */
export function reviewerLabel(actor) {
  return `${actor.keyId}:${actor.sessionId ?? "unknown"}`;
}

/**
 * 오류를 응답으로 쓴다.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {Error} err
 * @param {string} context
 */
function sendReviewError(res, err, context) {
  const known = [
    [ReviewInputError, 400, () => ({ error: err.message, field: err.field })],
    [ReviewNotFoundError, 404, () => ({ error: "Fragment not found" })],
    [ReviewStateError, 409, () => ({ error: err.message, state: err.state })],
    [ReviewIdempotencyConflictError, 409, () => ({ error: err.message, field: "idempotencyKey" })]
  ].find(([type]) => err instanceof type);
  if (known) {
    res.statusCode = known[1];
    res.end(JSON.stringify(known[2]()));
    return;
  }
  if (err.statusCode === 413) {
    res.statusCode = 413;
    res.end(JSON.stringify({ error: "Payload too large" }));
    return;
  }
  if (err instanceof SyntaxError) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "body must be valid JSON" }));
    return;
  }
  logError(`[Admin] ${context} error:`, err);
  res.statusCode = 500;
  res.end(JSON.stringify({ error: safeErrorMessage(err) }));
}

/** GET /review */
async function listReview(req, res) {
  try {
    const url    = new URL(req.url || "/", "http://localhost");
    const result = await listReviewQueue(parseListQuery(url.searchParams));
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true, count: result.items.length, ...result }));
  } catch (err) {
    sendReviewError(res, err, "review list");
  }
}

/**
 * POST /review/:id/approve, /reject 처리기를 만든다.
 *
 * @param {"approve"|"reject"} decision
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, m: string[]) => Promise<void>}
 */
function decideHandler(decision) {
  return async (req, res, m) => {
    const actor = adminAuditActor(req);
    try {
      const input  = parseDecisionBody(await readJsonBody(req), req.headers);
      const result = await decideReview({ fragmentId: m[1], decision, reviewer: reviewerLabel(actor), ...input });
      logAudit("admin review_decision", {
        success   : true,
        fragmentId: m[1],
        details   : `target=${String(m[1]).slice(0, AUDIT_TARGET_LENGTH)} decision=${decision} replayed=${result.replayed} anchor=${result.anchorApplied === true}`,
        actor
      }).catch((auditErr) => logError("[Admin] review decision audit write failed:", auditErr));
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, ...result }));
    } catch (err) {
      sendReviewError(res, err, `review ${decision}`);
    }
  };
}

/** 경로 일치 판정기. admin-keys.js의 라우트 표와 같은 모양이다. */
const exact = (path) => (pathname) => (pathname === path ? [] : null);
const regex = (re)   => (pathname) => pathname.match(re);

/**
 * 라우트 표. 능력 기반 권한이 들어오면 세 라우트 모두 review.decide 능력을 요구한다.
 */
export const REVIEW_ROUTES = Object.freeze([
  { method: "GET",  match: exact(`${ADMIN_BASE}/review`),                                  handler: listReview },
  { method: "POST", match: regex(new RegExp(`^${ADMIN_BASE}/review/([^/]+)/approve$`)),   handler: decideHandler("approve") },
  { method: "POST", match: regex(new RegExp(`^${ADMIN_BASE}/review/([^/]+)/reject$`)),    handler: decideHandler("reject") }
]);

/**
 * /review 라우트를 표에서 찾아 위임한다.
 *
 * @returns {Promise<boolean>} 처리 여부. false면 호출자가 다음 라우트를 탐색한다.
 */
export async function handleReview(req, res, url) {
  for (const route of REVIEW_ROUTES) {
    if (req.method !== route.method) continue;
    const m = route.match(url.pathname);
    if (!m) continue;
    await route.handler(req, res, m);
    return true;
  }
  return false;
}
