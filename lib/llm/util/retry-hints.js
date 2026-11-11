/**
 * HTTP 429 / 503 응답에서 서버가 제안한 대기 시간을 추출한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-24
 *
 * 지원 형식:
 *   1) `Retry-After` 헤더 — 초 정수(예: "30") 또는 HTTP-date
 *   2) 응답 본문의 Google RPC RetryInfo 확장 —
 *      `error.details[@type*="RetryInfo"].retryDelay` ("Ns" 문자열)
 *   3) 응답 본문의 OpenAI 호환 `retry_after` 필드(숫자, 초)
 *
 * 여러 힌트가 동시에 존재하면 가장 긴 값을 반환한다. 파싱 실패 또는 힌트 부재 시 0.
 */

/**
 * @param {Response} res       - fetch 응답. headers.get 이 사용 가능해야 한다.
 * @param {string}   bodyText  - 이미 소비된 응답 본문 텍스트. JSON이 아니어도 안전.
 * @returns {number} 제안 대기 시간 (ms). 없으면 0.
 */
export function extractRetryHintMs(res, bodyText) {
  let hint = 0;

  const retryAfter = res?.headers?.get?.("retry-after") || res?.headers?.get?.("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      hint = Math.max(hint, Math.floor(seconds * 1000));
    } else {
      const dateMs = Date.parse(retryAfter);
      if (!isNaN(dateMs)) {
        hint = Math.max(hint, dateMs - Date.now());
      }
    }
  }

  if (typeof bodyText === "string" && bodyText.length > 0) {
    try {
      const json    = JSON.parse(bodyText);
      const details = json?.error?.details;
      if (Array.isArray(details)) {
        for (const d of details) {
          if (typeof d?.["@type"] === "string" && d["@type"].includes("RetryInfo") && typeof d.retryDelay === "string") {
            const match = d.retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
            if (match) {
              hint = Math.max(hint, Math.ceil(Number(match[1]) * 1000));
            }
          }
        }
      }
      const raw = json?.retry_after ?? json?.error?.retry_after;
      if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
        hint = Math.max(hint, Math.floor(raw * 1000));
      }
    } catch (_) {
      /* 본문이 JSON이 아니면 무시 */
    }
  }

  return hint > 0 ? hint : 0;
}

/**
 * 기본 지터와 서버 힌트를 결합하여 최종 쿨다운(ms)을 산출한다.
 * 너무 긴 대기(>hardCapMs)는 잘라, 일일 한도 소진 시에도 다른 fallback이 지속 활용되도록 한다.
 *
 * @param {object}   opts
 * @param {Response} opts.res          - fetch 응답
 * @param {string}   opts.bodyText     - 이미 읽어둔 본문
 * @param {number}   [opts.minMs=500]  - 지터 최소값
 * @param {number}   [opts.maxMs=2000] - 지터 최대값
 * @param {number}   [opts.hardCapMs=60000] - 전체 상한
 * @returns {{ cooldownMs: number, hintMs: number }}
 */
export function computeCooldown({ res, bodyText, minMs = 500, maxMs = 2000, hardCapMs = 60_000 }) {
  const jitter  = minMs + Math.floor(Math.random() * Math.max(0, maxMs - minMs));
  const hint    = extractRetryHintMs(res, bodyText);
  const raw     = Math.max(jitter, hint);
  const cooldownMs = Math.min(Math.max(raw, 0), hardCapMs);
  return { cooldownMs, hintMs: hint };
}
