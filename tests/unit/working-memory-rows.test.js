/**
 * 작업 기억 PostgreSQL 행 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 보관 시간 만료(주입한 시계), 보관량 상한에 따른 제거, 세션 사이 격리, 만료 정리를
 * 메모리 DB 대역 위에서 확인하고 순수 함수의 계약을 단언한다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert                             from "node:assert/strict";

import { createFakeWmDb } from "./_wm-fake-db.js";

const dbRef = { fake: createFakeWmDb() };
mock.module("../../lib/tools/db.js", {
  namedExports: { queryWithAgentVector: (...args) => dbRef.fake.queryWithAgentVector(...args) }
});

const {
  WM_FALLBACK_SOURCE, WM_TTL_SECONDS, WM_MAX_TOKENS, WM_MAX_ROWS,
  workingMemoryCutoff, markWorkingMemoryRow, rowToWorkingMemoryItem,
  selectBudgetEvictionIndices, workingMemoryHints, describeWorkingMemoryBackend,
  listWorkingMemoryRows, evictWorkingMemoryRows, clearWorkingMemoryRows,
  enforceWorkingMemoryRowBudget, deleteExpiredWorkingMemoryRows
} = await import("../../lib/memory/WorkingMemoryRows.js");

const T0   = Date.parse("2026-10-03T00:00:00.000Z");
const HOUR = 3600 * 1000;

let seq = 0;
/** 작업 기억 행 하나를 대역 DB에 넣는다. */
function seed({ session = "sess-a", at = T0, tokens = 10, importance = 0.5, key = null, id = null, content = null } = {}) {
  seq += 1;
  const rowId = id ?? `wm-${String(seq).padStart(4, "0")}`;
  const fragment = markWorkingMemoryRow({
    id: rowId, content: content ?? `본문 ${rowId}`, type: "fact", topic: "t", agent_id: "default",
    key_id: key, workspace: null, importance, estimated_tokens: tokens, session_id: session
  }, at);
  fragment.created_at = at;
  return dbRef.fake.insertFragment(fragment);
}

beforeEach(() => { dbRef.fake = createFakeWmDb(); seq = 0; });

describe("보관 시간 만료", () => {
  it("보관 시간은 86400초이고 기준 시각에서 그만큼 앞선 시각이 경계다", () => {
    assert.equal(WM_TTL_SECONDS, 86400);
    assert.equal(workingMemoryCutoff(T0), new Date(T0 - 86400 * 1000).toISOString());
  });

  it("주입한 시계가 보관 시간 안이면 보이고 지나면 보이지 않는다", async () => {
    const id = seed({ at: T0 });
    assert.deepEqual((await listWorkingMemoryRows("sess-a", { now: T0 + 23 * HOUR + 59 * 60 * 1000 })).map(r => r.id), [id]);
    assert.deepEqual(await listWorkingMemoryRows("sess-a", { now: T0 + 24 * HOUR + 1000 }), []);
  });

  it("조회는 만료 경계를 매개변수로 넘기고 행이 남아 있어도 만료 행은 돌려주지 않는다", async () => {
    seed({ at: T0 });
    await listWorkingMemoryRows("sess-a", { now: T0 + 25 * HOUR });
    const { params } = dbRef.fake.calls.at(-1);
    assert.equal(params[2], new Date(T0 + 25 * HOUR - 86400 * 1000).toISOString());
    assert.equal(dbRef.fake.rows.length, 1);
  });

  it("만료 정리는 보관 시간이 지난 작업 기억 행만 모든 세션에서 지운다", async () => {
    seed({ session: "sess-a", at: T0 - 25 * HOUR });
    seed({ session: "sess-b", at: T0 - 30 * HOUR });
    const fresh = seed({ session: "sess-a", at: T0 - HOUR });
    dbRef.fake.rows.push({ id: "perm", session_id: "sess-a", source: "session:abc", valid_to: null, created_at: new Date(T0 - 99 * HOUR), key_id: null });

    const deleted = await deleteExpiredWorkingMemoryRows({ now: T0 });
    assert.equal(deleted, 2);
    assert.deepEqual(dbRef.fake.rows.map(r => r.id).sort(), [fresh, "perm"].sort());
  });
});

