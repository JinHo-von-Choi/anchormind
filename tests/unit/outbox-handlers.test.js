/**
 * outbox 처리기 등록부 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 소비자가 topic별 처리기를 등록하는 확장 지점의 계약: topic 형식, 처리기 형식, 중복 등록,
 * 재시도 상한 재정의, 등록 해제, 목록 정렬.
 */

import { describe, it, beforeEach } from "node:test";
import assert                       from "node:assert/strict";

import {
  registerOutboxHandler, getOutboxHandler, listOutboxTopics, isValidTopic,
  OutboxHandlerRegistrationError, _resetOutboxHandlers
} from "../../lib/outbox/OutboxHandlers.js";

const noop = async () => {};

describe("outbox topic 형식", () => {
  it("소문자로 시작하고 점으로 구분한 소문자, 숫자, 밑줄 조각만 받는다", () => {
    for (const ok of ["audit", "audit.write", "hook.session_end", "a1.b2_c3"]) {
      assert.equal(isValidTopic(ok), true, ok);
    }
    for (const bad of ["", "Audit", "1audit", "audit.", ".audit", "audit..write", "audit-write", "audit write", null, 42]) {
      assert.equal(isValidTopic(bad), false, String(bad));
    }
  });

  it("64자를 넘는 topic은 받지 않는다", () => {
    assert.equal(isValidTopic("a".repeat(64)), true);
    assert.equal(isValidTopic("a".repeat(65)), false);
  });
});

describe("outbox 처리기 등록", () => {
  beforeEach(() => _resetOutboxHandlers());

  it("등록한 처리기를 topic으로 찾는다", () => {
    registerOutboxHandler("audit.write", noop);
    const entry = getOutboxHandler("audit.write");
    assert.equal(entry.topic, "audit.write");
    assert.equal(entry.handler, noop);
    assert.equal(entry.maxAttempts, null);
  });

  it("등록하지 않은 topic은 null이다", () => {
    assert.equal(getOutboxHandler("missing.topic"), null);
  });

  it("잘못된 topic은 등록 오류다", () => {
    assert.throws(() => registerOutboxHandler("Bad Topic", noop), (err) =>
      err instanceof OutboxHandlerRegistrationError && err.code === "OUTBOX_INVALID_TOPIC");
  });

  it("함수가 아닌 처리기는 등록 오류다", () => {
    assert.throws(() => registerOutboxHandler("audit.write", "not-a-function"), (err) =>
      err instanceof OutboxHandlerRegistrationError && err.code === "OUTBOX_INVALID_HANDLER");
  });

  it("같은 topic을 두 번 등록하면 오류이고 처음 처리기가 남는다", () => {
    const first = async () => "first";
    registerOutboxHandler("audit.write", first);
    assert.throws(() => registerOutboxHandler("audit.write", noop), (err) =>
      err instanceof OutboxHandlerRegistrationError && err.code === "OUTBOX_DUPLICATE_TOPIC");
    assert.equal(getOutboxHandler("audit.write").handler, first);
  });

  it("maxAttempts는 1 이상 100 이하의 정수만 받는다", () => {
    registerOutboxHandler("webhook.deliver", noop, { maxAttempts: 30 });
    assert.equal(getOutboxHandler("webhook.deliver").maxAttempts, 30);
    for (const bad of [0, 101, 2.5, "3", -1]) {
      assert.throws(() => registerOutboxHandler(`t.bad${String(bad).replace(/[^0-9]/g, "")}x`, noop, { maxAttempts: bad }), (err) =>
        err instanceof OutboxHandlerRegistrationError && err.code === "OUTBOX_INVALID_MAX_ATTEMPTS", String(bad));
    }
  });

  it("해제 함수를 부르면 topic이 목록에서 빠진다", () => {
    const unregister = registerOutboxHandler("audit.write", noop);
    unregister();
    assert.equal(getOutboxHandler("audit.write"), null);
    assert.deepEqual(listOutboxTopics(), []);
  });

  it("해제 함수는 같은 topic에 나중에 등록한 처리기를 지우지 않는다", () => {
    const unregister = registerOutboxHandler("audit.write", noop);
    unregister();
    const second = async () => {};
    registerOutboxHandler("audit.write", second);
    unregister();
    assert.equal(getOutboxHandler("audit.write").handler, second);
  });

  it("목록은 이름순이다", () => {
    registerOutboxHandler("hook.reflect", noop);
    registerOutboxHandler("audit.write", noop);
    assert.deepEqual(listOutboxTopics(), ["audit.write", "hook.reflect"]);
  });
});

