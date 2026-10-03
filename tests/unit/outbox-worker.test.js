/**
 * outbox 작업자 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 재시도 간격 계산, 실패 판정, 임대 예산 판정은 순수 함수로 본다. 작업자 동작은 시계를 주입하고
 * 저장소를 메모리 대역으로 바꿔 본다. 대역은 OutboxStore의 계약(점유 표지가 같을 때만 반영,
 * 임대 만료 뒤 재점유)을 따른다. 실제 SQL의 동시 점유와 임대 만료는 DB 레인 시험이 본다.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert                                  from "node:assert/strict";

import {
  OutboxWorker, computeBackoffMs, decideFailure, canStartNext, errorSummary, OUTBOX_WORKER_DEFAULTS
} from "../../lib/outbox/OutboxWorker.js";
import {
  registerOutboxHandler, OutboxPermanentError, _resetOutboxHandlers
} from "../../lib/outbox/OutboxHandlers.js";
import {
  outboxDeadLetterTotal, outboxLeaseLostTotal, outboxPending, outboxLagSeconds, outboxStatsUpdated
} from "../../lib/outbox/outbox-metrics.js";
import { SchedulerRegistry } from "../../lib/scheduler-registry.js";

/** 수동으로 움직이는 시계 */
function manualClock(start = 1_000_000) {
  let now = start;
  const clock   = () => now;
  clock.advance = (ms) => { now += ms; };
  return clock;
}

/**
 * OutboxStore 계약을 따르는 메모리 대역. 시각은 주입한 시계를 쓴다.
 */
class MemoryStore {
  constructor(clock) {
    this.clock   = clock;
    this.rows    = [];
    this.seq     = 0;
    this.calls   = [];
    this.cleanupResults = [];
    this.unhandledResults = [];
    this.statsValue  = { pending: 0, dead: 0, lagSeconds: 0 };
  }

  add(topic, extra = {}) {
    const row = { id: String(++this.seq), topic, aggregateId: null, payload: {}, attempts: 0,
      createdAt: new Date(this.clock()), availableAt: this.clock(), processedAt: null, deadAt: null,
      claimToken: null, lastError: null, ...extra };
    this.rows.push(row);
    return row;
  }

  pending(row) { return row.processedAt === null && row.deadAt === null; }

  async claim({ topics, limit, leaseMs, token }) {
    this.calls.push({ op: "claim", topics, limit, leaseMs, token });
    const now  = this.clock();
    const due  = this.rows.filter(r => this.pending(r) && r.availableAt <= now && topics.includes(r.topic))
      .sort((a, b) => a.availableAt - b.availableAt || Number(a.id) - Number(b.id)).slice(0, limit);
    return due.map(r => {
      const dueAt   = new Date(r.availableAt);
      r.attempts   += 1;
      r.availableAt = now + leaseMs;
      r.claimToken  = token;
      return { id: r.id, topic: r.topic, aggregateId: r.aggregateId, payload: r.payload, attempts: r.attempts, createdAt: r.createdAt, dueAt };
    });
  }

  owned(id, token) {
    const row = this.rows.find(r => r.id === id);
    return row && row.claimToken === token && this.pending(row) ? row : null;
  }

  async complete(id, token, dueAt) {
    this.calls.push({ op: "complete", id, token, dueAt });
    const row = this.owned(id, token);
    if (!row) return { applied: false, deliverySeconds: null };
    row.processedAt = this.clock();
    row.claimToken  = null;
    return { applied: true, deliverySeconds: 1 };
  }

  async fail(id, token, outcome) {
    this.calls.push({ op: "fail", id, token, ...outcome });
    const row = this.owned(id, token);
    if (!row) return false;
    row.availableAt = this.clock() + outcome.retryDelayMs;
    row.lastError   = outcome.error;
    row.claimToken  = null;
    if (outcome.dead) row.deadAt = this.clock();
    return true;
  }

  async release(ids, token) {
    this.calls.push({ op: "release", ids, token });
    let n = 0;
    for (const id of ids) {
      const row = this.owned(id, token);
      if (!row) continue;
      row.availableAt = this.clock();
      row.attempts   -= 1;
      row.claimToken  = null;
      n++;
    }
    return n;
  }

