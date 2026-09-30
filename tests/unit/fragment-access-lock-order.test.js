/**
 * FragmentWriter 접근 기록 갱신: 행 잠금 순서 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
 *
 * incrementAccess(EMA/noEma)와 touchLinked는 대상 행을 id 오름차순으로 먼저
 * 잠근 뒤 갱신해야 한다. DB 없이 발행 SQL 문자열의 구조와 원래 조건 보존만 본다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let calls = [];

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => ({ query: async () => ({ rows: [] }) }),
    queryWithAgentVector: async (agentId, sql, params) => {
      calls.push({ agentId, sql, params });
      return { rows: [], rowCount: 0 };
    }
  }
});
mock.module("../../lib/tools/embedding.js", {
  namedExports: { vectorToSql: value => JSON.stringify(value), computeContentHash: value => value }
});

const { FragmentWriter } = await import("../../lib/memory/write/FragmentWriter.js");

/** 잠금 CTE가 UPDATE보다 앞서고 id 순 잠금과 조인 갱신으로 이어지는 골격 */
const LOCK_FIRST = /^\s*WITH locked AS \([\s\S]*?ORDER BY id\s+FOR NO KEY UPDATE\s*\)\s*UPDATE agent_memory\.fragments f\b[\s\S]*FROM locked\s+WHERE f\.id = locked\.id\s*$/;

/** CTE 본문(잠금 대상 선정 SELECT)만 추출 */
function lockedBody(sql) {
  const m = sql.match(/WITH locked AS \(([\s\S]*?)\)\s*UPDATE agent_memory\.fragments f/);
  assert.ok(m, "잠금 CTE가 없다");
  return m[1];
}

beforeEach(() => {
  calls = [];
});

describe("FragmentWriter.incrementAccess 잠금 순서", () => {
  it("noEma 경로는 id 순 잠금 후 갱신하고 원래 조건과 SET을 유지한다", async () => {
    const writer = new FragmentWriter();
    await writer.incrementAccess(["b", "a"], "agent-a", { noEma: true });

    assert.equal(calls.length, 1);
    const { sql, params, agentId } = calls[0];
    assert.equal(agentId, "agent-a");
    assert.match(sql, LOCK_FIRST);
    assert.match(lockedBody(sql), /WHERE id = ANY\(\$1\)\s+ORDER BY id\s+FOR NO KEY UPDATE/);
    assert.match(sql, /SET access_count = f\.access_count \+ 1,\s+accessed_at\s+= NOW\(\)/);
    assert.doesNotMatch(sql, /ema_activation/);
    assert.deepEqual(params, [["b", "a"]]);
  });

  it("EMA 경로는 id 순 잠금 후 갱신하고 EMA 식과 파라미터를 유지한다", async () => {
    const writer = new FragmentWriter();
    await writer.incrementAccess(["b", "a"], "agent-a");

    assert.equal(calls.length, 1);
    const { sql, params } = calls[0];
    assert.match(sql, LOCK_FIRST);
    assert.match(lockedBody(sql), /WHERE id = ANY\(\$1\)\s+ORDER BY id\s+FOR NO KEY UPDATE/);
    assert.match(sql, /access_count\s+= f\.access_count \+ 1/);
    assert.match(sql, /ema_activation\s+= \$2 \* POWER\(/);
    assert.match(sql, /COALESCE\(f\.ema_last_updated, f\.created_at - INTERVAL '1 day'\)/);
    assert.match(sql, /\(1 - \$2\) \* COALESCE\(f\.ema_activation, 0\)/);
    assert.match(sql, /ema_last_updated\s+= NOW\(\)/);
    assert.deepEqual(params, [["b", "a"], 0.3]);
  });

  it("빈 id 배열은 질의를 발행하지 않는다", async () => {
    const writer = new FragmentWriter();
    await writer.incrementAccess([], "agent-a");
    assert.equal(calls.length, 0);
  });
});

describe("FragmentWriter.touchLinked 잠금 순서", () => {
  it("co_retrieved 대상 선정 조건 전체를 잠금 CTE 안에 유지한다", async () => {
    const writer = new FragmentWriter();
    await writer.touchLinked(["a", "b"], "agent-a", "key-a", { workspace: "ws-a" });

    assert.equal(calls.length, 1);
    const { sql, params } = calls[0];
    assert.match(sql, LOCK_FIRST);
    const body = lockedBody(sql);
    assert.match(body, /fl\.relation_type = 'co_retrieved'/);
    assert.match(body, /fl\.from_id = ANY\(\$1::text\[\]\) OR fl\.to_id = ANY\(\$1::text\[\]\)/);
    assert.match(body, /AND id != ALL\(\$1::text\[\]\)/);
    assert.match(body, /key_id/);
    assert.match(body, /workspace/);
    assert.match(body, /ORDER BY id\s+FOR NO KEY UPDATE\s*$/);
    assert.match(sql, /SET accessed_at = NOW\(\)/);
    assert.deepEqual(params[0], ["a", "b"]);
    assert.ok(params.flat().includes("key-a"));
    assert.ok(params.includes("ws-a"));
  });

  it("빈 입력은 질의를 발행하지 않는다", async () => {
    const writer = new FragmentWriter();
    await writer.touchLinked([], "agent-a", "key-a");
    assert.equal(calls.length, 0);
  });
});
