/**
 * Memento MCP Admin Console — API 클라이언트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 *
 * state.masterKey가 있으면 Authorization 헤더에 주입하여 내부 API를 호출한다. 마스터 키가 없으면(관리자 계정 세션)
 * 쿠키로 인증하고, GET, HEAD, OPTIONS 밖의 요청에는 CSRF 쿠키 값을 X-CSRF-Token 헤더로 다시 보낸다.
 */

import { state } from "./state.js";

export const API_BASE    = "/v1/internal/model/nothing";
export const CSRF_COOKIE = "mmcp_csrf";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * 쿠키 값 하나를 읽는다.
 *
 * @param {string} cookieText - document.cookie
 * @param {string} name
 * @returns {string}
 */
export function readCookie(cookieText, name) {
  for (const pair of String(cookieText || "").split(";")) {
    const idx = pair.indexOf("=");
    if (idx > 0 && pair.slice(0, idx).trim() === name) return pair.slice(idx + 1).trim();
  }
  return "";
}

/**
 * 요청 인증 헤더. 마스터 키가 있으면 Bearer, 없으면 비GET에 CSRF 헤더.
 *
 * @param {string} method
 * @param {string} cookieText
 * @returns {Object}
 */
export function authHeaders(method, cookieText) {
  if (state.masterKey) return { "Authorization": `Bearer ${state.masterKey}` };
  if (SAFE_METHODS.has(String(method || "GET").toUpperCase())) return {};
  const csrf = readCookie(cookieText, CSRF_COOKIE);
  return csrf ? { "X-CSRF-Token": csrf } : {};
}

/**
 * 내부 Admin API를 호출한다.
 *
 * @param {string} path    - API_BASE에 이어지는 경로 (예: "/auth")
 * @param {Object} options - fetch options (method, body, headers 등)
 * @returns {{ ok: boolean, status: number, data: any, error?: string }}
 */
export async function api(path, options = {}) {
  const url     = `${API_BASE}${path}`;
  const cookies = typeof document !== "undefined" ? document.cookie : "";
  const headers = authHeaders(options.method, cookies);

  if (options.body && typeof options.body === "object") {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }

  try {
    const resp = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
    let data   = null;
    const ct   = resp.headers.get("content-type") || "";
    if (ct.includes("json") && resp.status !== 204) {
      data = await resp.json();
    }
    return { ok: resp.ok, status: resp.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}
