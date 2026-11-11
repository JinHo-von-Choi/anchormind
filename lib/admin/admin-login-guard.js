/**
 * 관리 인증 실패 누적과 계정 단위 지연
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 관리 계정은 마스터 키 하나다. 호출자가 요청 주소를 넘기면 실패를 주소마다 세고 그 주소의 시도만 늦춘다.
 * 주소를 넘기지 않으면(요청 주소를 믿을 수 없는 설치) 실패를 계정 단위로 세고 모든 시도를 늦춘다.
 * 연속 실패가 문턱을 넘으면 다음 시도 가능 시각을 지수적으로 늦춘다.
 * MEMENTO_ADMIN_AUTH_BACKOFF=on일 때만 지연을 적용하고, 그 밖에는 기록만 한다.
 * 마지막 실패로부터 최대 지연 시간이 지나면 누적을 새로 센다.
 * 상태는 프로세스 메모리에 둔다(재기동 시 초기화).
 *
 * 관리자 계정 로그인은 createKeyedLoginGuard로 계정(이름 해시)과 클라이언트 주소마다 따로 세고, 스위치와
 * 관계없이 지연한다. 지연 시간은 두 경우 모두 loginDelayMs(순수 함수)로 계산한다.
 */

import { adminAuthBackoffMode } from "../config.js";

const FAILURE_THRESHOLD = 5;
const BASE_DELAY_MS     = 1_000;
const MAX_DELAY_MS      = 60_000;

const state = { failures: 0, nextAllowedAt: 0, lastFailureAt: 0 };

/** 요청 주소마다 따로 세는 판정기. 호출자가 주소를 넘길 때만 쓴다. */
let addressGuard = null;
function addressGuardOf() {
  if (!addressGuard) addressGuard = createKeyedLoginGuard();
  return addressGuard;
}

/**
 * 연속 실패 수에 대한 다음 시도까지의 지연(ms). 문턱까지는 0, 그 뒤 base, 2*base, 4*base ... 최대 maxMs.
 *
 * @param {number} failures
 * @param {{ threshold?: number, baseMs?: number, maxMs?: number }} [options]
 * @returns {number}
 */
export function loginDelayMs(failures, { threshold = FAILURE_THRESHOLD, baseMs = BASE_DELAY_MS, maxMs = MAX_DELAY_MS } = {}) {
  if (!Number.isInteger(failures) || failures <= threshold) return 0;
  return Math.min(baseMs * 2 ** Math.min(failures - threshold - 1, 30), maxMs);
}

/**
 * 지금 인증 시도를 받아도 되는지 판정한다.
 *
 * @param {number} [now]
 * @param {string|null} [address] 요청 주소. null이면 계정 단위로 판정한다
 * @returns {{ allowed: boolean, retryAfterSec: number }}
 */
export function checkAdminAuthAttempt(now = Date.now(), address = null) {
  if (adminAuthBackoffMode() !== "on") return { allowed: true, retryAfterSec: 0 };
  if (address !== null) return addressGuardOf().check(address, now);
  if (now >= state.nextAllowedAt) {
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
export function recordAdminAuthFailure(now = Date.now(), address = null) {
  if (now - state.lastFailureAt > MAX_DELAY_MS) state.failures = 0;
  state.lastFailureAt = now;
  state.failures += 1;
  if (address !== null) {
    addressGuardOf().recordFailure(address, now);
    return state.failures;
  }
  if (state.failures > FAILURE_THRESHOLD) state.nextAllowedAt = now + loginDelayMs(state.failures);
  return state.failures;
}

/** 성공 시 누적을 지운다. */
export function recordAdminAuthSuccess(address = null) {
  if (address !== null) addressGuardOf().recordSuccess(address);
  state.failures      = 0;
  state.nextAllowedAt = 0;
  state.lastFailureAt = 0;
}

/** 시험 전용 초기화 */
export function _resetAdminAuthGuardForTest() {
  addressGuard = null;
  recordAdminAuthSuccess();
}

/**
 * 키(계정 이름 해시, 클라이언트 주소)마다 실패를 세는 지연 판정기. 스위치와 관계없이 지연한다.
 * 항목 수가 maxEntries를 넘으면 가장 오래 갱신되지 않은 키부터 지운다.
 *
 * @param {{ threshold?: number, maxEntries?: number }} [options]
 * @returns {{ check: Function, recordFailure: Function, recordSuccess: Function, size: Function, reset: Function }}
 */
export function createKeyedLoginGuard({ threshold = FAILURE_THRESHOLD, maxEntries = 10_000 } = {}) {
  const entries = new Map();
  return {
    check(key, now = Date.now()) {
      const entry = entries.get(key);
      if (!entry || now >= entry.nextAllowedAt) return { allowed: true, retryAfterSec: 0 };
      return { allowed: false, retryAfterSec: Math.ceil((entry.nextAllowedAt - now) / 1000) };
    },
    recordFailure(key, now = Date.now()) {
      const prev  = entries.get(key);
      const count = prev && now - prev.lastFailureAt <= MAX_DELAY_MS ? prev.failures + 1 : 1;
      entries.delete(key);
      entries.set(key, { failures: count, lastFailureAt: now, nextAllowedAt: now + loginDelayMs(count, { threshold }) });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return count;
    },
    recordSuccess(key) {
      entries.delete(key);
    },
    size() {
      return entries.size;
    },
    reset() {
      entries.clear();
    }
  };
}
