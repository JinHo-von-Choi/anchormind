/**
 * Admin 인증/세션 관리
 *
 * 작성자: 최진호
 * 작성일: 2026-03-27
 */

import crypto from "node:crypto";

import { ACCESS_KEY, ADMIN_ALLOWED_ORIGINS } from "../config.js";
import { resolveClientIp } from "../http/helpers.js";
import { validateMasterKey, safeCompare }     from "../auth.js";
import { logWarn }                            from "../logger.js";
import { logAudit }                           from "../logging/audit.js";
import {
  checkAdminAuthAttempt,
  recordAdminAuthFailure,
  recordAdminAuthSuccess
} from "./admin-login-guard.js";

export const ADMIN_BASE = "/v1/internal/model/nothing";

/** 클라이언트에 안전한 에러 메시지만 반환 (DB 내부 정보 노출 방지) */
const SAFE_ERRORS = new Set(["Key not found", "Group not found", "name is required", "key_id is required"]);
export function safeErrorMessage(err) {
  if (SAFE_ERRORS.has(err.message)) return err.message;
  if (err.message.includes("unique")) return "Duplicate entry";
  if (err.message.includes("violates")) return "Constraint violation";
  return "Internal error";
}

/**
 * Admin 로그인 페이지 HTML
 */
const ADMIN_LOGIN_PAGE = `<!DOCTYPE html>
<html><head><title>ANCHORMIND | Admin Login</title>
<style>body{background:#111111;color:#cccccc;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
form{background:#1a1a1a;padding:2rem;border:1px solid #2a2a2a}
input{background:#1f1f1f;color:#cccccc;border:1px solid #2a2a2a;font-family:inherit;padding:8px 12px;width:300px;margin:8px 0}
button{background:#aa8855;color:#111111;border:none;font-family:inherit;font-weight:700;letter-spacing:1px;padding:8px 24px;cursor:pointer}
.err{color:#cc7755;font-size:0.85rem;margin-top:4px;display:none}</style>
</head><body><form method="POST" action="${ADMIN_BASE}/auth">
<div style="color:#aa8855;font-weight:700;letter-spacing:3px;margin-bottom:4px">ANCHORMIND</div><div>Admin Access Key</div><input name="key" type="password" placeholder="Master Key" autofocus /><br/>
<div class="err" id="err">Invalid key</div>
<button type="submit">Login</button></form>
<script>if(location.search.includes('error=1'))document.getElementById('err').style.display='block'</script></body></html>`;

/** Admin 세션: 토큰 -> 만료시각 */
const adminSessions     = new Map();
const ADMIN_SESSION_TTL = 24 * 60 * 60 * 1000;

function createAdminSession() {
  const token = crypto.randomUUID();
  adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL);
  return token;
}

