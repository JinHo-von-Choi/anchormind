/**
 * mcp-handler-batch-json.test.js
 *
 * 작성자: 최진호
 * 작성일: 2026-06-19
 *
 * batch_remember / memory_consolidate 가 커스텀 SSE 경로가 아니라
 * 일반 _dispatchAndRespond(sendJSON) 경로로 처리되는지 검증.
 */
import { test, describe, beforeEach, it, mock } from "node:test";
import assert from "node:assert/strict";

const sendJSONFn        = mock.fn(async () => {});
const dispatchJsonRpcFn = mock.fn(async () => ({ kind: "result", response: { jsonrpc: "2.0", id: 1, result: { ok: true } } }));
const writeSSEEventFn   = mock.fn(() => true);

mock.module("../../lib/http/helpers.js", {
  namedExports: {
    sseWrite       : mock.fn(),
    writeSSEEvent  : writeSSEEventFn,
    initSSEResponse: mock.fn(),
    readRawBody    : mock.fn(async () => Buffer.from("")),
    readJsonBody   : mock.fn(async () => ({})),
    getClientIp    : mock.fn(() => "127.0.0.1"),
    validateOrigin : mock.fn(() => true),
  }
});
mock.module("../../lib/compression.js", {
  namedExports: { sendJSON: sendJSONFn }
});
mock.module("../../lib/jsonrpc.js", {
  namedExports: { dispatchJsonRpc: dispatchJsonRpcFn, jsonRpcError: mock.fn() }
});
mock.module("../../lib/logger.js", {
  namedExports: { logInfo: mock.fn(), logWarn: mock.fn(), logError: mock.fn(), logDebug: mock.fn() }
});

describe("mcp-handler batch_remember routing", () => {
  beforeEach(() => {
    sendJSONFn.mock.resetCalls();
    writeSSEEventFn.mock.resetCalls();
    dispatchJsonRpcFn.mock.resetCalls();
  });

  test("batch_remember 요청은 sendJSON 경로로 가고 writeSSEEvent를 쓰지 않는다", async () => {
    const { handleToolCallForTest } = await import("../../lib/handlers/mcp-handler.js");
    const msg = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "batch_remember", arguments: { fragments: [] } } };
    const req = { method: "POST", headers: { accept: "application/json, text/event-stream" } };
    const res = { setHeader: mock.fn(), end: mock.fn(), statusCode: 200, writable: true, destroyed: false };

    await handleToolCallForTest(req, res, msg, "sess-1", null, null);

    assert.equal(sendJSONFn.mock.callCount(), 1, "표준 JSON 응답 경로 사용");
    assert.equal(writeSSEEventFn.mock.callCount(), 0, "커스텀 SSE 프레임 미사용");
  });
});

describe("JSON parse 오류 message 위치 정보", () => {
  it("SyntaxError 메시지가 -32700 message에 포함된다", async () => {
    const { buildParseErrorMessage } = await import("../../lib/handlers/mcp-handler.js");
    let parseErr = null;
    try {
      JSON.parse('{"fragments":[{"content":"\\ud5cx"}]}');
    } catch (e) {
      parseErr = e;
    }
    assert.ok(parseErr instanceof SyntaxError);

    const message = buildParseErrorMessage(parseErr);
    assert.match(message, /^Parse error: /);
    assert.match(message, /position|Unexpected|Bad/i);
  });
});