describe("보관량 상한", () => {
  it("토큰 합이 상한을 넘으면 오래된 행부터 지우고 상한 이하에서 멈춘다", async () => {
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(seed({ at: T0 + i * 1000, tokens: 100 }));
    const evicted = await enforceWorkingMemoryRowBudget("sess-a", { now: T0 + HOUR });
    assert.equal(evicted, 1);
    const left = await listWorkingMemoryRows("sess-a", { now: T0 + HOUR });
    assert.deepEqual(left.map(r => r.id), ids.slice(1));
    assert.ok(left.reduce((s, r) => s + r.estimated_tokens, 0) <= WM_MAX_TOKENS);
  });

  it("중요도가 높은 행은 토큰 상한 제거에서 보호한다", async () => {
    const keep = seed({ at: T0,        tokens: 250, importance: 0.9 });
    const mid  = seed({ at: T0 + 1000, tokens: 250, importance: 0.5 });
    const last = seed({ at: T0 + 2000, tokens: 250, importance: 0.5 });
    await enforceWorkingMemoryRowBudget("sess-a", { now: T0 + HOUR });
    const ids = (await listWorkingMemoryRows("sess-a", { now: T0 + HOUR })).map(r => r.id);
    assert.ok(ids.includes(keep), "보호 행이 지워졌다");
    assert.ok(!ids.includes(mid), "가장 오래된 비보호 행이 남았다");
    assert.ok(ids.includes(last));
  });

  it("보호 행만 쌓여도 행 수는 상한을 넘지 않고 오래된 행부터 지운다", async () => {
    const total = WM_MAX_ROWS + 5;
    const ids   = [];
    for (let i = 0; i < total; i++) ids.push(seed({ at: T0 + i, tokens: 1, importance: 0.95 }));
    const evicted = await enforceWorkingMemoryRowBudget("sess-a", { now: T0 + HOUR });
    assert.equal(evicted, 5);
    const left = (await listWorkingMemoryRows("sess-a", { now: T0 + HOUR })).map(r => r.id);
    assert.equal(left.length, WM_MAX_ROWS);
    assert.deepEqual(left, ids.slice(5));
  });

  it("상한 안이면 아무것도 지우지 않는다", async () => {
    seed({ tokens: 50 });
    assert.equal(await enforceWorkingMemoryRowBudget("sess-a", { now: T0 + HOUR }), 0);
  });

  it("상한 제거는 한 세션에만 적용된다", async () => {
    for (let i = 0; i < 6; i++) seed({ session: "sess-a", at: T0 + i, tokens: 100 });
    const other = seed({ session: "sess-b", at: T0, tokens: 100 });
    await enforceWorkingMemoryRowBudget("sess-a", { now: T0 + HOUR });
    assert.deepEqual((await listWorkingMemoryRows("sess-b", { now: T0 + HOUR })).map(r => r.id), [other]);
  });
});

describe("세션과 항목 격리", () => {
  it("조회는 요청한 세션의 행만 돌려준다", async () => {
    const a = seed({ session: "sess-a" });
    const b = seed({ session: "sess-b" });
    assert.deepEqual((await listWorkingMemoryRows("sess-a", { now: T0 + HOUR })).map(r => r.id), [a]);
    assert.deepEqual((await listWorkingMemoryRows("sess-b", { now: T0 + HOUR })).map(r => r.id), [b]);
    assert.deepEqual(await listWorkingMemoryRows("sess-none", { now: T0 + HOUR }), []);
  });

  it("같은 본문도 세션마다 별도 행이고 한 세션 안에서는 하나다", async () => {
    const a1 = seed({ session: "sess-a", content: "같은 본문입니다 충분히 깁니다", id: "x1" });
    const a2 = seed({ session: "sess-a", content: "같은 본문입니다 충분히 깁니다", id: "x2" });
    const b1 = seed({ session: "sess-b", content: "같은 본문입니다 충분히 깁니다", id: "x3" });
    assert.equal(a1, a2);
    assert.notEqual(a1, b1);
    assert.equal(dbRef.fake.rows.length, 2);
  });

  it("지정 id 삭제는 다른 세션의 같은 id와 영구 파편을 지우지 않는다", async () => {
    const a = seed({ session: "sess-a", id: "shared-id" });
    seed({ session: "sess-b", id: "other-id" });
    dbRef.fake.rows.push({ id: "perm-id", session_id: "sess-a", source: "x", valid_to: null, created_at: new Date(T0), key_id: null });

    assert.equal(await evictWorkingMemoryRows("sess-b", [a, "perm-id"]), 0);
    assert.equal(await evictWorkingMemoryRows("sess-a", [a, "perm-id"]), 1);
    assert.deepEqual(dbRef.fake.rows.map(r => r.id).sort(), ["other-id", "perm-id"]);
  });

  it("세션 삭제는 그 세션의 작업 기억 행만 지운다", async () => {
    seed({ session: "sess-a" });
    seed({ session: "sess-a" });
    const b = seed({ session: "sess-b" });
    assert.equal(await clearWorkingMemoryRows("sess-a"), 2);
    assert.deepEqual(dbRef.fake.rows.map(r => r.id), [b]);
  });

  it("항목은 key_id와 agent_id를 그대로 실어 호출자가 키 격리를 적용할 수 있다", async () => {
    seed({ session: "sess-a", key: "key-1" });
    seed({ session: "sess-a", key: "key-2" });
    const items = await listWorkingMemoryRows("sess-a", { now: T0 + HOUR });
    assert.deepEqual(items.map(i => i.key_id).sort(), ["key-1", "key-2"]);
    assert.ok(items.every(i => i.agent_id === "default"));
  });

  it("빈 세션 ID는 DB를 부르지 않는다", async () => {
    assert.deepEqual(await listWorkingMemoryRows(""), []);
    assert.equal(await evictWorkingMemoryRows("", ["a"]), 0);
    assert.equal(await clearWorkingMemoryRows(null), 0);
    assert.equal(dbRef.fake.calls.length, 0);
  });
});

