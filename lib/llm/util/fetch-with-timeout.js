/**
 * AbortController 기반 fetch 타임아웃 래퍼
 *
 * 작성자: 최진호
 * 작성일: 2026-04-16
 * 수정일: 2026-09-30
 */

import { LlmTimeoutError } from "../errors.js";

/**
 * URL에서 쿼리 문자열을 제거해 로그와 예외 메시지에 자격 증명이 남지 않게 한다.
 *
 * @param {string} url
 * @returns {string}
 */
function stripQuery(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url).split("?")[0];
  }
}

/**
 * 지정된 시간 내에 fetch를 완료하지 못하면 AbortController로 요청을 취소한다.
 * 타이머는 응답 본문 읽기(text, json, arrayBuffer)가 끝날 때까지 유지된다.
 *
 * @param {string}  url
 * @param {object}  [options={}]     - fetch 옵션 (signal 제외)
 * @param {number}  [timeoutMs=30000]
 * @returns {Promise<Response>}
 * @throws {LlmTimeoutError} 타임아웃 경과 시
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);
  const safeUrl    = stripQuery(url);
  const toTimeout  = (err) => (err?.name === "AbortError"
    ? new LlmTimeoutError(`Request to ${safeUrl} timed out after ${timeoutMs}ms`, { url: safeUrl, timeoutMs })
    : err);

  let res;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw toTimeout(err);
  }

  for (const method of ["text", "json", "arrayBuffer"]) {
    if (typeof res[method] !== "function") continue;
    const original = res[method].bind(res);
    res[method] = (...args) => original(...args)
      .catch((err) => { throw toTimeout(err); })
      .finally(() => clearTimeout(timer));
  }
  return res;
}
