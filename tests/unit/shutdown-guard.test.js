/**
 * createShutdownGuard 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { createShutdownGuard } from "../../lib/process-guards.js";

function harness(deadlineMs) {
  const calls = { run: [], exit: [], log: [], timers: [] };
  const guard = createShutdownGuard({
    deadlineMs,
    run     : async (signal) => { calls.run.push(signal); },
    exit    : (code) => calls.exit.push(code),
    logError: (msg, meta) => calls.log.push({ msg, meta }),
    setTimer: (fn, ms) => { calls.timers.push({ fn, ms }); return { unref() {} }; }
  });
  return { guard, calls };
}

describe("createShutdownGuard", () => {
  it("두 번째 신호는 종료 절차를 다시 돌리지 않는다", async () => {
    const { guard, calls } = harness(60_000);
    await guard("SIGTERM");
    await guard("SIGTERM");
    assert.deepEqual(calls.run, ["SIGTERM"]);
    assert.match(calls.log[0].msg, /already in progress/);
  });

  it("상한이 지나면 exit(1)을 부른다", async () => {
    const { guard, calls } = harness(60_000);
    await guard("SIGTERM");
    assert.equal(calls.timers[0].ms, 60_000);
    calls.timers[0].fn();
    assert.deepEqual(calls.exit, [1]);
  });

  it("상한 0은 타이머를 걸지 않는다", async () => {
    const { guard, calls } = harness(0);
    await guard("SIGINT");
    assert.equal(calls.timers.length, 0);
  });
});
