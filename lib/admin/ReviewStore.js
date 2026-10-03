/**
 * ReviewStore - 검토 대기열 조회, 결정, 30일 미결정 자동 거절
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 검토 대기 파편(fragments.review_state='pending')을 관리 화면에 보이고, 승인과 거절을 한 트랜잭션에서
 * 파편 상태 변경과 결정 기록(memory_review_decisions)으로 남긴다.
 *
 *   승인       review_state='approved'. review_reason에 anchor_requested 표지가 있으면 앵커로 지정한다
 *   거절       review_state='rejected', valid_to=NOW(). 만료 파편이 되어 recall과 주입에서 빠진다
 *   자동 거절  만든 지 30일이 지나도 결정되지 않은 파편을 거절하고 결정자 system으로 남긴다
 *
 * 결정은 대상 파편 행을 FOR UPDATE로 잠근 뒤 상태를 다시 확인하므로 두 결정이 겹치면 하나만 적용되고
 * 나머지는 상태 충돌이 된다. 멱등 키가 같은 재요청은 앞선 결정을 돌려준다. 결정 기록에는 파편 본문이 없고
 * 메모는 민감 정보 마스킹을 거친다. 자동 거절은 잠금 문장(FOR UPDATE SKIP LOCKED, id 순)과 갱신 문장을
 * 나눈다(lib/memory/write/rowLock.js의 근거와 같다).
 */

import { getPrimaryPool, withTransaction }      from "../tools/db.js";
import { SCHEMA }                               from "../memory/schema.js";
import { keyScopeCondition }                    from "../memory/keyScope.js";
import { REVIEW_STATES }                        from "../memory/reviewState.js";
import { ANCHOR_REQUEST_MARK, REVIEW_REASONS, parseReviewReason } from "../memory/write/ReviewQueue.js";
import { maskText }                             from "../security/SensitiveScanner.js";
import { recordReviewDecision }                 from "../memory/write/write-gate-metrics.js";
import { logAudit }                             from "../logging/audit.js";
import { logError, logInfo }                    from "../logger.js";
import { runInBackground }                      from "../tools/pool-gate.js";

/** 기본 앵커 판정에서 앵커 지정을 허용하는 키 권한 값 */
export const ANCHOR_PERMISSION_VALUES = Object.freeze(["anchor", "admin"]);

/** 관리자가 내리는 결정 */
export const REVIEW_DECISIONS = Object.freeze(["approve", "reject"]);

/** 결정되지 않은 검토 대기 파편을 자동 거절하는 기준 일수 */
export const REVIEW_EXPIRY_DAYS = 30;

/** 자동 거절 한 번의 최대 건수 */
export const REVIEW_EXPIRY_BATCH = 500;

/** 자동 거절 주기(ms) */
export const REVIEW_EXPIRY_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 메모 최대 길이(문자) */
export const REVIEW_NOTE_MAX = 500;

/** 멱등 키 최대 길이 */
export const REVIEW_IDEMPOTENCY_KEY_MAX = 128;

/** 목록 한 번의 최대 건수 */
export const REVIEW_LIST_MAX = 200;

/** 목록 미리보기 본문 길이 */
const PREVIEW_CHARS = 500;

/** 고유 위반(23505) */
const UNIQUE_VIOLATION = "23505";

/** 대상 파편이 없을 때 */
export class ReviewNotFoundError extends Error {
  constructor(fragmentId) {
    super("fragment not found");
    this.name       = "ReviewNotFoundError";
    this.fragmentId = fragmentId;
  }
}

/** 대상 파편이 검토 대기가 아닐 때(이미 결정됨, 만료됨, 검토 대상 아님) */
export class ReviewStateError extends Error {
  /**
   * @param {string|null} state - 현재 review_state
   */
  constructor(state) {
    super("fragment is not pending review");
    this.name  = "ReviewStateError";
    this.state = state;
  }
}

/** 같은 멱등 키가 다른 결정에 이미 쓰였을 때 */
export class ReviewIdempotencyConflictError extends Error {
  constructor() {
    super("idempotency key already used for a different decision");
    this.name = "ReviewIdempotencyConflictError";
  }
}

