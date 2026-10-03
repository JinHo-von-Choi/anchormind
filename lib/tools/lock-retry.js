/**
 * 행 잠금 충돌 재시도
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 교착(SQLSTATE 40P01)이나 잠금 대기 상한(55P03)으로 끝난 트랜잭션은 서버가 이미
 * 전부 되돌렸다. 같은 트랜잭션을 처음부터 다시 실행하면 결과는 한 번 실행한 것과 같다.
 * 이 모듈은 그 재실행을 횟수 상한과 지터가 있는 대기로 감싼다. 재시도 대상은 호출자가
 * 넘기는 트랜잭션 함수 전체이며, 문장 하나만 다시 보내지 않는다.
 *
 * 재시도 횟수 상한은 MEMENTO_DB_LOCK_RETRY_MAX(기본 3, 0이면 재시도하지 않음)이다.
 * 재시도마다 memento_db_deadlock_retries_total{operation}이 1 늘고 경고 한 줄이 남는다.
 * 실패를 던지지 않고 로그로 끝내는 배경 쓰기는 recordWriteFailure로 실패를 센다.
 */

import promClient   from "prom-client";
import { register } from "../metrics.js";
import { envInt, DEFAULT_DB_LOCK_RETRY_MAX, MAX_DB_LOCK_RETRY_MAX } from "../config.js";
import { logWarn }  from "../logger.js";

/** 재시도하는 SQLSTATE. 40P01: deadlock_detected, 55P03: lock_not_available */
export const RETRYABLE_LOCK_CODES = Object.freeze(["40P01", "55P03"]);

/** operation 라벨의 닫힌 집합. 행 잠금 순서 문서의 경로 이름과 같다. */
export const LOCK_RETRY_OPERATIONS = Object.freeze([
  "access",
  "touch_linked",
  "embedding",
  "link_sync",
  "unlink",
  "delete",
  "gc_delete",
  "score_batch",
  "activation",
  "feedback",
  "case_reward",
  "merge_links",
  "tier",
  "ema_decay",
  "anchor_promotion",
  "stale_importance"
]);

export const DEFAULT_LOCK_RETRY_MAX = DEFAULT_DB_LOCK_RETRY_MAX;
export const LOCK_RETRY_BASE_MS     = 25;
export const LOCK_RETRY_CEILING_MS  = 400;

/** 잠금 충돌 재시도 횟수 (operation별) */
export const deadlockRetriesTotal = new promClient.Counter({
  name      : "memento_db_deadlock_retries_total",
  help      : "Transactions re-run after a deadlock (40P01) or lock timeout (55P03), by operation",
  labelNames: ["operation"],
  registers : [register]
});

/** 로그만 남기고 호출자에게 던지지 않은 쓰기 실패 수 (operation별) */
export const dbWriteFailuresTotal = new promClient.Counter({
  name      : "memento_db_write_failures_total",
  help      : "Background fragment writes that failed and were logged instead of thrown, by operation",
  labelNames: ["operation"],
  registers : [register]
});

/** 닫힌 집합 밖의 operation 이름 */
export class UnknownLockOperationError extends TypeError {
  constructor(operation) {
    super(`unknown lock retry operation: ${String(operation)}`);
    this.name      = "UnknownLockOperationError";
    this.operation = operation;
  }
}

/**
 * 재시도할 잠금 충돌인지 판정한다.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRetryableLockError(err) {
  return Boolean(err) && RETRYABLE_LOCK_CODES.includes(err.code);
}

/**
 * 재시도 횟수 상한. 0 이상 10 이하의 정수만 받고 그 밖은 기본값이다.
 *
 * @returns {number}
 */
export function lockRetryLimit() {
  return envInt("MEMENTO_DB_LOCK_RETRY_MAX", DEFAULT_DB_LOCK_RETRY_MAX,
    { min: 0, max: MAX_DB_LOCK_RETRY_MAX, fallback: true });
}

/**
 * retry번째 재시도 전 대기 시간(ms). 상한은 기준값의 2^(retry-1)배이되 400ms를 넘지 않고,
 * 실제 대기는 상한의 절반에서 상한 사이에서 고른다.
 *
 * @param {number} retry 1부터 센 재시도 차례
 * @param {() => number} [random=Math.random] [0, 1) 값을 내는 함수
 * @returns {number}
 */
export function lockRetryDelayMs(retry, random = Math.random) {
  const ceiling = Math.min(LOCK_RETRY_CEILING_MS, LOCK_RETRY_BASE_MS * 2 ** Math.max(0, retry - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * operation 이름이 닫힌 집합에 있는지 확인한다.
 *
 * @param {string} operation
 * @returns {string}
 */
export function assertLockOperation(operation) {
  if (!LOCK_RETRY_OPERATIONS.includes(operation)) throw new UnknownLockOperationError(operation);
  return operation;
}

/**
 * runTransaction을 실행하고, 잠금 충돌로 끝나면 상한까지 처음부터 다시 실행한다.
 * runTransaction은 매번 새 트랜잭션을 열고 커밋하거나 되돌려야 한다.
 *
 * @template T
 * @param {string} operation LOCK_RETRY_OPERATIONS 중 하나
 * @param {() => Promise<T>} runTransaction
 * @param {Object} [options]
 * @param {number} [options.maxRetries]  생략하면 lockRetryLimit()
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.random]
 * @returns {Promise<T>}
 */
export async function withLockRetry(operation, runTransaction, options = {}) {
  assertLockOperation(operation);
  const maxRetries = options.maxRetries ?? lockRetryLimit();
  const sleep      = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const random     = options.random ?? Math.random;

  for (let retry = 1; ; retry++) {
    try {
      return await runTransaction();
    } catch (err) {
      if (!isRetryableLockError(err)) throw err;
      if (retry > maxRetries) throw err;
      const delay = lockRetryDelayMs(retry, random);
      deadlockRetriesTotal.inc({ operation });
      logWarn(`[lock-retry] ${operation} ${err.code} retry ${retry}/${maxRetries} after ${delay}ms`);
      await sleep(delay);
    }
  }
}

/**
 * 던지지 않고 로그로 끝내는 배경 쓰기의 실패를 세고 경고 한 줄을 남긴다.
 *
 * @param {string} operation LOCK_RETRY_OPERATIONS 중 하나
 * @param {string} context   로그 앞머리
 * @param {Error}  err
 * @returns {void}
 */
export function recordWriteFailure(operation, context, err) {
  assertLockOperation(operation);
  dbWriteFailuresTotal.inc({ operation });
  logWarn(`${context}: ${err?.code ? `${err.code} ` : ""}${err?.message ?? String(err)}`);
}
