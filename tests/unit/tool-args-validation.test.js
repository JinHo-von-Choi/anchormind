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

const { validateToolArgs, applyTrustedToolContext } = await import("../../lib/jsonrpc.js");
const { default: logger }       = await import("../../lib/logger.js");
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

describe("validateToolArgs warn 로그의 호출자 표기", () => {
  const KEY_ID     = "550e8400-e29b-41d4-a716-446655440000";
  const SESSION_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const SECRET     = `mmcp_owner_${"c".repeat(32)}`;

  const session = (userAgent) => ({
    authenticated: true, keyId: KEY_ID, groupKeyIds: null, permissions: ["read", "write"],
    defaultWorkspace: null, mode: null, sessionId: SESSION_ID, isMaster: false,
    clientIp: "203.0.113.9", userAgent
  });

  function captureWarn(userAgent) {
    process.env.MEMENTO_TOOL_ARGS_VALIDATION = "warn";
    const lines = [];
    const spy   = mock.method(logger, "warn", (...a) => { lines.push(String(a[0])); return logger; });
    try {
      const args = applyTrustedToolContext({ name: "remember", arguments: { topic: "t", type: "nope", content: "x" } }, session(userAgent));
      assert.doesNotThrow(() => validateToolArgs("remember", args));
    } finally {
      spy.mock.restore();
    }
    return lines.filter((l) => l.startsWith("[ToolArgs]"));
  }

  it("키 참조, 세션 앞 8자, User-Agent를 붙인다", () => {
    const [line] = captureWarn("agent-x/1.2");
    assert.ok(line);
    assert.match(line, /^\[ToolArgs\] remember: type: .*\(key=550e8400-e29b-41d4-a716-446655440000 sid=0f8fad5b\.\.\. ua=agent-x\/1\.2\)$/);
  });

  it("세션 ID 전체와 키 원문은 나타나지 않는다", () => {
    const [line] = captureWarn(`agent ${SECRET}`);
    assert.ok(!line.includes(SESSION_ID));
    assert.ok(!line.includes(SESSION_ID.slice(0, 13)));
    assert.ok(!line.includes(SECRET));
  });

  it("User-Agent의 제어 문자는 제거되고 64자로 잘린다", () => {
    const [line] = captureWarn(`a\r\nb\u0000c\u001b[31md\u2028e${"z".repeat(100)}`);
    const ua     = line.match(/ua=(.*)\)$/)[1];
    assert.equal(ua.length, 64);
    assert.doesNotMatch(ua, /[\p{Cc}\u2028\u2029]/u);
    assert.ok(ua.startsWith("abc[31mde"));
    assert.ok(!line.includes("\n"));
  });

  it("키 형태 토큰은 제어 문자로 쪼개거나 다른 문자에 붙여도 가려진다", () => {
    const hex = "c".repeat(32);
    for (const ua of [`mm\u0001cp_owner_${hex}`, `xmmcp_owner_${hex}`, `a\u200bmmcp_owner_${hex}`, `mmcp\u202e_owner_${hex}`]) {
      const [line] = captureWarn(ua);
      assert.ok(!line.includes(hex), JSON.stringify(ua));
      assert.match(line, /ua=.*mmcp_\*\*\*\*/, JSON.stringify(ua));
    }
  });

  it("방향 지정 문자 등 서식 문자는 제거된다", () => {
    const [line] = captureWarn("agent\u202eevil\u2066x\u200b");
    assert.match(line, /ua=agentevilx\)$/);
  });

  it("User-Agent가 비어 있으면 unknown이다", () => {
    const [line] = captureWarn("\r\n");
    assert.match(line, /ua=unknown\)$/);
  });

  it("호출 문맥이 없는 직접 호출도 던지지 않고 기본 표기를 쓴다", () => {
    process.env.MEMENTO_TOOL_ARGS_VALIDATION = "warn";
    const lines = [];
    const spy   = mock.method(logger, "warn", (...a) => { lines.push(String(a[0])); return logger; });
    try {
      assert.doesNotThrow(() => validateToolArgs("remember", { topic: "t", type: "nope", content: "x" }));
    } finally {
      spy.mock.restore();
    }
    assert.match(lines.find((l) => l.startsWith("[ToolArgs]")), /\(key=none sid=none ua=unknown\)$/);
  });

  it("enforce의 오류 메시지는 호출자 표기를 포함하지 않는다", () => {
    process.env.MEMENTO_TOOL_ARGS_VALIDATION = "enforce";
    const args = applyTrustedToolContext({ name: "remember", arguments: { topic: "t", type: "nope", content: "x" } }, session("agent-x"));
    assert.throws(() => validateToolArgs("remember", args), (e) => e.code === -32602 && !/key=|sid=|ua=/.test(e.message));
  });
});
