/**
 * 유효 세션 요청에 함께 온 자격 증명 확인
 *
 * 유효한 세션의 요청은 세션에 저장된 주체로 처리된다. 요청이 자격 증명을 함께 보냈으면 그 자격 증명이
 * 지금도 유효한지, 세션의 주체와 같은지를 본다. 자격 증명을 보내지 않은 요청은 판정하지 않는다.
 *
 * MEMENTO_SESSION_CREDENTIAL_CHECK
 *   off      판정하지 않는다.
 *   warn     결과를 지표와 경고 로그로 남기고 요청을 그대로 처리한다(기본).
 *   enforce  무효이거나 만료된 자격 증명은 401, 유효하지만 세션과 다른 주체는 403으로 거부한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import crypto from "node:crypto";

import { ACCESS_KEY, PORT, sessionCredentialCheckMode } from "./config.js";
import { peekCredential }           from "./auth.js";
import { recordSessionCredential }  from "./metrics.js";
import { logWarn }                  from "./logger.js";
import { sessionRef }               from "./logging/session-ref.js";

const CACHE_TTL_MS = 30_000;
const CACHE_MAX    = 2_000;

/** 자격 증명 해시 -> { at, verdict }. 같은 자격 증명을 요청마다 저장소에서 다시 조회하지 않는다. */
const cache = new Map();

function cacheKeyOf(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * 자격 증명 판정을 캐시에서 찾거나 새로 구한다. 저장소 조회 실패는 캐시하지 않는다.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {number} now
 * @returns {Promise<{ present: boolean, fresh?: boolean, valid?: boolean, unavailable?: boolean, keyId?: string|null, isMaster?: boolean }>}
 */
async function credentialOf(req, now) {
  const legacy = req.headers["memento-access-key"];
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "")?.[1];
  const token  = (typeof legacy === "string" && legacy) || bearer;
  if (!token) return { present: false };

  const key = cacheKeyOf(token);
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.verdict;

  const verdict = await peekCredential(token);
  if (verdict.unavailable) return verdict;
  cache.delete(key);
  cache.set(key, { at: now, verdict });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return { ...verdict, fresh: true };
}

/**
 * 유효 세션 요청의 자격 증명을 세션 주체와 대조한다.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {{ sessionId: string, keyId: string|null, isMaster: boolean|undefined }} session
 * @param {number} [now]
 * @returns {Promise<{ result: "skipped"|"absent"|"match"|"invalid"|"mismatch", reject: 401|403|null }>}
 */
export async function checkSessionCredential(req, session, now = Date.now()) {
  const mode = sessionCredentialCheckMode();
  if (mode === "off" || !ACCESS_KEY || typeof session.isMaster !== "boolean") return { result: "skipped", reject: null };

  const credential = await credentialOf(req, now);
  if (!credential.present) {
    recordSessionCredential("absent");
    return { result: "absent", reject: null };
  }
  if (credential.unavailable) return { result: "skipped", reject: null };

  const result = credential.valid !== true ? "invalid"
    : (credential.keyId ?? null) === (session.keyId ?? null) && credential.isMaster === session.isMaster ? "match"
    : "mismatch";
  recordSessionCredential(result);
  if (result === "match") return { result, reject: null };

  if (credential.fresh) {
    logWarn(`[SessionCredential] ${result} credential on a valid session: session=${sessionRef(session.sessionId)} mode=${mode}`);
  }
  if (mode !== "enforce") return { result, reject: null };
  return { result, reject: result === "invalid" ? 401 : 403 };
}

/**
 * checkSessionCredential이 거부로 판정한 요청에 응답한다.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{ reject: 401|403|null }} verdict
 * @param {string|number|null} [msgId]
 * @returns {boolean} 응답을 보냈으면 true
 */
export function rejectSessionCredential(req, res, verdict, msgId = null) {
  if (verdict.reject === null) return false;
  res.statusCode = verdict.reject;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (verdict.reject === 401) {
    const proto = req.headers["x-forwarded-proto"] || (req.socket?.encrypted ? "https" : "http");
    res.setHeader("WWW-Authenticate",
      `Bearer resource_metadata="${proto}://${req.headers.host || `localhost:${PORT}`}/.well-known/oauth-protected-resource"`);
  }
  const message = verdict.reject === 401
    ? "Invalid or expired credential"
    : "Credential does not match the session";
  res.end(JSON.stringify({ jsonrpc: "2.0", id: msgId, error: { code: -32000, message } }));
  return true;
}

/**
 * 유효 세션 요청의 자격 증명을 확인하고, 거부할 요청이면 응답까지 보낸다.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{ sessionId: string, keyId: string|null, isMaster: boolean|undefined }} session
 * @param {string|number|null} [msgId]
 * @returns {Promise<boolean>} 응답을 보냈으면 true
 */
export async function refuseSessionCredential(req, res, session, msgId = null) {
  return rejectSessionCredential(req, res, await checkSessionCredential(req, session), msgId);
}

/** 시험 전용 초기화 */
export function _resetSessionCredentialCacheForTest() {
  cache.clear();
}
