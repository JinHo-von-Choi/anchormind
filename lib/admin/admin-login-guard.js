/**
 * 관리 인증 실패 누적과 계정 단위 지연
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 관리 계정은 마스터 키 하나다. 실패를 클라이언트 주소와 무관하게 계정 단위로 센다.
 * 연속 실패가 문턱을 넘으면 다음 시도 가능 시각을 지수적으로 늦춘다.
 * MEMENTO_ADMIN_AUTH_BACKOFF=on일 때만 지연을 적용하고, 그 밖에는 기록만 한다.
 * 마지막 실패로부터 최대 지연 시간이 지나면 누적을 새로 센다.
 * 상태는 프로세스 메모리에 둔다(재기동 시 초기화).
 */

import { adminAuthBackoffMode } from "../config.js";

const FAILURE_THRESHOLD = 5;
const BASE_DELAY_MS     = 1_000;
const MAX_DELAY_MS      = 60_000;

const state = { failures: 0, nextAllowedAt: 0, lastFailureAt: 0 };

/**
 * 지금 인증 시도를 받아도 되는지 판정한다.
 *
 * @param {number} [now]
 * @returns {{ allowed: boolean, retryAfterSec: number }}
 */
export function checkAdminAuthAttempt(now = Date.now()) {
  if (adminAuthBackoffMode() !== "on" || now >= state.nextAllowedAt) {
    return { allowed: true, retryAfterSec: 0 };
  }
  return { allowed: false, retryAfterSec: Math.ceil((state.nextAllowedAt - now) / 1000) };
}

/**
 * 실패 1회를 기록하고 누적 횟수를 돌려준다.
 *
 * @param {number} [now]
 * @returns {number}
 */
export function recordAdminAuthFailure(now = Date.now()) {
  if (now - state.lastFailureAt > MAX_DELAY_MS) state.failures = 0;
  state.lastFailureAt = now;
  state.failures += 1;
  if (state.failures > FAILURE_THRESHOLD) {
    const exponent      = state.failures - FAILURE_THRESHOLD - 1;
    const delayMs       = Math.min(BASE_DELAY_MS * 2 ** exponent, MAX_DELAY_MS);
    state.nextAllowedAt = now + delayMs;
  }
  return state.failures;
}

/** 성공 시 누적을 지운다. */
export function recordAdminAuthSuccess() {
  state.failures      = 0;
  state.nextAllowedAt = 0;
  state.lastFailureAt = 0;
}

/** 시험 전용 초기화 */
export function _resetAdminAuthGuardForTest() {
  recordAdminAuthSuccess();
}