/**
 * 결정 메모를 저장할 값으로 다듬는다. 제어 문자를 지우고 민감 정보를 가린 뒤 길이를 자른다.
 *
 * @param {unknown} note
 * @returns {string|null}
 */
export function sanitizeReviewNote(note) {
  if (typeof note !== "string") return null;
  const cleaned = Array.from(note).filter((ch) => ch === "\n" || (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)).join("").trim();
  if (cleaned === "") return null;
  return Array.from(maskText(cleaned)).slice(0, REVIEW_NOTE_MAX).join("");
}

/**
 * 결정 행을 응답 모양으로 바꾼다.
 *
 * @param {Object} row
 * @param {boolean} replayed
 * @returns {Object}
 */
function decisionResult(row, replayed) {
  return {
    decisionId : String(row.id),
    fragmentId : row.fragment_id,
    decision   : row.decision,
    reviewer   : row.reviewer,
    keyId      : row.key_id ?? null,
    decidedAt  : row.decided_at,
    replayed
  };
}

/**
 * 멱등 키로 앞선 결정을 찾는다. 같은 파편과 같은 결정이면 그 결정을, 다르면 충돌을 던진다.
 *
 * @param {import("pg").PoolClient} client
 * @param {string|null} idempotencyKey
 * @param {string} fragmentId
 * @param {string} decision
 * @returns {Promise<Object|null>}
 */
