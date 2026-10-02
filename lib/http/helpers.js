/**
 * HTTP 스트림 / 요청 헬퍼
 *
 * 작성자: 최진호
 * 작성일: 2026-03-09
 */

import { ALLOWED_ORIGINS, TRUST_PROXY_HOPS } from "../config.js";
import { recordCorsDenied } from "../metrics.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** 인증 저장소 일시 장애 응답의 Retry-After(초) */
export const AUTH_STORE_RETRY_AFTER_SEC = 10;

/**
 * SSE 메시지 작성
 */
export function sseWrite(res, event, data) {
  if (res.destroyed || !res.writable) return false;
  try {
    res.write(`event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Progress streaming SSE 이벤트 작성 (M4)
 *
 * @param {import('http').ServerResponse} res
 * @param {"progress"|"result"|"error"} type
 * @param {object} data
 * @returns {boolean}
 */
export function writeSSEEvent(res, type, data) {
  if (res.destroyed || !res.writable) return false;
  try {
    const payload = JSON.stringify({ type, ...data });
    res.write(`data: ${payload}\n\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * SSE 응답 헤더를 설정하고 flushHeaders 한다.
 *
 * @param {import('http').ServerResponse} res
 */
export function initSSEResponse(res) {
  res.setHeader("Content-Type",  "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

/**
 * Raw Body 읽기 (2MB 상한) — JSON 파싱 없이 문자열 반환
 */
export function readRawBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size               = 0;
    let rejected           = false;
    const chunks           = [];

    req.on("data", (chunk) => {
      if (rejected) return;
      size                += chunk.length;
      if (size > maxBytes) {
        rejected           = true;
        req.removeAllListeners("data");
        req.resume();
        const err          = new Error("Payload too large");
        err.statusCode     = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

/**
 * JSON Body 읽기 (2MB 상한)
 */
export function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size               = 0;
    let rejected           = false;
    const chunks           = [];

    req.on("data", (chunk) => {
      if (rejected) return;
      size                += chunk.length;
      if (size > maxBytes) {
        rejected           = true;
        req.removeAllListeners("data");
        req.resume();
        const err          = new Error("Payload too large");
        err.statusCode     = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        const body         = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(body || "null"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

/**
 * 신뢰 프록시 hop 수를 적용하여 클라이언트 IP를 추출.
 *
 * 동작 모드:
 *   - hops === undefined (기본): X-Forwarded-For 첫 항목 사용. 기존 동작 보존.
 *   - hops === 0: XFF 무시, socket.remoteAddress 사용.
 *   - hops >= 1: XFF 체인의 우측에서 hops번째 항목 채택.
 *
 * @param {import('http').IncomingMessage} req
 * @param {number|undefined} hops
 * @returns {string}
 */
export function getClientIp(req, hops) {
  const fallback = req.socket?.remoteAddress || "unknown";
  const xff      = req.headers["x-forwarded-for"];

  if (hops === undefined) {
    if (!xff) return fallback;
    const first = String(xff).split(",")[0]?.trim();
    return first || fallback;
  }

  if (hops < 1) return fallback;
  if (!xff) return fallback;

  const chain = String(xff)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  if (chain.length === 0) return fallback;

  const idx = Math.max(0, chain.length - hops);
  return chain[idx];
}

/**
 * 설정된 신뢰 프록시 hop 수로 클라이언트 IP를 판정한다.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
export function resolveClientIp(req) {
  return getClientIp(req, TRUST_PROXY_HOPS);
}

/**
 * 모든 응답에 붙이는 공통 헤더.
 * HSTS는 TLS를 종단하는 리버스 프록시가 붙이므로 여기서 다루지 않는다.
 * 프레임 제한은 MEMENTO_FRAME_OPTIONS=deny일 때만 붙인다.
 *
 * @param {import('http').ServerResponse} res
 */
export function applyBaseResponseHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy",        "no-referrer");
  if (process.env.MEMENTO_FRAME_OPTIONS === "deny") {
    res.setHeader("X-Frame-Options", "DENY");
  }
}

/**
 * Origin 검증
 * Origin 헤더가 없으면 비브라우저 클라이언트(curl, 네이티브 HTTP)로 간주하여 허용.
 * ALLOWED_ORIGINS 미설정 시 모든 Origin 허용 (MCP 클라이언트 호환성).
 */
export function validateOrigin(req, res) {
  const origin              = req.headers.origin;

  if (!origin) {
    return true;
  }

  /** ALLOWED_ORIGINS 미설정 시 모든 Origin 허용 (MCP 클라이언트 호환성) */
  if (ALLOWED_ORIGINS.size === 0) {
    return true;
  }

  if (!ALLOWED_ORIGINS.has(String(origin))) {
    recordCorsDenied("origin_not_allowed");
    res.statusCode         = 403;
    res.end("Forbidden (Origin not allowed)");
    return false;
  }

  return true;
}

/**
 * 인증 결과가 저장소 조회 실패이고 설정이 503이면 503을, 아니면 null을 돌려준다.
 *
 * @param {{ valid: boolean, unavailable?: boolean }} authResult
 * @param {401|503} configuredStatus - AUTH_STORE_UNAVAILABLE_STATUS
 * @returns {503|null}
 */
export function authStoreUnavailableStatus(authResult, configuredStatus) {
  if (authResult?.valid === true || authResult?.unavailable !== true) return null;
  return configuredStatus === 503 ? 503 : null;
}
