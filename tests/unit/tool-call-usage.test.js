/**
 * 키별 도구 호출 수 기록과 조회 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-12
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";

const { recordToolCall, loadKeyUsage } = await import("../../lib/admin/ToolCallUsage.js");

const fakePool = (rows = []) => {
  const calls = [];
  return { calls, pool: { query: async (sql, params) => { calls.push({ sql, params }); return { rows }; } } };
};

describe("recordToolCall", () => {
  it("키와 도구 이름으로 그날 도구 호출 수와 도구별 수를 더한다", async () => {
    const { calls, pool } = fakePool();
    await recordToolCall("k1", "recall", () => pool);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, ["k1", "recall"]);
    assert.match(calls[0].sql, /tool_call_count = api_key_usage\.tool_call_count \+ 1/);
    assert.match(calls[0].sql, /VALUES \(\$1, CURRENT_DATE, 0, 1,/);
  });

  it("마스터 키(키 id 없음)와 빈 도구 이름은 세지 않는다", async () => {
    const { calls, pool } = fakePool();
    await recordToolCall(null, "recall", () => pool);
    await recordToolCall("k1", "", () => pool);
    assert.equal(calls.length, 0);
  });

  it("열이 없거나 질의가 실패해도 예외를 던지지 않는다", async () => {
    const missing = Object.assign(new Error("column does not exist"), { code: "42703" });
    await recordToolCall("k1", "recall", () => ({ query: async () => { throw missing; } }));
    await recordToolCall("k1", "recall", () => ({ query: async () => { throw new Error("down"); } }));
  });
});

describe("loadKeyUsage", () => {
  it("30일 요청 수, 7일·30일 도구 호출 수, 도구별 합계, 마지막 도구 호출일을 낸다", async () => {
    const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const { pool } = fakePool([
      { date: day(20), call_count: 100, tool_call_count: 0, tool_calls: {} },
      { date: day(10), call_count: 50,  tool_call_count: 4, tool_calls: { recall: 3, remember: 1 } },
      { date: day(2),  call_count: 30,  tool_call_count: 6, tool_calls: { recall: 2, context: 4 } },
      { date: day(1),  call_count: 9,   tool_call_count: 0, tool_calls: {} }
    ]);
    const u = await loadKeyUsage("k1", pool);
    assert.equal(u.requests30d, 189);
    assert.equal(u.toolCalls30d, 10);
    assert.equal(u.toolCalls7d, 6);
    assert.deepEqual(u.byTool30d, { recall: 5, remember: 1, context: 4 });
    assert.equal(u.lastToolCallDate, day(2));
    assert.equal(u.daily.length, 4);
  });
});
