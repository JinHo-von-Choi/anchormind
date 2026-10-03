/**
 * 행 잠금 충돌 재시도 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 재시도 판정은 40P01과 55P03만 대상으로 하고, 상한까지 트랜잭션 함수 전체를 다시 부르며,
 * 대기 시간은 상한의 절반과 상한 사이에 있다. 재시도마다 operation 라벨의 지표가 오른다.
 */

import { describe, it, afterEach }  from "node:test";
import assert                       from "node:assert/strict";

const {
  isRetryableLockError, lockRetryDelayMs, lockRetryLimit, withLockRetry, recordWriteFailure,
  deadlockRetriesTotal, dbWriteFailuresTotal, LOCK_RETRY_OPERATIONS, UnknownLockOperationError,
  DEFAULT_LOCK_RETRY_MAX, LOCK_RETRY_BASE_MS, LOCK_RETRY_CEILING_MS
} = await import("../../lib/tools/lock-retry.js");
const { register } = await import("../../lib/metrics.js");

/**
 * 지표의 operation 라벨 값을 읽는다.
 *
 * @param {import("prom-client").Counter} counter
 * @param {string} operation
 * @returns {Promise<number>}
 */
async function counterValue(counter, operation) {
  const { values } = await counter.get();
  return values.find(v => v.labels.operation === operation)?.value ?? 0;
}

/** SQLSTATE를 가진 오류 */
function pgError(code) {
  const err = new Error(`pg ${code}`);
  err.code  = code;
  return err;
}

const noSleep = async () => {};

describe("isRetryableLockError", () => {
  it("40P01과 55P03만 재시도 대상이다", () => {
    assert.equal(isRetryableLockError(pgError("40P01")), true);
    assert.equal(isRetryableLockError(pgError("55P03")), true);
    for (const code of ["40001", "57014", "23505", "08006", undefined]) {
      assert.equal(isRetryableLockError(pgError(code)), false, String(code));
    }
    assert.equal(isRetryableLockError(null), false);
  });
});

describe("lockRetryDelayMs", () => {
  it("상한은 재시도마다 두 배로 늘고 400ms에서 멈추며 대기는 상한의 절반 이상이다", () => {
    const ceilings = [1, 2, 3, 4, 5, 6, 10].map(n => lockRetryDelayMs(n, () => 0.999999));
    assert.deepEqual(ceilings, [25, 50, 100, 200, 400, 400, 400]);
    const floors = [1, 2, 3, 4, 5, 6].map(n => lockRetryDelayMs(n, () => 0));
    assert.deepEqual(floors, [13, 25, 50, 100, 200, 200]);
    assert.equal(LOCK_RETRY_BASE_MS, 25);
    assert.equal(LOCK_RETRY_CEILING_MS, 400);
  });
});

describe("lockRetryLimit", () => {
  const saved = process.env.MEMENTO_DB_LOCK_RETRY_MAX;
  afterEach(() => {
    if (saved === undefined) delete process.env.MEMENTO_DB_LOCK_RETRY_MAX;
    else process.env.MEMENTO_DB_LOCK_RETRY_MAX = saved;
  });

  it("미설정이면 기본값, 0과 10은 그대로, 범위 밖과 정수 아님은 기본값이다", () => {
    delete process.env.MEMENTO_DB_LOCK_RETRY_MAX;
    assert.equal(lockRetryLimit(), DEFAULT_LOCK_RETRY_MAX);
    for (const [raw, expected] of [["0", 0], ["10", 10], ["11", 3], ["-1", 3], ["1.5", 3], ["x", 3]]) {
      process.env.MEMENTO_DB_LOCK_RETRY_MAX = raw;
      assert.equal(lockRetryLimit(), expected, raw);
    }
  });
});

describe("withLockRetry", () => {
  it("교착이면 트랜잭션 함수를 다시 불러 성공 값을 돌려주고 재시도 지표를 올린다", async () => {
    const before = await counterValue(deadlockRetriesTotal, "access");
    const delays = [];
    let   calls  = 0;
    const result = await withLockRetry("access", async () => {
      calls++;
      if (calls < 3) throw pgError(calls === 1 ? "40P01" : "55P03");
      return "done";
    }, { maxRetries: 3, sleep: async ms => { delays.push(ms); }, random: () => 0 });

    assert.equal(result, "done");
    assert.equal(calls, 3);
    assert.deepEqual(delays, [13, 25]);
    assert.equal(await counterValue(deadlockRetriesTotal, "access") - before, 2);
  });

  it("상한을 넘으면 마지막 오류를 던지고 상한보다 많이 부르지 않는다", async () => {
    let calls = 0;
    await assert.rejects(
      withLockRetry("touch_linked", async () => { calls++; throw pgError("40P01"); }, { maxRetries: 2, sleep: noSleep }),
      err => err.code === "40P01"
    );
    assert.equal(calls, 3);
  });

  it("상한 0이면 한 번만 부른다", async () => {
    let calls = 0;
    await assert.rejects(
      withLockRetry("embedding", async () => { calls++; throw pgError("40P01"); }, { maxRetries: 0, sleep: noSleep })
    );
    assert.equal(calls, 1);
  });

  it("잠금 충돌이 아닌 오류는 다시 부르지 않는다", async () => {
    let calls = 0;
    await assert.rejects(
      withLockRetry("delete", async () => { calls++; throw pgError("23503"); }, { maxRetries: 5, sleep: noSleep }),
      err => err.code === "23503"
    );
    assert.equal(calls, 1);
  });

  it("닫힌 집합 밖의 operation은 실행 전에 거부한다", async () => {
    let calls = 0;
    await assert.rejects(withLockRetry("other", async () => { calls++; }), UnknownLockOperationError);
    assert.equal(calls, 0);
  });
});

describe("recordWriteFailure", () => {
  it("operation 라벨의 실패 지표를 올린다", async () => {
    const before = await counterValue(dbWriteFailuresTotal, "activation");
    recordWriteFailure("activation", "[test] activation", pgError("57014"));
    assert.equal(await counterValue(dbWriteFailuresTotal, "activation") - before, 1);
    assert.throws(() => recordWriteFailure("other", "[test]", pgError("1")), UnknownLockOperationError);
  });
});

describe("지표 등록", () => {
  it("두 지표가 한 번씩 등록되고 operation 라벨 하나만 가진다", async () => {
    const names = (await register.getMetricsAsJSON()).map(m => m.name);
    assert.equal(names.filter(n => n === "memento_db_deadlock_retries_total").length, 1);
    assert.equal(names.filter(n => n === "memento_db_write_failures_total").length, 1);
    assert.deepEqual(deadlockRetriesTotal.labelNames, ["operation"]);
    assert.ok(LOCK_RETRY_OPERATIONS.length > 0 && Object.isFrozen(LOCK_RETRY_OPERATIONS));
  });
});
