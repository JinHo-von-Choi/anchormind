/**
 * Primary 풀 백그라운드 게이트 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-09-18
 *
 * 검증 항목:
 * 1. BackgroundGate: capacity 초과 획득은 FIFO 로 대기하고 반납 시 선두부터 깨어난다
 * 2. BackgroundGate: 반납 함수 중복 호출은 슬롯을 두 번 돌려주지 않는다
 * 3. gatePool: 요청 레인(runInBackground 밖)은 게이트를 거치지 않는다
 * 4. gatePool: 백그라운드 레인은 capacity 만큼만 동시에 풀에 닿고 나머지는 큐에서 기다린다
 * 5. gatePool: client.release() 가 슬롯을 돌려주고 원래 release 도 호출한다
 * 6. gatePool: 콜백 방식 connect(pool.query 경로)도 게이트를 탄다
 * 7. gatePool: 풀 연결 실패 시 슬롯이 새지 않는다
 * 8. BackgroundGate: 느린 대기는 실패시키지 않고 경고 훅만 부른다
 * 9. BackgroundGate: maxWaitMs 를 넘긴 대기는 background_slot_timeout 으로 실패하고 큐에서 빠진다
 * 10. BackgroundGate: close() 는 대기자를 모두 실패시키고 새 획득을 거부하며 open() 으로 재개한다
 * 11. gatePool: 종료 중(pool.ending)인 풀은 슬롯 없이 원래 connect 로 넘긴다
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BackgroundGate, gatePool, runInBackground, currentLane } from "../../lib/tools/pool-gate.js";

const tick = () => new Promise(resolve => setImmediate(resolve));

/** 실제 pg Pool 대신 쓰는 최소 페이크. connect() 호출 수와 미반납 클라이언트를 세고,
 *  pg-pool 의 _releaseOnce 처럼 두 번째 release 는 throw 한다. */
function makeFakePool({ failConnect = false } = {}) {
  const pool = {
    connectCalls: 0,
    checkedOut  : 0,
    releases    : 0,
    ending      : false,
    connect(cb) {
      this.connectCalls += 1;
      const run = async () => {
        if (this.ending) throw new Error("Cannot use a pool after calling end on the pool");
        if (failConnect) throw new Error("connect refused");
        this.checkedOut += 1;
        let released = false;
        const client  = {
          release: (_err) => {
            if (released) throw new Error("Release called on client which has already been released to the pool.");
            released         = true;
            pool.checkedOut -= 1;
            pool.releases   += 1;
          }
        };
        return client;
      };
      const p = run();
      if (typeof cb !== "function") return p;
      p.then(client => cb(undefined, client, client.release), err => cb(err));
      return undefined;
    }
  };
  return pool;
}

describe("BackgroundGate", () => {
  it("capacity 초과 획득은 FIFO 로 대기하고 반납 순서대로 깨어난다", async () => {
    const gate  = new BackgroundGate({ capacity: 2 });
    const order = [];

    const r1 = await gate.acquire("a");
    const r2 = await gate.acquire("b");
    assert.equal(gate.active, 2);

    const p3 = gate.acquire("c").then(r => { order.push("c"); return r; });
    const p4 = gate.acquire("d").then(r => { order.push("d"); return r; });
    await tick();
    assert.equal(gate.waiting, 2);
    assert.deepEqual(order, []);

    r1();
    const r3 = await p3;
    assert.deepEqual(order, ["c"]);
    assert.equal(gate.waiting, 1);

    r2();
    const r4 = await p4;
    assert.deepEqual(order, ["c", "d"]);
    assert.equal(gate.active, 2);

    r3();
    r4();
    assert.equal(gate.active, 0);
  });

  it("반납 함수를 두 번 불러도 슬롯은 한 번만 돌아온다", async () => {
    const gate    = new BackgroundGate({ capacity: 1 });
    const release = await gate.acquire("x");
    release();
    release();
    assert.equal(gate.active, 0);
  });

  it("느린 대기는 실패시키지 않고 경고 훅만 부른다", async () => {
    const warnings = [];
    const gate     = new BackgroundGate({ capacity: 1, slowWaitWarnMs: 5, onSlowWait: m => warnings.push(m) });
    const first    = await gate.acquire("holder");
    const waiter   = gate.acquire("late");

    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /late waited \d+ms/);

    first();
    const second = await waiter;
    second();
    assert.equal(gate.active, 0);
  });

  it("capacity 가 양의 정수가 아니면 거부한다", () => {
    assert.throws(() => new BackgroundGate({ capacity: 0 }));
    assert.throws(() => new BackgroundGate({ capacity: 1.5 }));
    assert.throws(() => new BackgroundGate({ capacity: NaN }));
    assert.throws(() => new BackgroundGate({ capacity: 1, maxWaitMs: 0 }));
  });

  it("maxWaitMs 를 넘긴 대기는 background_slot_timeout 으로 실패하고 큐에서 빠진다", async () => {
    const gate   = new BackgroundGate({ capacity: 1, maxWaitMs: 10, slowWaitWarnMs: 1000 });
    const holder = await gate.acquire("holder");

    await assert.rejects(gate.acquire("late"), err => {
      assert.equal(err.code, "background_slot_timeout");
      assert.match(err.message, /late gave up after \d+ms/);
      return true;
    });
    assert.equal(gate.waiting, 0);
    assert.equal(gate.active, 1);

    /** 타임아웃으로 빠진 대기자가 이후 반납 시 슬롯을 받지 않는다 */
    holder();
    assert.equal(gate.active, 0);
  });

  it("close() 는 대기자를 모두 실패시키고 새 획득을 거부하며 open() 으로 재개한다", async () => {
    const gate   = new BackgroundGate({ capacity: 1 });
    const holder = await gate.acquire("holder");
    const w1     = gate.acquire("w1");
    const w2     = gate.acquire("w2");
    await tick();
    assert.equal(gate.waiting, 2);

    gate.close();
    for (const w of [w1, w2]) {
      await assert.rejects(w, err => err.code === "background_gate_closed");
    }
    assert.equal(gate.waiting, 0);
    await assert.rejects(gate.acquire("after-close"), err => err.code === "background_gate_closed");

    holder();
    assert.equal(gate.active, 0);

    gate.open();
    const again = await gate.acquire("reopened");
    assert.equal(gate.active, 1);
    again();
  });
});

