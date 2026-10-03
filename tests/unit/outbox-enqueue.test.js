/**
 * outbox 기록(enqueue) 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 연결은 질의를 기록하는 대역으로 바꾼다. 트랜잭션 연결 요구, 입력 검증, 스위치, 독립 트랜잭션
 * 기록, 멱등 키를 본다. 실제 트랜잭션 원자성은 DB 레인 시험이 본다.
 */

import { describe, it, afterEach } from "node:test";
import assert                      from "node:assert/strict";

import {
  enqueue, enqueueStandalone, normalizeOutboxEvent, idempotencyKey,
  OutboxValidationError, OutboxTransactionRequiredError, PAYLOAD_MAX_BYTES
} from "../../lib/outbox/Outbox.js";

/**
 * 질의를 기록하고 정해 둔 결과를 돌려주는 연결 대역. release가 있으면 풀에서 빌린 연결이다.
 * getTransactionStatus는 pg 클라이언트처럼 BEGIN 뒤 "T", COMMIT과 ROLLBACK 뒤 "I"를 돌려준다.
 * insertError를 주면 INSERT가 그 오류로 실패한다.
 */
function fakeClient({ rows = [{ id: "41" }], status = "T", withRelease = true, insertError = null } = {}) {
  const calls  = [];
  const client = {
    calls,
    status,
    getTransactionStatus() { return client.status; },
    async query(sql, params) {
      const text = String(sql).trim();
      calls.push({ sql: text, params });
      if (/^BEGIN/i.test(text)) client.status = "T";
      if (/^(COMMIT|ROLLBACK)/i.test(text)) client.status = "I";
      if (/INSERT/i.test(text)) {
        if (insertError) throw insertError;
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }
  };
  if (withRelease) client.release = () => { client.released = true; };
  return client;
}

const EVENT = Object.freeze({ topic: "audit.write", aggregateId: "frag-1", payload: { hash: "ab12", length: 10 } });

afterEach(() => {
  delete process.env.MEMENTO_OUTBOX;
});

describe("enqueue의 연결 요구", () => {
  it("풀에서 빌린 연결이 아닌 객체(release 없음)는 질의 없이 거부한다", async () => {
    const pool = fakeClient({ withRelease: false });
    await assert.rejects(enqueue(pool, EVENT), OutboxTransactionRequiredError);
    assert.equal(pool.calls.length, 0);
  });

  it("연결이 없으면 거부한다", async () => {
    await assert.rejects(enqueue(null, EVENT), OutboxTransactionRequiredError);
  });

  it("트랜잭션 블록 밖(I), 실패한 블록(E), 상태를 알 수 없는 연결은 질의 없이 거부한다", async () => {
    for (const status of ["I", "E", null]) {
      const client = fakeClient({ status });
      await assert.rejects(enqueue(client, EVENT), OutboxTransactionRequiredError, String(status));
      assert.equal(client.calls.length, 0);
    }
    const legacy = fakeClient();
    delete legacy.getTransactionStatus;
    await assert.rejects(enqueue(legacy, EVENT), OutboxTransactionRequiredError);
  });

  it("행을 넣으면 id를 돌려주고 질의 하나만 보낸다", async () => {
    const client = fakeClient({ rows: [{ id: "41" }] });
    const result = await enqueue(client, EVENT);
    assert.deepEqual(result, { id: "41" });
    assert.equal(client.calls.length, 1);
    const [topic, aggregateId, payloadJson, delayMs] = client.calls[0].params;
    assert.equal(topic, "audit.write");
    assert.equal(aggregateId, "frag-1");
    assert.deepEqual(JSON.parse(payloadJson), { hash: "ab12", length: 10 });
    assert.equal(delayMs, 0);
  });
});

describe("enqueue 스위치", () => {
  it("MEMENTO_OUTBOX=off이면 질의 없이 null을 돌려준다", async () => {
    process.env.MEMENTO_OUTBOX = "off";
    const client = fakeClient();
    assert.equal(await enqueue(client, EVENT), null);
    assert.equal(client.calls.length, 0);
  });

  it("off에서도 연결 형식이 틀리면 거부한다", async () => {
    process.env.MEMENTO_OUTBOX = "off";
    await assert.rejects(enqueue({ query: async () => ({}) }, EVENT), OutboxTransactionRequiredError);
  });
});

describe("이벤트 검증", () => {
  const invalid = (event, field) => assert.throws(() => normalizeOutboxEvent(event), (err) =>
    err instanceof OutboxValidationError && err.field === field);

  it("topic 형식이 틀리면 거부한다", () => {
    invalid({ topic: "Audit Write" }, "topic");
    invalid({}, "topic");
  });

  it("aggregateId는 비어 있지 않은 200자 이하 문자열이거나 생략한다", () => {
    assert.equal(normalizeOutboxEvent({ topic: "a.b" }).aggregateId, null);
    assert.equal(normalizeOutboxEvent({ topic: "a.b", aggregateId: "x".repeat(200) }).aggregateId.length, 200);
    invalid({ topic: "a.b", aggregateId: "" }, "aggregateId");
    invalid({ topic: "a.b", aggregateId: "x".repeat(201) }, "aggregateId");
    invalid({ topic: "a.b", aggregateId: 7 }, "aggregateId");
  });

  it("payload는 일반 객체이고 생략하면 빈 객체다", () => {
    assert.equal(normalizeOutboxEvent({ topic: "a.b" }).payloadJson, "{}");
    invalid({ topic: "a.b", payload: [1, 2] }, "payload");
    invalid({ topic: "a.b", payload: "text" }, "payload");
    invalid({ topic: "a.b", payload: null }, "payload");
  });

  it("직렬화할 수 없는 payload는 거부한다", () => {
    const circular = {};
    circular.self  = circular;
    invalid({ topic: "a.b", payload: circular }, "payload");
    invalid({ topic: "a.b", payload: { n: 10n } }, "payload");
  });

  it("직렬화한 크기가 상한을 넘으면 거부한다(바이트 기준)", () => {
    const fits = { s: "x".repeat(PAYLOAD_MAX_BYTES - 8) };
    assert.ok(normalizeOutboxEvent({ topic: "a.b", payload: fits }).payloadJson.length <= PAYLOAD_MAX_BYTES);
    invalid({ topic: "a.b", payload: { s: "가".repeat(Math.ceil(PAYLOAD_MAX_BYTES / 3)) } }, "payload");
  });

  it("delayMs는 0 이상 30일 이하의 정수다", () => {
    assert.equal(normalizeOutboxEvent({ topic: "a.b", delayMs: 5000 }).delayMs, 5000);
    invalid({ topic: "a.b", delayMs: -1 }, "delayMs");
    invalid({ topic: "a.b", delayMs: 1.5 }, "delayMs");
    invalid({ topic: "a.b", delayMs: 30 * 86_400_000 + 1 }, "delayMs");
  });

  it("검증에 실패하면 질의를 보내지 않는다", async () => {
    const client = fakeClient();
    await assert.rejects(enqueue(client, { topic: "BAD" }), OutboxValidationError);
    assert.equal(client.calls.length, 0);
  });
});

describe("enqueueStandalone", () => {
  /** connect가 연결 대역을 내어 주는 풀 대역 */
  const fakePool = (client) => ({ connect: async () => client });

  it("독립 트랜잭션(BEGIN, INSERT, COMMIT)으로 기록하고 연결을 돌려준다", async () => {
    const client = fakeClient({ rows: [{ id: "7" }], status: "I" });
    const result = await enqueueStandalone(fakePool(client), EVENT);
    assert.deepEqual(result, { id: "7" });
    assert.deepEqual(client.calls.map(c => c.sql.split(/\s+/)[0].toUpperCase()), ["BEGIN", "INSERT", "COMMIT"]);
    assert.equal(client.released, true);
  });

  it("기록이 실패하면 롤백하고 오류를 그대로 던진다", async () => {
    const failure = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const client  = fakeClient({ status: "I", insertError: failure });
    await assert.rejects(enqueueStandalone(fakePool(client), EVENT), (err) => err === failure);
    assert.deepEqual(client.calls.map(c => c.sql.split(/\s+/)[0].toUpperCase()), ["BEGIN", "INSERT", "ROLLBACK"]);
    assert.equal(client.released, true);
  });

  it("MEMENTO_OUTBOX=off이면 연결을 빌리지 않는다", async () => {
    process.env.MEMENTO_OUTBOX = "off";
    let borrowed = false;
    const result = await enqueueStandalone({ connect: async () => { borrowed = true; return fakeClient(); } }, EVENT);
    assert.equal(result, null);
    assert.equal(borrowed, false);
  });
});

describe("멱등 키", () => {
  it("topic과 id로 정해지고 같은 이벤트의 재전달에서 같다", () => {
    const first  = idempotencyKey({ topic: "audit.write", id: "41", attempts: 1 });
    const second = idempotencyKey({ topic: "audit.write", id: "41", attempts: 3 });
    assert.equal(first, second);
    assert.notEqual(first, idempotencyKey({ topic: "audit.write", id: "42" }));
    assert.notEqual(first, idempotencyKey({ topic: "hook.reflect", id: "41" }));
  });

  it("id가 숫자여도 문자열과 같은 키다", () => {
    assert.equal(idempotencyKey({ topic: "a.b", id: 41 }), idempotencyKey({ topic: "a.b", id: "41" }));
  });
});
