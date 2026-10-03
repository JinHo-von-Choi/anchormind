/**
 * FragmentWriter 접근 기록 갱신: 행 잠금 순서 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
 *
 * incrementAccess(EMA/noEma)와 touchLinked는 대상 행을 id 오름차순으로 먼저 잠그는
 * 문장과 잠근 행만 갱신하는 문장으로 나뉘어야 한다. DB 없이 발행 SQL 문자열의 구조와
 * 원래 조건 보존만 본다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let calls = [];

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => ({ query: async () => ({ rows: [] }) }),
    queryWithAgentVector: async (agentId, sql, params, opts) => {
      calls.push({ agentId, sql, params, lock: opts?.lock });
      return { rows: [], rowCount: 0 };
    }
  }
});
mock.module("../../lib/tools/embedding.js", {
  namedExports: { vectorToSql: value => JSON.stringify(value), computeContentHash: value => value }
});

const { FragmentWriter } = await import("../../lib/memory/write/FragmentWriter.js");

/** 갱신 문장은 잠금 문장이 잠근 행($1)만 갱신한다. 잠금 CTE나 조인 갱신을 쓰지 않는다. */
const LOCKED_ONLY = /^\s*UPDATE agent_memory\.fragments f\b[\s\S]*WHERE f\.id = ANY\(\$1::text\[\]\)\s*$/;

/** 잠금 문장의 골격: 대상 조건 뒤 id 오름차순 FOR NO KEY UPDATE */
const LOCK_STATEMENT = /^SELECT id FROM agent_memory\.fragments WHERE [\s\S]+ ORDER BY id FOR NO KEY UPDATE$/;

/**
 * 호출 하나가 잠금 문장과 잠근 행만 쓰는 갱신 문장으로 나뉘었는지 확인하고 잠금 조건을 돌려준다.
 *
 * @param {{sql: string, lock: {operation: string, sql: string}}} call
 * @param {string} operation
 * @returns {string} 잠금 문장의 WHERE 본문
 */
function lockedWhere(call, operation) {
  assert.match(call.sql, LOCKED_ONLY);
  assert.doesNotMatch(call.sql, /WITH locked|FROM locked/);
  assert.ok(call.lock, "잠금 문장이 없다");
  assert.equal(call.lock.operation, operation);
  assert.match(call.lock.sql, LOCK_STATEMENT);
  return call.lock.sql.match(/WHERE ([\s\S]+) ORDER BY id FOR NO KEY UPDATE$/)[1];
}

beforeEach(() => {
  calls = [];
});

describe("FragmentWriter.incrementAccess 잠금 순서", () => {
  it("noEma 경로는 id 순 잠금 후 갱신하고 원래 조건과 SET을 유지한다", async () => {
    const writer = new FragmentWriter();
    await writer.incrementAccess(["b", "a"], "agent-a", { noEma: true });

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.agentId, "agent-a");
    assert.equal(lockedWhere(call, "access"), "id = ANY($1)");
    assert.deepEqual(call.lock.params, [["b", "a"]]);
    assert.match(call.sql, /SET access_count = f\.access_count \+ 1,\s+accessed_at\s+= NOW\(\)/);
    assert.doesNotMatch(call.sql, /ema_activation/);
    assert.deepEqual(call.params, []);
  });

  it("EMA 경로는 id 순 잠금 후 갱신하고 EMA 식과 파라미터를 유지한다", async () => {
    const writer = new FragmentWriter();
    await writer.incrementAccess(["b", "a"], "agent-a");

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(lockedWhere(call, "access"), "id = ANY($1)");
    assert.deepEqual(call.lock.params, [["b", "a"]]);
    assert.match(call.sql, /access_count\s+= f\.access_count \+ 1/);
    assert.match(call.sql, /ema_activation\s+= \$2 \* POWER\(/);
    assert.match(call.sql, /COALESCE\(f\.ema_last_updated, f\.created_at - INTERVAL '1 day'\)/);
    assert.match(call.sql, /\(1 - \$2\) \* COALESCE\(f\.ema_activation, 0\)/);
    assert.match(call.sql, /ema_last_updated\s+= NOW\(\)/);
    assert.deepEqual(call.params, [0.3]);
  });

  it("빈 id 배열은 질의를 발행하지 않는다", async () => {
    const writer = new FragmentWriter();
    await writer.incrementAccess([], "agent-a");
    assert.equal(calls.length, 0);
  });
});

describe("FragmentWriter.touchLinked 잠금 순서", () => {
  it("co_retrieved 대상 선정 조건 전체를 잠금 문장 안에 유지한다", async () => {
    const writer = new FragmentWriter();
    await writer.touchLinked(["a", "b"], "agent-a", "key-a", { workspace: "ws-a" });

    assert.equal(calls.length, 1);
    const [call] = calls;
    const body   = lockedWhere(call, "touch_linked");
    assert.match(body, /fl\.relation_type = 'co_retrieved'/);
    assert.match(body, /fl\.from_id = ANY\(\$1::text\[\]\) OR fl\.to_id = ANY\(\$1::text\[\]\)/);
    assert.match(body, /AND id != ALL\(\$1::text\[\]\)/);
    assert.match(body, /key_id/);
    assert.match(body, /workspace/);
    assert.match(call.sql, /SET accessed_at = NOW\(\)/);
    assert.deepEqual(call.params, []);
    const lockParams = call.lock.params;
    assert.deepEqual(lockParams[0], ["a", "b"]);
    assert.ok(lockParams.flat().includes("key-a"));
    assert.ok(lockParams.includes("ws-a"));
  });

  it("빈 입력은 질의를 발행하지 않는다", async () => {
    const writer = new FragmentWriter();
    await writer.touchLinked([], "agent-a", "key-a");
    assert.equal(calls.length, 0);
  });
});
