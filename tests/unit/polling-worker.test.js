/**
 * PollingWorker 수명주기 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * 하위 워커들이 각자 구현하던 수명주기를 공통 기반으로 옮기면서, 그 기반이
 * 지켜야 할 성질을 못 박는다. 중복 기동 무시, in-flight 중 stop()이 완료를
 * 기다리는지, 대기 중 stop()이 즉시 풀리는지, 실패 시 백오프가 늘어나는지.
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";

import { PollingWorker } from "../../lib/memory/workers/PollingWorker.js";

/** 지연을 실제로 기다리지 않도록 타이머 예약만 관찰하는 하위 클래스 */
class Probe extends PollingWorker {
  constructor(opts = {}) {
    super({ name: "Probe", intervalMs: 50, ...opts });
    this.calls   = 0;
    this.delays  = [];
    this.gate    = null;
    this.result  = 0;
    this.throws  = false;
  }
  async _processBatch() {
    this.calls++;
    if (this.gate) await this.gate;
    if (this.throws) throw new Error("의도된 실패");
    return this.result;
  }
  _nextDelay(handled) {
    const d = super._nextDelay(handled);
    this.delays.push(d);
    return d;
  }
}

const tick = () => new Promise(r => setImmediate(r));

describe("PollingWorker 기동", () => {
  test("중복 start()는 무시한다", async () => {
    const w = new Probe();
    await w.start();
    await w.start();
    await tick();
    await w.stop();
    assert.ok(w.calls >= 1);
  });

  test("_shouldStart가 거짓이면 기동하지 않는다", async () => {
    class Off extends Probe { _shouldStart() { return false; } }
    const w = new Off();
    await w.start();
    await tick();
    assert.equal(w.calls, 0);
    assert.equal(w.running, false);
  });

  test("_onStart 훅이 첫 회차보다 먼저 실행된다", async () => {
    const order = [];
    class Hooked extends Probe {
      async _onStart() { order.push("onStart"); }
      async _processBatch() { order.push("batch"); return 0; }
    }
    const w = new Hooked();
    await w.start();
    await tick();
    await w.stop();
    assert.deepEqual(order.slice(0, 2), ["onStart", "batch"]);
  });

  test("_onStart가 실패해도 기동은 계속된다", async () => {
    class Bad extends Probe { async _onStart() { throw new Error("훅 실패"); } }
    const w = new Bad();
    await w.start();
    await tick();
    assert.equal(w.running, true);
    await w.stop();
  });
});

describe("PollingWorker 종료", () => {
  test("진행 중 배치가 끝날 때까지 stop()이 기다린다", async () => {
    const w = new Probe();
    let release;
    w.gate = new Promise(r => { release = r; });
    await w.start();
    await tick();

    let drained = false;
    const p = w.stop().then(() => { drained = true; });
    await tick();
    assert.equal(drained, false, "배치가 진행 중인데 stop이 먼저 풀렸다");

    release();
    await p;
    assert.equal(drained, true);
  });

  test("대기 중 stop()은 즉시 풀린다", async () => {
    const w = new Probe();
    await w.start();
    await tick();
    await tick();
    await w.stop();
    assert.equal(w.running, false);
    assert.equal(w.timer, null);
  });

  test("기동한 적 없는 워커의 stop()도 안전하다", async () => {
    await new Probe().stop();
  });
});

describe("PollingWorker 간격과 백오프", () => {
  test("기본은 매 회차 intervalMs를 쉰다", () => {
    const w = new Probe();
    assert.equal(w._nextDelay(3), 50);
    assert.equal(w._nextDelay(0), 50);
  });

  test("idleOnlyDelay면 처리한 회차 뒤에는 쉬지 않는다", () => {
    const w = new Probe({ idleOnlyDelay: true });
    assert.equal(w._nextDelay(3), 0);
    assert.equal(w._nextDelay(0), 50);
  });

  test("실패가 이어지면 백오프가 상한까지 커진다", async () => {
    const w = new Probe({ backoffMs: 10, backoffMaxMs: 40 });
    w.throws = true;
    await w.start();
    for (let i = 0; i < 6; i++) await tick();
    await w.stop();
    assert.ok(w._backoff <= 40, "백오프가 상한을 넘었다");
    assert.ok(w._backoff > 10, "백오프가 자라지 않았다");
  });

  test("성공하면 백오프가 초기값으로 돌아온다", async () => {
    const w = new Probe({ backoffMs: 10, backoffMaxMs: 40 });
    w._backoff = 40;
    await w.start();
    await tick();
    await w.stop();
    assert.equal(w._backoff, 10);
  });

  test("_processBatch 미구현은 명시적으로 실패한다", async () => {
    const w = new PollingWorker({ name: "Bare", intervalMs: 10 });
    await assert.rejects(() => w._processBatch(), /_processBatch/);
  });
});