  async cleanup({ retentionDays, limit }) {
    this.calls.push({ op: "cleanup", retentionDays, limit });
    return this.cleanupResults.length > 0 ? this.cleanupResults.shift() : 0;
  }

  async deadLetterUnhandled({ topics, olderThanDays, limit }) {
    this.calls.push({ op: "unhandled", topics, olderThanDays, limit });
    return this.unhandledResults.length > 0 ? this.unhandledResults.shift() : 0;
  }

  async stats() {
    this.calls.push({ op: "stats" });
    return this.statsValue;
  }

  ops(name) { return this.calls.filter(c => c.op === name); }
}

/** 시험용 작업자. 정리와 통계는 기본으로 멀리 미뤄 전달만 보게 한다. */
function makeWorker(store, clock, settings = {}) {
  const worker = new OutboxWorker({
    store,
    clock,
    random           : () => 0.5,
    schedulerRegistry: new SchedulerRegistry(),
    settings         : { cleanupIntervalMs: 1e12, statsIntervalMs: 1e12, ...settings }
  });
  worker.running = true;
  return worker;
}

const counterValue = async (metric, labels) => {
  const data  = await metric.get();
  const entry = data.values.find(v => Object.entries(labels).every(([k, val]) => v.labels[k] === val));
  return entry ? entry.value : 0;
};

beforeEach(() => _resetOutboxHandlers());
afterEach(() => {
  delete process.env.MEMENTO_OUTBOX;
  delete process.env.MEMENTO_OUTBOX_WORKER;
  delete process.env.MEMENTO_OUTBOX_MAX_ATTEMPTS;
});

describe("computeBackoffMs", () => {
  const cfg = { baseMs: 1000, maxMs: 60_000 };

  it("첫 실패는 기준 간격의 절반에서 기준 간격 사이다", () => {
    assert.equal(computeBackoffMs(1, cfg, () => 0), 500);
    assert.equal(computeBackoffMs(1, cfg, () => 0.999999), 999);
  });

  it("실패마다 두 배로 늘어난다", () => {
    assert.equal(computeBackoffMs(2, cfg, () => 0), 1000);
    assert.equal(computeBackoffMs(3, cfg, () => 0), 2000);
    assert.equal(computeBackoffMs(4, cfg, () => 0), 4000);
  });

  it("상한을 넘지 않고 큰 횟수에서도 유한하다", () => {
    assert.equal(computeBackoffMs(7, cfg, () => 0.999999), 59_999);
    assert.equal(computeBackoffMs(1000, cfg, () => 0.999999), 59_999);
    assert.equal(computeBackoffMs(1000, cfg, () => 0), 30_000);
  });

  it("0 이하나 정수가 아닌 횟수는 첫 실패로 본다", () => {
    assert.equal(computeBackoffMs(0, cfg, () => 0), 500);
    assert.equal(computeBackoffMs(Number.NaN, cfg, () => 0), 500);
  });
});

describe("decideFailure", () => {
  it("상한 미만은 재시도, 상한에 이르면 dead-letter다", () => {
    assert.equal(decideFailure({ attempts: 1, maxAttempts: 3, permanent: false }), "retry");
    assert.equal(decideFailure({ attempts: 2, maxAttempts: 3, permanent: false }), "retry");
    assert.equal(decideFailure({ attempts: 3, maxAttempts: 3, permanent: false }), "dead");
    assert.equal(decideFailure({ attempts: 4, maxAttempts: 3, permanent: false }), "dead");
  });

  it("재시도 불가 오류는 첫 시도에서도 dead-letter다", () => {
    assert.equal(decideFailure({ attempts: 1, maxAttempts: 10, permanent: true }), "dead");
  });
});

describe("canStartNext", () => {
  it("남은 임대가 처리기 시간 상한과 여유를 합한 값 이상일 때만 다음 이벤트를 시작한다", () => {
    const base = { leaseDeadline: 60_000, handlerTimeoutMs: 15_000, marginMs: 5_000 };
    assert.equal(canStartNext({ ...base, now: 40_000 }), true);
    assert.equal(canStartNext({ ...base, now: 40_001 }), false);
    assert.equal(canStartNext({ ...base, now: 70_000 }), false);
  });
});