async function findReplay(client, idempotencyKey, fragmentId, decision) {
  if (idempotencyKey === null) return null;
  const { rows } = await client.query(
    `SELECT id, fragment_id, decision, reviewer, key_id, decided_at
       FROM ${SCHEMA}.memory_review_decisions
      WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
  if (rows.length === 0) return null;
  if (rows[0].fragment_id !== fragmentId || rows[0].decision !== decision) throw new ReviewIdempotencyConflictError();
  return decisionResult(rows[0], true);
}

/**
 * 기본 앵커 판정. 결정 트랜잭션 안에서 호출되며 그 키 행은 이미 잠겨 있다. 마스터 키가 쓴 파편은 허용하고,
 * 키는 지금 권한 목록에 anchor 또는 admin이 있을 때만 허용한다. 그 밖은 앵커 없이 승인한다.
 *
 * @param {string|null} keyId
 * @param {Object} _fragment - 잠근 파편 행(id, key_id, review_reason)
 * @param {import("pg").PoolClient} client
 * @returns {Promise<{allowed: boolean, reason: string}>}
 */
export async function defaultAnchorDecisionCheck(keyId, _fragment, client) {
  if (keyId === null) return { allowed: true, reason: "master" };
  const { rows } = await client.query(`SELECT permissions FROM ${SCHEMA}.api_keys WHERE id = $1`, [keyId]);
  const permissions = rows[0]?.permissions ?? [];
  return ANCHOR_PERMISSION_VALUES.some((p) => permissions.includes(p))
    ? { allowed: true, reason: "permitted" }
    : { allowed: false, reason: "permission" };
}

/**
 * 승인 때 보류한 앵커 요청을 적용할지 정한다. 무권한 앵커 사유(anchor_unauthorized)는 관리자가 applyAnchor:true를
 * 명시해야만 적용하고, 그 밖의 사유는 판정 함수가 허용할 때만 적용한다. applyAnchor:false는 언제나 적용하지 않는다.
 *
 * @param {Object} current - 잠근 파편 행
 * @param {boolean|undefined} applyAnchor
 * @param {import("pg").PoolClient} client
 * @param {Function} check - anchorDecisionCheck
 * @returns {Promise<{applied: boolean, reason: string}>}
 */
async function resolveHeldAnchor(current, applyAnchor, client, check) {
  const marks = parseReviewReason(current.review_reason);
  if (!marks.includes(ANCHOR_REQUEST_MARK)) return { applied: false, reason: "not_requested" };
  if (applyAnchor === false) return { applied: false, reason: "declined" };
  if (marks.includes(REVIEW_REASONS.ANCHOR_UNAUTHORIZED)) {
    return applyAnchor === true ? { applied: true, reason: "explicit" } : { applied: false, reason: "explicit_required" };
  }
  const verdict = await check(current.key_id ?? null, current, client);
  return { applied: verdict?.allowed === true, reason: String(verdict?.reason ?? (verdict?.allowed ? "permitted" : "denied")) };
}

/**
 * 결정 하나를 한 트랜잭션에서 적용한다. 잠금 순서는 키 행(앵커 요청을 승인할 때), 파편 행이다. 멱등 키 재요청은
 * 파편 행을 잠근 뒤 확인하므로 같은 키의 동시 요청은 먼저 끝난 결정을 돌려받는다.
 *
 * @param {import("pg").PoolClient} client
 * @param {{fragmentId: string, decision: string, reviewer: string, note: string|null, idempotencyKey: string|null,
 *   applyAnchor?: boolean}} input
 * @param {Function} check - anchorDecisionCheck
 * @returns {Promise<Object>}
 */
async function applyDecision(client, { fragmentId, decision, reviewer, note, idempotencyKey, applyAnchor }, check) {
  const peek = await client.query(`SELECT key_id, review_reason FROM ${SCHEMA}.fragments WHERE id = $1`, [fragmentId]);
  const peekKey = peek.rows[0]?.key_id ?? null;
  if (decision === "approve" && peekKey !== null && parseReviewReason(peek.rows[0]?.review_reason).includes(ANCHOR_REQUEST_MARK)) {
    await client.query(`SELECT id FROM ${SCHEMA}.api_keys WHERE id = $1 FOR UPDATE`, [peekKey]);
  }

  const { rows } = await client.query(
    `SELECT id, key_id, review_state, review_reason, valid_to
       FROM ${SCHEMA}.fragments
      WHERE id = $1
      FOR UPDATE`,
    [fragmentId]
  );
  const replay = await findReplay(client, idempotencyKey, fragmentId, decision);
  if (replay) return replay;
  if (rows.length === 0) throw new ReviewNotFoundError(fragmentId);
  const current = rows[0];
  if (current.review_state !== REVIEW_STATES.PENDING || current.valid_to !== null) {
    throw new ReviewStateError(current.review_state ?? null);
  }

  /** 승인은 보류한 앵커 요청을 판정을 거쳐서만 적용한다. 거절은 만료 파편으로 만든다. */
  const anchor = decision === "approve"
    ? await resolveHeldAnchor(current, applyAnchor, client, check)
    : { applied: false, reason: "not_requested" };
  if (decision === "approve") {
    await client.query(
      `UPDATE ${SCHEMA}.fragments SET review_state = $2, is_anchor = (is_anchor OR $3::boolean) WHERE id = $1`,
      [fragmentId, REVIEW_STATES.APPROVED, anchor.applied]
    );
  } else {
    await client.query(
      `UPDATE ${SCHEMA}.fragments SET review_state = $2, valid_to = NOW() WHERE id = $1`,
      [fragmentId, REVIEW_STATES.REJECTED]
    );
  }

  const inserted = await client.query(
    `INSERT INTO ${SCHEMA}.memory_review_decisions
       (fragment_id, decision, reviewer, note, idempotency_key, key_id, review_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, fragment_id, decision, reviewer, key_id, decided_at`,
    [fragmentId, decision, reviewer, note, idempotencyKey, current.key_id ?? null, current.review_reason ?? null]
  );
  return { ...decisionResult(inserted.rows[0], false), anchorApplied: anchor.applied, anchorReason: anchor.reason };
}

/**
 * 결정을 파일 감사 기록 한 줄로 남긴다. 기록 실패는 결정을 되돌리지 않는다.
 *
 * @param {Object} result
 * @param {Object|null} actor
 */
function auditDecision(result, actor) {
  logAudit("admin review_decision", {
    success   : true,
    fragmentId: result.fragmentId,
    details   : `target=${String(result.fragmentId).slice(0, 8)} decision=${result.decision} replayed=${result.replayed}`
      + ` anchor=${result.anchorApplied === true} anchor_reason=${result.anchorReason ?? "none"}`,
    actor     : actor ?? { keyId: "system" }
  }).catch((err) => logError("[ReviewQueue] decision audit write failed:", err));
}

/**
 * 검토 대기 파편 하나를 승인하거나 거절한다.
 *
 * @param {{fragmentId: string, decision: "approve"|"reject", reviewer: string, note?: string|null,
 *   idempotencyKey?: string|null, applyAnchor?: boolean, actor?: Object}} input - reviewer는 서버가 정한 결정자 표기,
 *   actor는 감사 기록의 행위자
 * @param {{query: Function, connect: Function}} [pool]
 * @param {{anchorDecisionCheck?: (keyId: string|null, fragment: Object, client: Object) =>
 *   Promise<{allowed: boolean, reason: string}>}} [deps] - 보류한 앵커 요청의 결정 시점 판정(결정 트랜잭션 client)
 * @returns {Promise<{decisionId: string, fragmentId: string, decision: string, reviewer: string, keyId: string|null,
 *   decidedAt: Date, replayed: boolean, anchorApplied?: boolean, anchorReason?: string}>}
 * @throws {ReviewNotFoundError|ReviewStateError|ReviewIdempotencyConflictError}
 */
export async function decideReview(
  { fragmentId, decision, reviewer, note = null, idempotencyKey = null, applyAnchor, actor = null },
  pool = getPrimaryPool(),
  { anchorDecisionCheck = defaultAnchorDecisionCheck } = {}
) {
  if (!REVIEW_DECISIONS.includes(decision)) throw new TypeError(`unknown review decision: ${decision}`);
  const input = { fragmentId, decision, reviewer, note: sanitizeReviewNote(note), idempotencyKey: idempotencyKey ?? null, applyAnchor };
  let result;
  try {
    result = await withTransaction(pool, (client) => applyDecision(client, input, anchorDecisionCheck));
  } catch (err) {
    /** 같은 멱등 키의 동시 요청은 고유 색인이 하나만 남긴다. 진 요청은 앞선 결정을 돌려준다. */
    if (err?.code !== UNIQUE_VIOLATION || input.idempotencyKey === null) throw err;
    result = await withTransaction(pool, (client) => findReplay(client, input.idempotencyKey, fragmentId, decision));
    if (!result) throw err;
  }
  if (!result.replayed) recordReviewDecision(decision);
  auditDecision(result, actor);
  return result;
}

/**
 * 목록 이어 보기 표지를 읽는다. "ISO 시각|파편 id" 형식이 아니면 null이다.
 *
 * @param {unknown} cursor
 * @returns {{createdAt: string, id: string}|null}
 */
export function parseReviewCursor(cursor) {
  if (typeof cursor !== "string" || cursor === "") return null;
  const sep = cursor.indexOf("|");
  if (sep <= 0) return null;
  const createdAt = cursor.slice(0, sep);
  const id        = cursor.slice(sep + 1);
  if (Number.isNaN(Date.parse(createdAt)) || id === "" || id.length > 128) return null;
  return { createdAt: new Date(createdAt).toISOString(), id };
}

/**
 * 검토 대기 목록. 오래된 것부터(자동 거절에 가까운 순서) 돌려준다.
 *
 * @param {{keyId?: string|null, master?: boolean, limit?: number, cursor?: {createdAt: string, id: string}|null}} [filter]
 *   keyId는 그 키의 대기 파편만, master=true는 마스터 키가 쓴 대기 파편만 본다
 * @param {{query: Function}} [pool]
 * @returns {Promise<{items: Object[], nextCursor: string|null}>}
 */
export async function listReviewQueue({ keyId = null, master = false, limit = 50, cursor = null } = {}, pool = getPrimaryPool()) {
  const params     = [REVIEW_EXPIRY_DAYS];
  const conditions = [`f.review_state = '${REVIEW_STATES.PENDING}'`, "f.valid_to IS NULL"];
  if (master) {
    conditions.push("f.key_id IS NULL");
  } else if (keyId !== null) {
    conditions.push(keyScopeCondition(params, "f.key_id", keyId));
  }
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    conditions.push(`(f.created_at, f.id) > ($${params.length - 1}::timestamptz, $${params.length})`);
  }
  params.push(Math.min(Math.max(1, limit), REVIEW_LIST_MAX));

  const { rows } = await pool.query(
    `SELECT f.id, f.key_id, k.name AS key_name, f.agent_id, f.workspace, f.type, f.topic,
            LEFT(f.content, ${PREVIEW_CHARS}) AS content_preview, f.review_reason, f.origin, f.trust_tier,
            f.is_anchor, f.created_at, f.created_at + make_interval(days => $1) AS auto_reject_at
       FROM ${SCHEMA}.fragments f
       LEFT JOIN ${SCHEMA}.api_keys k ON k.id = f.key_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY f.created_at ASC, f.id ASC
      LIMIT $${params.length}`,
    params
  );
  const last = rows.length === params.at(-1) ? rows.at(-1) : null;
  return {
    items     : rows.map((row) => ({ ...row, review_reasons: String(row.review_reason ?? "").split(",").filter(Boolean) })),
    nextCursor: last ? `${new Date(last.created_at).toISOString()}|${last.id}` : null
  };
}

/**
 * 만든 지 기준 일수가 지나도 결정되지 않은 검토 대기 파편을 거절한다(자동 거절, 결정자 system).
 * 다른 트랜잭션이 잠근 행은 건너뛰고 다음 주기에 다시 본다.
 *
 * @param {{days?: number, limit?: number}} [options]
 * @param {{connect: Function}} [pool]
 * @returns {Promise<{rejected: number, fragmentIds: string[]}>}
 */
export async function expireStaleReviews({ days = REVIEW_EXPIRY_DAYS, limit = REVIEW_EXPIRY_BATCH } = {}, pool = getPrimaryPool()) {
  const fragmentIds = await withTransaction(pool, async (client) => {
    const locked = await client.query(
      `SELECT id FROM ${SCHEMA}.fragments
        WHERE review_state = '${REVIEW_STATES.PENDING}' AND valid_to IS NULL
          AND created_at < NOW() - make_interval(days => $1)
        ORDER BY id
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [days, limit]
    );
    const ids = locked.rows.map((row) => row.id);
    if (ids.length === 0) return [];
    const updated = await client.query(
      `UPDATE ${SCHEMA}.fragments
          SET review_state = '${REVIEW_STATES.REJECTED}', valid_to = NOW()
        WHERE id = ANY($1::text[])
        RETURNING id, key_id, review_reason`,
      [ids]
    );
    await client.query(
      `INSERT INTO ${SCHEMA}.memory_review_decisions (fragment_id, decision, reviewer, key_id, review_reason)
       SELECT u.id, 'auto_reject', 'system', u.key_id, u.review_reason
         FROM unnest($1::text[], $2::text[], $3::text[]) AS u(id, key_id, review_reason)`,
      [updated.rows.map((r) => r.id), updated.rows.map((r) => r.key_id ?? null), updated.rows.map((r) => r.review_reason ?? null)]
    );
    return updated.rows.map((row) => row.id);
  });
  if (fragmentIds.length > 0) recordReviewDecision("auto_reject", fragmentIds.length);
  return { rejected: fragmentIds.length, fragmentIds };
}

