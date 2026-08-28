/**
 * 워커 레지스트리 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * 종료 경로가 워커를 이름으로 하나씩 알지 않아도 되도록, 기동한 워커가 스스로
 * 등록하고 종료가 일괄 배수한다. 그 계약을 못 박는다.
 *
 * 특히 한 워커의 배수 실패가 나머지를 막지 않아야 한다. 종료 중 예외를 전파해도
 * 할 수 있는 일이 없고, 나머지 워커의 진행분만 잃는다.
 */

import { test, describe, beforeEach } from "node:test";
import assert                         from "node:assert/strict";

import { PollingWorker } from "../../lib/memory/workers/PollingWorker.js";
import {
  registerWorker,
  unregisterWorker,
  listWorkers,
  drainAllWorkers,
  _resetRegistry
} from "../../lib/memory/workers/registry.js";

const tick = () => new Promise(r => setImmediate(r));

class Quiet extends PollingWorker {
  constructor(name) {
    super({ name, intervalMs: 1000 });
    this.batches = 0;
  }
  async _processBatch() { this.batches++; return 0; }
}

describe("워커 레지스트리", () => {
  beforeEach(() => _resetRegistry());

  test("기동한 워커가 스스로 등록된다", async () => {
    const w = new Quiet("A");
    await w.start();
    assert.deepEqual(listWorkers(), ["A"]);
    await w.stop();
  });

  test("기동하지 않은 워커는 등록되지 않는다", async () => {
    class Off extends Quiet { _shouldStart() { return false; } }
    await new Off("B").start();
    assert.deepEqual(listWorkers(), []);
  });

  test("stop()한 워커는 목록에서 빠진다", async () => {
    const w = new Quiet("C");
    await w.start();
    await w.stop();
    assert.deepEqual(listWorkers(), []);
  });

  test("같은 인스턴스를 두 번 등록해도 하나로 센다", () => {
    const w = new Quiet("D");
    registerWorker(w);
    registerWorker(w);
    assert.equal(listWorkers().length, 1);
  });

  test("stop이 없는 값은 등록하지 않는다", () => {
    registerWorker(null);
    registerWorker({});
    assert.deepEqual(listWorkers(), []);
  });

  test("일괄 배수가 등록된 워커를 모두 멈춘다", async () => {
    const a = new Quiet("E");
    const b = new Quiet("F");
    await a.start();
    await b.start();
    await tick();

    await Promise.all(drainAllWorkers());
    assert.equal(a.running, false);
    assert.equal(b.running, false);
    assert.deepEqual(listWorkers(), []);
  });

  test("한 워커의 배수 실패가 나머지를 막지 않는다", async () => {
    const good = new Quiet("G");
    await good.start();

    const bad = { name: "Bad", stop: () => { throw new Error("정지 실패"); } };
    registerWorker(bad);

    await Promise.all(drainAllWorkers());
    assert.equal(good.running, false);
    assert.deepEqual(listWorkers(), []);
  });

  test("배수가 거부된 프라미스도 전체를 실패시키지 않는다", async () => {
    registerWorker({ name: "Rejects", stop: () => Promise.reject(new Error("배수 실패")) });
    await Promise.all(drainAllWorkers());
    assert.deepEqual(listWorkers(), []);
  });

  test("등록 해제는 배수 대상에서 뺀다", async () => {
    const w = new Quiet("H");
    await w.start();
    unregisterWorker(w);
    assert.deepEqual(listWorkers(), []);
    await w.stop();
  });
});