describe("errorSummary", () => {
  it("이름과 메시지를 담고 500자로 자른다", () => {
    assert.equal(errorSummary(new TypeError("boom")), "TypeError: boom");
    assert.equal(errorSummary(new Error("x".repeat(900))).length, 500);
    assert.equal(errorSummary("plain"), "Error: plain");
  });
});

describe("OutboxWorker 전달", () => {
  it("등록된 처리기가 없으면 점유하지 않는다", async () => {
    const clock = manualClock();
    const store = new MemoryStore(clock);
    store.add("audit.write");
    assert.equal(await makeWorker(store, clock)._processBatch(), 0);
    assert.equal(store.ops("claim").length, 0);
  });

  it("등록된 topic만 점유하고 처리기 성공 시 같은 표지로 완료를 기록한다", async () => {
    const clock = manualClock();
    const store = new MemoryStore(clock);
    const seen  = [];
    registerOutboxHandler("audit.write", async (event, ctx) => { seen.push({ ...event, aborted: ctx.signal.aborted }); });
    store.add("audit.write", { aggregateId: "f1", payload: { hash: "aa" } });
    store.add("other.topic");

    const handled = await makeWorker(store, clock)._processBatch();
    assert.equal(handled, 1);

    const [claim] = store.ops("claim");
    assert.deepEqual(claim.topics, ["audit.write"]);
    assert.equal(claim.leaseMs, OUTBOX_WORKER_DEFAULTS.leaseMs);
    assert.equal(claim.limit, OUTBOX_WORKER_DEFAULTS.batchSize);
    assert.equal(store.ops("complete")[0].token, claim.token);
    assert.equal(store.ops("complete")[0].dueAt.getTime(), store.rows[0].createdAt.getTime());

    assert.equal(seen.length, 1);
    assert.equal(seen[0].idempotencyKey, "audit.write:1");
    assert.equal(seen[0].aggregateId, "f1");
    assert.deepEqual(seen[0].payload, { hash: "aa" });
    assert.equal(seen[0].aborted, false);
    assert.notEqual(store.rows[0].processedAt, null);
    assert.equal(store.rows[1].attempts, 0);
  });

  it("한 회차의 이벤트는 점유 순서대로 하나씩 처리한다", async () => {
    const clock = manualClock();
    const store = new MemoryStore(clock);
    const order = [];
    let   inFlight = 0;
    registerOutboxHandler("audit.write", async (event) => {
      inFlight++;
      assert.equal(inFlight, 1);
      order.push(event.id);
      await new Promise(r => setImmediate(r));
      inFlight--;
    });
    for (let i = 0; i < 4; i++) store.add("audit.write");
    await makeWorker(store, clock)._processBatch();
    assert.deepEqual(order, ["1", "2", "3", "4"]);
  });

  it("처리기가 실패하면 재시도 간격을 정해 실패를 기록한다", async () => {
    const clock = manualClock();
    const store = new MemoryStore(clock);
    registerOutboxHandler("audit.write", async () => { throw new Error("db down"); });
    store.add("audit.write");

    await makeWorker(store, clock)._processBatch();
    const [fail] = store.ops("fail");
    assert.equal(fail.dead, false);
    assert.equal(fail.retryDelayMs, computeBackoffMs(1, { baseMs: OUTBOX_WORKER_DEFAULTS.backoffBaseMs, maxMs: OUTBOX_WORKER_DEFAULTS.backoffMaxMs }, () => 0.5));
    assert.equal(fail.error, "Error: db down");
    assert.equal(store.rows[0].deadAt, null);
  });

  it("점유 횟수가 상한에 이르면 dead-letter로 기록한다", async () => {
    process.env.MEMENTO_OUTBOX_MAX_ATTEMPTS = "2";
    const clock = manualClock();
    const store = new MemoryStore(clock);
    registerOutboxHandler("audit.write", async () => { throw new Error("still failing"); });
    const row    = store.add("audit.write");
    const worker = makeWorker(store, clock);
    const before = await counterValue(outboxDeadLetterTotal, { topic: "audit.write" });

    await worker._processBatch();
    assert.equal(row.deadAt, null);
    clock.advance(10 * 60_000);
    await worker._processBatch();
    assert.notEqual(row.deadAt, null);
    assert.equal(store.ops("fail")[1].dead, true);
    assert.equal(await counterValue(outboxDeadLetterTotal, { topic: "audit.write" }), before + 1);

    clock.advance(60 * 60_000);
    assert.equal(await worker._processBatch(), 0);
  });

  it("처리기별 maxAttempts가 전역 값보다 우선한다", async () => {
    const clock = manualClock();
    const store = new MemoryStore(clock);
    registerOutboxHandler("audit.write", async () => { throw new Error("nope"); }, { maxAttempts: 1 });
    store.add("audit.write");
    await makeWorker(store, clock)._processBatch();
    assert.equal(store.ops("fail")[0].dead, true);
  });

  it("OutboxPermanentError는 재시도 없이 dead-letter다", async () => {
    const clock = manualClock();
    const store = new MemoryStore(clock);
    registerOutboxHandler("audit.write", async () => { throw new OutboxPermanentError("bad payload"); });
    store.add("audit.write");
    await makeWorker(store, clock)._processBatch();
    const [fail] = store.ops("fail");
    assert.equal(fail.dead, true);
    assert.match(fail.error, /^OutboxPermanentError: bad payload$/);
  });

  it("시간 상한을 넘긴 처리기는 실패로 기록하고 signal을 중단한다", async () => {
    const clock = manualClock();
    const store = new MemoryStore(clock);
    let signal  = null;
    registerOutboxHandler("audit.write", (event, ctx) => { signal = ctx.signal; return new Promise(() => {}); });
    store.add("audit.write");
    await makeWorker(store, clock, { handlerTimeoutMs: 20 })._processBatch();
    const [fail] = store.ops("fail");
    assert.equal(fail.dead, false);
    assert.match(fail.error, /^OutboxHandlerTimeoutError/);
    assert.equal(signal.aborted, true);
  });

  it("남은 임대가 부족하면 나머지 점유를 반납한다", async () => {
    const clock = manualClock();
    const store = new MemoryStore(clock);
    const done  = [];
    registerOutboxHandler("audit.write", async (event) => { done.push(event.id); clock.advance(20_000); });
    for (let i = 0; i < 5; i++) store.add("audit.write");

    const handled = await makeWorker(store, clock, { leaseMs: 60_000, handlerTimeoutMs: 15_000, settleMarginMs: 5_000 })._processBatch();
    assert.equal(handled, 3);
    assert.deepEqual(done, ["1", "2", "3"]);
    const [release] = store.ops("release");
    assert.deepEqual(release.ids, ["4", "5"]);
    assert.deepEqual(store.rows.slice(3).map(r => [r.attempts, r.claimToken]), [[0, null], [0, null]]);
  });

  it("완료 기록이 실패하면 남은 점유를 반납하고 오류를 다시 던진다", async () => {
    const clock = manualClock();
    const store = new MemoryStore(clock);
    const dbErr = new Error("connection terminated");
    store.complete = async (id, token) => {
      store.calls.push({ op: "complete", id, token });
      throw dbErr;
    };
    registerOutboxHandler("audit.write", async () => {});
    for (let i = 0; i < 3; i++) store.add("audit.write");

    await assert.rejects(makeWorker(store, clock)._processBatch(), (err) => err === dbErr);
    assert.deepEqual(store.ops("release").map(r => r.ids), [["2", "3"]]);
    assert.deepEqual(store.rows.map(r => [r.attempts, r.claimToken === null]), [[1, false], [0, true], [0, true]]);
  });

  it("실패 기록이 실패하고 반납까지 실패해도 원래 오류를 던지고 반납 실패를 기록한다", async () => {
    const clock    = manualClock();
    const store    = new MemoryStore(clock);
    const registry = new SchedulerRegistry();
    const dbErr    = new Error("fail write");
    store.fail     = async () => { throw dbErr; };
    store.release  = async () => { throw new Error("release write"); };
    registerOutboxHandler("audit.write", async () => { throw new Error("handler"); });
    for (let i = 0; i < 2; i++) store.add("audit.write");
    const worker = new OutboxWorker({ store, clock, random: () => 0.5, schedulerRegistry: registry,
      settings: { cleanupIntervalMs: 1e12, statsIntervalMs: 1e12 } });
    worker.running = true;

    await assert.rejects(worker._processBatch(), (err) => err === dbErr);
    assert.equal(registry.getAll().outbox.lastError, "release write");
  });

  it("정지 요청을 받으면 처리 중인 이벤트만 마치고 나머지를 반납한다", async () => {
    const clock  = manualClock();
    const store  = new MemoryStore(clock);
    const worker = makeWorker(store, clock);
    registerOutboxHandler("audit.write", async () => { worker.running = false; });
    for (let i = 0; i < 3; i++) store.add("audit.write");

    assert.equal(await worker._processBatch(), 1);
    assert.deepEqual(store.ops("release")[0].ids, ["2", "3"]);
  });

  it("점유 뒤 처리기 등록이 해제된 이벤트는 반납한다", async () => {
    const clock      = manualClock();
    const store      = new MemoryStore(clock);
    const unregister = registerOutboxHandler("audit.write", async () => {});
    registerOutboxHandler("hook.reflect", async () => { unregister(); });
    store.add("hook.reflect");
    store.add("audit.write");

    assert.equal(await makeWorker(store, clock)._processBatch(), 1);
    assert.deepEqual(store.ops("release")[0].ids, ["2"]);
  });
});

