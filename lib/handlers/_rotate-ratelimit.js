/**
 * _rotate-ratelimit.js — POST /session/rotate 전용 IP 기반 Rate-Limit 헬퍼
 *
 * 정책: IP당 분당 MEMENTO_ROTATE_RATE_LIMIT_PER_MIN 회 (기본 5).
 * 구현: in-memory Map<ip, { count, windowStart }> 슬라이딩 윈도우.
 *
 * 범용 쿼터(QuotaChecker/_ratelimit-cache.js)와 정책이 다르므로
 * 별도 헬퍼로 분리한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 */

import { resolveClientIp } from "../http/helpers.js";

/** 윈도우 크기: 60,000ms (1분) */
const WINDOW_MS = 60_000;

/** 분당 최대 허용 횟수 (환경변수 오버라이드 가능) */
function getLimit() {
  const v = Number(process.env.MEMENTO_ROTATE_RATE_LIMIT_PER_MIN);
  return (Number.isInteger(v) && v > 0) ? v : 5;
}

/**
 * IP → { count: number, windowStart: number }
 * 서버 프로세스 생명주기와 동일. 재시작 시 초기화됨 (허용 가능 — 분당 제한).
 */
const _store = new Map();

/**
 * 요청 IP를 추출한다.
 * X-Forwarded-For (리버스 프록시 경유) 우선, 없으면 remoteAddress.
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {string}
 */
function extractIp(req) {
  return resolveClientIp(req);
}

/**
 * 요청이 rate-limit을 초과하는지 확인하고 카운터를 갱신한다.
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {{ allowed: boolean, retryAfter: number }} retryAfter: 초 단위 대기 시간 (allowed=false 시에만 유효)
 */
export function checkRotateRateLimit(req) {
  const ip    = extractIp(req);
  const limit = getLimit();
  const now   = Date.now();

  let entry = _store.get(ip);

  if (!entry || (now - entry.windowStart) >= WINDOW_MS) {
    /** 새 윈도우 시작 */
    entry = { count: 0, windowStart: now };
  }

  if (entry.count >= limit) {
    const windowEnd    = entry.windowStart + WINDOW_MS;
    const retryAfter   = Math.ceil((windowEnd - now) / 1000);
    _store.set(ip, entry);
    return { allowed: false, retryAfter };
  }

  entry.count += 1;
  _store.set(ip, entry);
  return { allowed: true, retryAfter: 0 };
}

/**
 * 테스트 전용: 내부 캐시를 초기화한다.
 */
export function _resetForTest() {
  _store.clear();
}

/**
 * 테스트 전용: 특정 IP의 카운터를 직접 설정한다.
 *
 * @param {string} ip
 * @param {number} count
 * @param {number} [windowStart] - 기본값: Date.now()
 */
export function _setForTest(ip, count, windowStart = Date.now()) {
  _store.set(ip, { count, windowStart });
}
