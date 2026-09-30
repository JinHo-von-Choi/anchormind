/**
 * 도구 인자 점검(validateToolArgs)과 hard gate 조회 실패 처리 시험.
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
 */

import { describe, it, mock, afterEach } from "node:test";
import assert                            from "node:assert/strict";

const mockQuery = mock.fn(async () => ({ rows: [] }));
const mockPool  = { query: mockQuery };

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool      : () => mockPool,
    getBatchPool        : () => mockPool,
    queryWithAgentVector: async () => ({ rows: [] }),
    withTransaction     : async (pool, fn) => fn(mockPool),
    getPoolStats        : () => ({})
  }
});

const { validateToolArgs }      = await import("../../lib/jsonrpc.js");
const { getSymbolicHardGate }   = await import("../../lib/admin/ApiKeyStore.js");

const SAVED_MODE          = process.env.MEMENTO_TOOL_ARGS_VALIDATION;
const SAVED_ALLOW_UNKNOWN = process.env.MEMENTO_TOOL_ARGS_ALLOW_UNKNOWN;

function restore(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  restore("MEMENTO_TOOL_ARGS_VALIDATION", SAVED_MODE);
  restore("MEMENTO_TOOL_ARGS_ALLOW_UNKNOWN", SAVED_ALLOW_UNKNOWN);
});

describe("validateToolArgs (enforce)", () => {
  it("스키마에 없는 enum 값을 거부한다", () => {
    process.env.MEMENTO_TOOL_ARGS_VALIDATION = "enforce";
    assert.throws(
      () => validateToolArgs("remember", { content: "x", topic: "t", type: "nope" }),
      (e) => e.code === -32602
    );
  });

  it("필수 필드 누락을 거부한다", () => {
    process.env.MEMENTO_TOOL_ARGS_VALIDATION = "enforce";
    assert.throws(
      () => validateToolArgs("remember", { topic: "t", type: "fact" }),
      (e) => e.code === -32602
    );
  });

  it("스키마에 없는 필드를 거부한다", () => {
    process.env.MEMENTO_TOOL_ARGS_VALIDATION = "enforce";
    assert.throws(
      () => validateToolArgs("recall", { query: "x" }),
      (e) => e.code === -32602 && /unknown field/.test(e.message)
    );
  });

  it("MEMENTO_TOOL_ARGS_ALLOW_UNKNOWN=true 이면 알 수 없는 필드를 허용한다", () => {
    process.env.MEMENTO_TOOL_ARGS_VALIDATION     = "enforce";
    process.env.MEMENTO_TOOL_ARGS_ALLOW_UNKNOWN  = "true";
    assert.doesNotThrow(() => validateToolArgs("recall", { keywords: ["a"], query: "x" }));
  });

  it("유효한 호출은 통과한다", () => {
    process.env.MEMENTO_TOOL_ARGS_VALIDATION = "enforce";
    assert.doesNotThrow(() => validateToolArgs("remember", { content: "x", topic: "t", type: "fact" }));
  });

  it("서버가 주입하는 밑줄 접두 필드는 검사하지 않는다", () => {
    process.env.MEMENTO_TOOL_ARGS_VALIDATION = "enforce";
    assert.doesNotThrow(() => validateToolArgs("remember", { content: "x", topic: "t", type: "fact", _keyId: "k", _isMaster: true }));
  });

  it("스키마가 없는 도구는 통과한다", () => {
    process.env.MEMENTO_TOOL_ARGS_VALIDATION = "enforce";
    assert.doesNotThrow(() => validateToolArgs("no_such_tool", { anything: 1 }));
  });
});

describe("validateToolArgs (warn, off)", () => {
  it("모드를 지정하지 않으면 warn 으로 동작해 던지지 않는다", () => {
    delete process.env.MEMENTO_TOOL_ARGS_VALIDATION;
    assert.doesNotThrow(() => validateToolArgs("remember", { content: "x", topic: "t", type: "nope" }));
  });

  it("warn 모드는 던지지 않는다", () => {
    process.env.MEMENTO_TOOL_ARGS_VALIDATION = "warn";
    assert.doesNotThrow(() => validateToolArgs("remember", { content: "x", topic: "t", type: "nope" }));
  });

  it("off 모드는 던지지 않는다", () => {
    process.env.MEMENTO_TOOL_ARGS_VALIDATION = "off";
    assert.doesNotThrow(() => validateToolArgs("remember", { topic: "t" }));
  });

  it("모드는 호출 시점의 환경변수로 정해진다", () => {
    process.env.MEMENTO_TOOL_ARGS_VALIDATION = "warn";
    assert.doesNotThrow(() => validateToolArgs("remember", { topic: "t" }));
    process.env.MEMENTO_TOOL_ARGS_VALIDATION = "enforce";
    assert.throws(() => validateToolArgs("remember", { topic: "t" }), (e) => e.code === -32602);
  });
});

describe("getSymbolicHardGate", () => {
  it("조회가 실패하면 false 로 바꾸지 않고 예외를 전파한다", async () => {
    mockQuery.mock.mockImplementationOnce(async () => { throw new Error("connection refused"); });
    await assert.rejects(() => getSymbolicHardGate("key-gate-fail"), /connection refused/);
  });

  it("행이 없으면 false 를 반환한다", async () => {
    mockQuery.mock.mockImplementationOnce(async () => ({ rows: [] }));
    assert.equal(await getSymbolicHardGate("key-gate-none"), false);
  });

  it("keyId 가 null 이면 false 를 반환한다", async () => {
    assert.equal(await getSymbolicHardGate(null), false);
  });
});