describe("OutboxWorker 임대 만료와 재점유", () => {
  it("점유한 작업자가 죽으면 임대 만료 전에는 아무도 점유하지 못하고 만료 뒤 다른 작업자가 처리한다", async () => {
    const clock = manualClock();
    const store = new MemoryStore(clock);
    const seen  = [];
    registerOutboxHandler("audit.write", async (event) => { seen.push([event.id, event.attempts]); });
    store.add("audit.write");

    /** 작업자 A: 점유만 하고 처리 전에 죽는다 */
    const crashed = await store.claim({ topics: ["audit.write"], limit: 10, leaseMs: 60_000, token: "token-a" });
    assert.equal(crashed.length, 1);

    const workerB = makeWorker(store, clock, { leaseMs: 60_000 });
    clock.advance(59_999);
    assert.equal(await workerB._processBatch(), 0);
    assert.deepEqual(seen, []);

    clock.advance(1);
    assert.equal(await workerB._processBatch(), 1);
    assert.deepEqual(seen, [["1", 2]]);
    assert.notEqual(store.rows[0].processedAt, null);
  });

  it("임대를 잃은 작업자의 늦은 완료는 반영되지 않고 lease_lost로 센다", async () => {
    const clock = manualClock();
    const store = new MemoryStore(clock);
    const before = await counterValue(outboxLeaseLostTotal, {});
    let   workerB;
    registerOutboxHandler("audit.write", async (event) => {
      if (event.attempts === 1) {
        /** 첫 전달이 임대를 넘겨 머무는 동안 다른 작업자가 재점유해 처리한다 */
        clock.advance(61_000);
        await workerB._processBatch();
      }
    });
    store.add("audit.write");
    workerB = makeWorker(store, clock);

    await makeWorker(store, clock)._processBatch();
    const completes = store.ops("complete");
    assert.equal(completes.length, 2);
    assert.notEqual(completes[0].token, completes[1].token);
    assert.equal(await counterValue(outboxLeaseLostTotal, {}), before + 1);
    assert.equal(store.rows[0].attempts, 2);
  });
});