describe("같은 topic의 두 번째 등록(onDuplicate)", () => {
  beforeEach(() => _resetOutboxHandlers());

  it("onDuplicate가 replace이면 새 처리기로 바꾸고, 해제하면 앞 처리기로 돌아간다", () => {
    const first  = async () => "first";
    const second = async () => "second";
    registerOutboxHandler("audit.write", first, { maxAttempts: 3 });
    const off = registerOutboxHandler("audit.write", second, { onDuplicate: "replace" });
    assert.equal(getOutboxHandler("audit.write").handler, second);
    assert.equal(getOutboxHandler("audit.write").maxAttempts, null);
    off();
    assert.equal(getOutboxHandler("audit.write").handler, first);
    assert.equal(getOutboxHandler("audit.write").maxAttempts, 3);
  });

  it("onDuplicate가 chain이면 앞 처리기 다음에 새 처리기를 같은 이벤트로 부른다", async () => {
    const calls = [];
    registerOutboxHandler("audit.write", async (e) => { calls.push(["a", e.id]); });
    const off = registerOutboxHandler("audit.write", async (e) => { calls.push(["b", e.id]); }, { onDuplicate: "chain" });
    await getOutboxHandler("audit.write").handler({ id: "7" }, { signal: new AbortController().signal });
    assert.deepEqual(calls, [["a", "7"], ["b", "7"]]);
    off();
    calls.length = 0;
    await getOutboxHandler("audit.write").handler({ id: "8" }, {});
    assert.deepEqual(calls, [["a", "8"]]);
  });

  it("chain에서 앞 처리기가 실패하면 뒤 처리기를 부르지 않고 실패를 전한다", async () => {
    let second = 0;
    registerOutboxHandler("audit.write", async () => { throw new Error("down"); });
    registerOutboxHandler("audit.write", async () => { second++; }, { onDuplicate: "chain" });
    await assert.rejects(getOutboxHandler("audit.write").handler({ id: "1" }, {}), /down/);
    assert.equal(second, 0);
  });

  it("chain의 재시도 상한은 두 등록 중 작은 값이다", () => {
    registerOutboxHandler("audit.write", noop, { maxAttempts: 5 });
    registerOutboxHandler("audit.write", noop, { onDuplicate: "chain", maxAttempts: 9 });
    assert.equal(getOutboxHandler("audit.write").maxAttempts, 5);
  });

  it("처음 등록에 chain이나 replace를 주면 단순 등록이다", () => {
    registerOutboxHandler("audit.write", noop, { onDuplicate: "chain" });
    assert.equal(getOutboxHandler("audit.write").handler, noop);
  });

  it("알 수 없는 onDuplicate 값은 등록 오류다", () => {
    assert.throws(() => registerOutboxHandler("audit.write", noop, { onDuplicate: "merge" }),
      (err) => err instanceof OutboxHandlerRegistrationError && err.code === "OUTBOX_INVALID_ON_DUPLICATE");
  });

  it("기본값(error)은 두 번째 등록을 거부한다", () => {
    registerOutboxHandler("audit.write", noop);
    assert.throws(() => registerOutboxHandler("audit.write", noop),
      (err) => err instanceof OutboxHandlerRegistrationError && err.code === "OUTBOX_DUPLICATE_TOPIC");
  });
});