describe("순수 함수", () => {
  it("markWorkingMemoryRow는 조회 대상에서 빠진 단기 행으로 바꾸고 같은 객체를 돌려준다", () => {
    const fragment = { id: "f1", content: "c", session_id: "s1", is_anchor: true, idempotency_key: "k", ttl_tier: "warm" };
    const marked   = markWorkingMemoryRow(fragment, T0);
    assert.equal(marked, fragment);
    assert.equal(fragment.source, WM_FALLBACK_SOURCE);
    assert.equal(fragment.ttl_tier, "short");
    assert.equal(fragment.is_anchor, false);
    assert.equal(fragment.idempotency_key, null);
    assert.equal(fragment.valid_to, new Date(T0).toISOString());
    assert.equal(fragment.valid_from, fragment.valid_to);
    assert.equal(fragment.hash_scope, "wm:s1");
  });

  it("rowToWorkingMemoryItem은 Redis 항목과 같은 필드를 만든다", () => {
    const item = rowToWorkingMemoryItem({
      id: "r1", content: "abcd".repeat(10), type: "fact", topic: "t", agent_id: "a", workspace: undefined,
      key_id: undefined, importance: null, estimated_tokens: 0, created_at: new Date(T0)
    });
    assert.deepEqual(Object.keys(item).sort(),
      ["added_at", "agent_id", "content", "estimated_tokens", "id", "importance", "key_id", "topic", "type", "workspace"]);
    assert.equal(item.workspace, null);
    assert.equal(item.key_id, null);
    assert.equal(item.importance, 0.5);
    assert.equal(item.estimated_tokens, 10);
    assert.equal(item.added_at, T0);
  });

  it("selectBudgetEvictionIndices는 토큰 상한과 행 수 상한을 별도로 적용한다", () => {
    const items = [
      { importance: 0.5, estimated_tokens: 200 },
      { importance: 0.9, estimated_tokens: 200 },
      { importance: 0.5, estimated_tokens: 200 }
    ];
    assert.deepEqual([...selectBudgetEvictionIndices(items, { maxTokens: 500 })], [0]);
    assert.deepEqual([...selectBudgetEvictionIndices(items, { maxTokens: 1000, maxRows: 2 })], [0]);
    assert.deepEqual([...selectBudgetEvictionIndices(items, { maxTokens: 1000 })], []);
  });

  it("workingMemoryHints는 대체 경로와 미저장에만 힌트를 만든다", () => {
    assert.deepEqual(workingMemoryHints("redis"), []);
    assert.equal(workingMemoryHints("postgres-fallback")[0].signal, "working_memory_fallback");
    assert.equal(workingMemoryHints("none")[0].signal, "working_memory_unavailable");
  });

  it("describeWorkingMemoryBackend는 설정 조합마다 다른 기동 줄을 만든다", () => {
    const lines = [
      describeWorkingMemoryBackend({ redisEnabled: true,  fallbackEnabled: true  }),
      describeWorkingMemoryBackend({ redisEnabled: true,  fallbackEnabled: false }),
      describeWorkingMemoryBackend({ redisEnabled: false, fallbackEnabled: true  }),
      describeWorkingMemoryBackend({ redisEnabled: false, fallbackEnabled: false })
    ];
    assert.equal(new Set(lines).size, 4);
    assert.ok(lines.every(l => l.startsWith("[Startup] 작업 기억:")));
  });
});