describe("OutboxWorker 정리와 통계", () => {
  it("정리는 묶음이 꽉 찬 동안만 반복하고 회차 상한에서 멈춘다", async () => {
    const clock = manualClock();
    const store = new MemoryStore(clock);
    store.cleanupResults = [10, 10, 10, 10, 10];
    const worker = makeWorker(store, clock, { cleanupIntervalMs: 1000, cleanupChunk: 10, cleanupMaxPerRun: 30 });
    await worker._processBatch();
    assert.equal(store.ops("cleanup").length, 3);
    assert.equal(store.ops("cleanup")[0].limit, 10);
  });

  it("정리 묶음이 덜 차면 그 회차를 끝내고 간격이 지나기 전에는 다시 돌지 않는다", async () => {
    const clock = manualClock();
    const store = new MemoryStore(clock);
    store.cleanupResults = [4, 3];
    const worker = makeWorker(store, clock, { cleanupIntervalMs: 1000, cleanupChunk: 10, cleanupMaxPerRun: 100 });
    await worker._processBatch();
    await worker._processBatch();
    assert.equal(store.ops("cleanup").length, 1);
    clock.advance(1000);
    await worker._processBatch();
    assert.equal(store.ops("cleanup").length, 2);
  });

  it("처리기 없는 topic의 오래된 대기 행은 등록 topic 목록과 일수로 묶음 단위 dead-letter로 옮긴다", async () => {
    process.env.MEMENTO_OUTBOX_UNHANDLED_DAYS = "9";
    try {
      const clock = manualClock();
      const store = new MemoryStore(clock);
      store.unhandledResults = [10, 10, 4];
      registerOutboxHandler("audit.write", async () => {});
      const worker = makeWorker(store, clock, { cleanupIntervalMs: 1000, cleanupChunk: 10, cleanupMaxPerRun: 100 });
      await worker._processBatch();
      const calls = store.ops("unhandled");
      assert.equal(calls.length, 3);
      assert.deepEqual(calls[0], { op: "unhandled", topics: ["audit.write"], olderThanDays: 9, limit: 10 });
      assert.equal(worker.snapshot().totals.unhandled, 24);
    } finally {
      delete process.env.MEMENTO_OUTBOX_UNHANDLED_DAYS;
    }
  });

  it("보존 일수는 MEMENTO_OUTBOX_RETENTION_DAYS를 따른다", async () => {
    process.env.MEMENTO_OUTBOX_RETENTION_DAYS = "3";
    try {
      const clock = manualClock();
      const store = new MemoryStore(clock);
      await makeWorker(store, clock, { cleanupIntervalMs: 1 })._processBatch();
      assert.equal(store.ops("cleanup")[0].retentionDays, 3);
    } finally {
      delete process.env.MEMENTO_OUTBOX_RETENTION_DAYS;
    }
  });

  it("통계는 게이지와 스냅숏, 스케줄러 기록에 반영한다", async () => {
    const clock    = manualClock();
    const store    = new MemoryStore(clock);
    store.statsValue = { pending: 7, dead: 2, lagSeconds: 12.5 };
    const registry = new SchedulerRegistry();
    const worker   = new OutboxWorker({ store, clock, random: () => 0.5, schedulerRegistry: registry,
      settings: { cleanupIntervalMs: 1e12, statsIntervalMs: 1000 } });
    worker.running = true;
    await worker._processBatch();

    assert.equal((await outboxPending.get()).values[0].value, 7);
    assert.equal((await outboxLagSeconds.get()).values[0].value, 12.5);
    assert.equal((await outboxStatsUpdated.get()).values[0].value, Math.floor(clock() / 1000));
    const snap = worker.snapshot();
    assert.equal(snap.pending, 7);
    assert.equal(snap.dead, 2);
    assert.equal(registry.getAll().outbox.lastSummary.dead, 2);
  });

  it("정리나 통계가 실패해도 전달은 계속하고 실패를 기록한다", async () => {
    const clock = manualClock();
    const store = new MemoryStore(clock);
    store.stats = async () => { throw new Error("stats failed"); };
    const registry = new SchedulerRegistry();
    const worker   = new OutboxWorker({ store, clock, random: () => 0.5, schedulerRegistry: registry,
      settings: { cleanupIntervalMs: 1e12, statsIntervalMs: 1 } });
    worker.running = true;
    registerOutboxHandler("audit.write", async () => {});
    store.add("audit.write");

    assert.equal(await worker._processBatch(), 1);
    assert.equal(registry.getAll().outbox.lastError, "stats failed");
  });
});

describe("OutboxWorker 기동 조건", () => {
  const worker = () => new OutboxWorker({ store: new MemoryStore(manualClock()) });

  it("두 스위치가 모두 on(기본)이면 기동한다", () => {
    assert.equal(worker()._shouldStart(), true);
  });

  it("MEMENTO_OUTBOX=off이면 기동하지 않는다", () => {
    process.env.MEMENTO_OUTBOX = "off";
    assert.equal(worker()._shouldStart(), false);
  });

  it("MEMENTO_OUTBOX_WORKER=off이면 기동하지 않는다", () => {
    process.env.MEMENTO_OUTBOX_WORKER = "off";
    assert.equal(worker()._shouldStart(), false);
  });
});