describe("gatePool", () => {
  it("요청 레인은 게이트를 거치지 않고 풀에 바로 닿는다", async () => {
    const gate = new BackgroundGate({ capacity: 1 });
    const pool = gatePool(makeFakePool(), gate);

    assert.equal(currentLane(), null);
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    const c3 = await pool.connect();
    assert.equal(pool.checkedOut, 3);
    assert.equal(gate.active, 0);

    c1.release();
    c2.release();
    c3.release();
    assert.equal(pool.checkedOut, 0);
  });

  it("백그라운드 레인은 capacity 만큼만 동시에 풀에 닿고 나머지는 큐에서 기다린다", async () => {
    const gate = new BackgroundGate({ capacity: 2 });
    const pool = gatePool(makeFakePool(), gate);

    const clients = [];
    const pending = runInBackground("worker", () =>
      Promise.all([1, 2, 3, 4].map(() => pool.connect().then(c => { clients.push(c); return c; })))
    );

    await tick();
    await tick();
    assert.equal(pool.connectCalls, 2);
    assert.equal(gate.active, 2);
    assert.equal(gate.waiting, 2);

    clients[0].release();
    await tick();
    await tick();
    assert.equal(pool.connectCalls, 3);
    assert.equal(gate.waiting, 1);

    clients[1].release();
    await tick();
    await tick();
    assert.equal(pool.connectCalls, 4);
    assert.equal(gate.waiting, 0);

    const all = await pending;
    all[2].release();
    all[3].release();
    assert.equal(gate.active, 0);
    assert.equal(pool.checkedOut, 0);
  });

  it("client.release() 는 원래 release 를 호출한 뒤 슬롯을 돌려준다", async () => {
    const gate = new BackgroundGate({ capacity: 1 });
    const pool = gatePool(makeFakePool(), gate);

    const client = await runInBackground("worker", () => pool.connect());
    assert.equal(gate.active, 1);
    client.release();
    assert.equal(pool.releases, 1);
    assert.equal(gate.active, 0);

    /** 반납 뒤 다시 부르면 pg-pool 의 원래 release 가 그대로 throw 하고 게이트는 이중 반납하지 않는다 */
    assert.throws(() => client.release(), /already been released/);
    assert.equal(pool.releases, 1);
    assert.equal(gate.active, 0);
  });

  it("종료 중인 풀은 슬롯을 소모하지 않고 원래 connect 로 넘긴다", async () => {
    const gate  = new BackgroundGate({ capacity: 1 });
    const pool  = gatePool(makeFakePool(), gate);
    pool.ending = true;

    await assert.rejects(() => runInBackground("worker", () => pool.connect()), /after calling end/);
    assert.equal(gate.active, 0);
    assert.equal(gate.waiting, 0);
    assert.equal(pool.connectCalls, 1);
  });

  it("콜백 방식 connect 도 게이트를 탄다 (pg-pool query 경로)", async () => {
    const gate = new BackgroundGate({ capacity: 1 });
    const pool = gatePool(makeFakePool(), gate);

    const held = await runInBackground("worker", () => pool.connect());
    assert.equal(gate.active, 1);

    let cbClient = null;
    runInBackground("worker", () => {
      const ret = pool.connect((err, client, done) => {
        assert.equal(err, undefined);
        cbClient = client;
        assert.equal(typeof done, "function");
      });
      assert.equal(ret, undefined);
    });

    await tick();
    assert.equal(cbClient, null);
    assert.equal(gate.waiting, 1);

    held.release();
    await tick();
    await tick();
    assert.ok(cbClient);
    cbClient.release();
    assert.equal(gate.active, 0);
  });

  it("풀 연결 실패 시 슬롯이 새지 않는다", async () => {
    const gate = new BackgroundGate({ capacity: 1 });
    const pool = gatePool(makeFakePool({ failConnect: true }), gate);

    await assert.rejects(() => runInBackground("worker", () => pool.connect()), /connect refused/);
    assert.equal(gate.active, 0);

    await new Promise((resolve, reject) => {
      runInBackground("worker", () => pool.connect((err) => {
        try {
          assert.match(err.message, /connect refused/);
          resolve();
        } catch (e) { reject(e); }
      }));
    });
    assert.equal(gate.active, 0);
  });
});