function isValidAdminSession(token) {
  const expiresAt = adminSessions.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function parseCookies(cookieHeader) {
  const result = {};
  for (const pair of cookieHeader.split(";")) {
    const [key, ...vals] = pair.trim().split("=");
    if (key) result[key.trim()] = vals.join("=").trim();
  }
  return result;
}

/**
 * 관리 감사 기록의 행위자. 관리 계정은 마스터 하나이며 세션은 쿠키 토큰 해시(접두 c와 앞 7자)로 표기한다.
 *
 * @param {import("http").IncomingMessage} req
 * @returns {{ keyId: string, sessionId: string, clientIp: string }}
 */
export function adminAuditActor(req) {
  const token = parseCookies(req.headers.cookie || "")["mmcp_session"];
  return {
    keyId    : "master",
    sessionId: token ? `c${crypto.createHash("sha256").update(token).digest("hex").slice(0, 7)}` : "bearer",
    clientIp : resolveClientIp(req)
  };
}

/**
 * 관리 인증 감사 기록. 기록 실패는 경고로 남기고 인증 흐름은 막지 않는다.
 */
function auditAdminAuth(success, channel, actor) {
  logAudit("admin_auth", { success, details: `channel=${channel}`, actor })
    .catch((err) => logWarn(`[AdminAuth] audit write failed: ${err.message}`));
}

/**
 * 관리 인증 실패를 기록한다. 시도한 값은 남기지 않는다.
 */
function noteAdminAuthFailure(req, channel) {
  const count = recordAdminAuthFailure();
  const ip    = resolveClientIp(req);
  logWarn(`[AdminAuth] failed ${channel} attempt: consecutive=${count} ip=${ip}`);
  auditAdminAuth(false, channel, { keyId: "unknown", clientIp: ip });
}

/** 지연 중인 인증 시도에 429와 Retry-After로 응답한다. */
function sendAdminBackoff(res, retryAfterSec) {
  res.statusCode = 429;
  res.setHeader("Retry-After", String(retryAfterSec));
  res.end(JSON.stringify({ error: "Too Many Requests" }));
}

/**
 * 인증 거절 응답. Authorization 헤더가 있는 요청이 지연 중이면 429, 그 밖에는 401.
 */
export function sendAdminDenied(req, res) {
  const attempt = req.headers.authorization ? checkAdminAuthAttempt() : { allowed: true, retryAfterSec: 0 };
  if (!attempt.allowed) return sendAdminBackoff(res, attempt.retryAfterSec);
  res.statusCode = 401;
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

/**
 * Admin 액세스 검증
 * Authorization 헤더 또는 세션 쿠키로 인증
 */
export function validateAdminAccess(req) {
  if (!ACCESS_KEY) return false;

  const hasBearer     = Boolean(req.headers.authorization);
  const bearerAllowed = !hasBearer || checkAdminAuthAttempt().allowed;
  if (bearerAllowed && validateMasterKey(req)) {
    recordAdminAuthSuccess();
    return true;
  }

  const cookies      = parseCookies(req.headers.cookie || "");
  const sessionToken = cookies["mmcp_session"];
  if (sessionToken && isValidAdminSession(sessionToken)) return true;

  if (hasBearer && bearerAllowed) noteAdminAuthFailure(req, "bearer");
  const ip = resolveClientIp(req);
  console.warn(`[admin-auth] denied ${req.method} ${req.url} from ${ip}`);
  return false;
}

/**
 * Admin 엔드포인트 Origin 검증
 * ADMIN_ALLOWED_ORIGINS 미설정 시 모든 Origin 허용.
 */
export function validateAdminOrigin(req, res) {
  const origin = req.headers.origin;
  if (!origin || ADMIN_ALLOWED_ORIGINS.size === 0) return true;
  if (!ADMIN_ALLOWED_ORIGINS.has(String(origin))) {
    res.statusCode = 403;
    res.end("Forbidden (Admin origin not allowed)");
    return false;
  }
  return true;
}

/**
 * POST /auth 핸들러
 * Bearer 헤더(API 클라이언트) 또는 form body(브라우저 로그인) 모두 지원
 */
export function handleAuth(req, res) {
  const isFormPost = (req.headers["content-type"] || "").includes("application/x-www-form-urlencoded");
  const attempt    = checkAdminAuthAttempt();
  if (!attempt.allowed) {
    sendAdminBackoff(res, attempt.retryAfterSec);
    req.resume();
    return;
  }

  if (isFormPost) {
    const MAX_FORM_BYTES = 2 * 1024 * 1024;
    const chunks = [];
    let bytes    = 0;
    let aborted  = false;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_FORM_BYTES) {
        aborted = true;
        res.statusCode = 413;
        res.end(JSON.stringify({ error: "Payload too large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      const body   = Buffer.concat(chunks).toString("utf-8");
      const params = new URLSearchParams(body);
      const key    = params.get("key") || "";

      res.removeHeader("Content-Type");
      if (key && safeCompare(key, ACCESS_KEY)) {
        recordAdminAuthSuccess();
        auditAdminAuth(true, "form", { keyId: "master", clientIp: resolveClientIp(req) });
        const token      = createAdminSession();
        const isSecure   = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
        const securePart = isSecure ? " Secure;" : "";
        res.setHeader("Set-Cookie",
          `mmcp_session=${token}; HttpOnly; SameSite=Lax;${securePart} Path=${ADMIN_BASE}; Max-Age=86400`);
        res.statusCode = 302;
        res.setHeader("Location", ADMIN_BASE);
        res.end();
      } else {
        noteAdminAuthFailure(req, "form");
        res.statusCode = 302;
        res.setHeader("Location", `${ADMIN_BASE}?error=1`);
        res.end();
      }
    });
    return;
  }

  /** Bearer 헤더 방식 (API 클라이언트용) */
  if (validateMasterKey(req)) {
    recordAdminAuthSuccess();
    auditAdminAuth(true, "bearer", { keyId: "master", clientIp: resolveClientIp(req) });
    const token      = createAdminSession();
    const isSecure   = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
    const securePart = isSecure ? " Secure;" : "";
    res.setHeader("Set-Cookie",
      `mmcp_session=${token}; HttpOnly; SameSite=Lax;${securePart} Path=${ADMIN_BASE}; Max-Age=86400`);
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
  } else {
    noteAdminAuthFailure(req, "bearer");
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "Invalid admin key" }));
  }
}

export { ADMIN_LOGIN_PAGE };
