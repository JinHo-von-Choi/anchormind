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
 * @param {Object} options - fetch options (method, body, headers, signal 등)
 * @returns {{ ok: boolean, status: number, data: any, error?: string, aborted?: boolean }}
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
    /** 화면 전환으로 취소된 요청은 aborted로 알린다. 호출자는 오류로 표시하지 않는다. */
    if (err?.name === "AbortError") return { ok: false, status: 0, aborted: true, error: err.message };
    return { ok: false, status: 0, error: err.message };
  }
}

/**
 * 요청 인증 헤더만 붙여 fetch한다. 파일 내려받기처럼 응답 본문을 직접 다룰 때 쓴다.
 *
 * @param {string} path
 * @param {Object} [options]
 * @returns {Promise<Response>}
 */
export function rawFetch(path, options = {}) {
  const cookies = typeof document !== "undefined" ? document.cookie : "";
  const headers = authHeaders(options.method, cookies);
  return fetch(`${API_BASE}${path}`, { ...options, headers: { ...headers, ...options.headers } });
}

/**
 * 응답 본문을 파일로 내려받는다.
 *
 * @param {string} path     - API_BASE에 이어지는 경로
 * @param {string} filename - 저장할 파일 이름
 * @returns {Promise<{ ok: boolean, status: number, error?: string }>}
 */
export async function downloadToFile(path, filename) {
  try {
    const resp = await rawFetch(path);
    if (!resp.ok) return { ok: false, status: resp.status };
    const url = URL.createObjectURL(await resp.blob());
    const a   = document.createElement("a");
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { ok: true, status: resp.status };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}