/**
 * 자동 거절 한 주기. 결과를 감사 기록과 로그로 남기며 실패는 로그로 남기고 던지지 않는다.
 * MEMENTO_REVIEW_QUEUE=off여도 이미 검토 대기인 파편은 결정 대상이므로 계속 실행한다.
 *
 * @param {() => Promise<{rejected: number, fragmentIds: string[]}>} [expire]
 * @returns {Promise<number>} 거절한 건수(실패하면 0)
 */
export async function runReviewExpiry(expire = expireStaleReviews) {
  try {
    const { rejected, fragmentIds } = await expire();
    if (rejected > 0) {
      logInfo(`[ReviewQueue] auto rejected ${rejected} pending fragments older than ${REVIEW_EXPIRY_DAYS} days`);
      await logAudit("review auto_reject", {
        success: true,
        details: `count=${rejected} ids=${fragmentIds.slice(0, 20).map((id) => String(id).slice(0, 8)).join(",")}`,
        actor  : { keyId: "system" }
      });
    }
    return rejected;
  } catch (err) {
    logError("[ReviewQueue] auto reject failed:", err);
    return 0;
  }
}

/**
 * 자동 거절을 주기 작업으로 건다. 프로세스 종료를 막지 않는다.
 *
 * @param {number} [intervalMs]
 * @returns {NodeJS.Timeout}
 */
export function scheduleReviewExpiry(intervalMs = REVIEW_EXPIRY_INTERVAL_MS) {
  const timer = setInterval(() => runInBackground("reviewExpiry", () => runReviewExpiry()), intervalMs);
  timer.unref?.();
  return timer;
}
