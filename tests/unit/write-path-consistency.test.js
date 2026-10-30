/**
 * 쓰기·정리 경로의 일관성: 재시도 기록의 에이전트 범위, 삭제 순서, 에이전트 전체 삭제의 연쇄, 대체 관계 후보의
 * 일괄 조회, 세션 종료 요청의 인증 순서를 검증한다.
 */
import { after, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

const queries = [];
let rowsFor = () => [];
const capture = async (sql, params) => {
  queries.push({ sql, params });
  const rows = rowsFor(sql) ?? [];
  return { rows, rowCount: rows.length };
};

mock.module("../../lib/tools/db.js", {
  exports: {
    getPrimaryPool       : () => ({ query: capture }),
    queryWithAgentVector : async (_agentId, sql, params) => capture(sql, params),
    withTransaction      : async (_pool, fn) => fn({ query: capture })
  }
});

const { findRecordedResponse, recordResponse, claimIdempotencyKey } = await import("../../lib/memory/write/IdempotencyStore.js");
const { FragmentWriter }        = await import("../../lib/memory/write/FragmentWriter.js");
const { ContradictionDetector, SUPERSESSION_LOOKUP_BATCH } = await import("../../lib/memory/link/ContradictionDetector.js");

beforeEach(() => {
  queries.length = 0;
  rowsFor = () => [];
});

describe("재시도 기록의 에이전트 범위", () => {
  it("조회는 agent_id를 함께 본다", async () => {
    await findRecordedResponse("amend", "k1", "key-a", "agent-b");
    const { sql, params } = queries.at(-1);
    assert.match(sql, /agent_id = \$4/);
    assert.deepEqual(params.slice(1), ["amend", "k1", "agent-b"]);
  });

  it("기록과 선점은 agent_id를 포함한 유일 범위로 충돌을 판정한다", async () => {
    await recordResponse("amend", "k1", { ok: true }, "key-a", "agent-b");
    assert.match(queries.at(-1).sql, /ON CONFLICT \(scope_key, agent_id, tool, idempotency_key\)/);
    await claimIdempotencyKey({ tool: "hook", idempotencyKey: "k2", keyId: null, token: "t", staleAfterMs: 1000, ttlDays: 1 });
    assert.match(queries[1].sql, /ON CONFLICT \(scope_key, agent_id, tool, idempotency_key\)/);
  });

  it("migration-071이 새 유일 색인을 만들고 이전 색인을 지운다", () => {
    const sql = readFileSync(new URL("../../lib/memory/migrations/migration-071-idempotency-agent-scope.sql", import.meta.url), "utf8");
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_idem_scope_agent_tool_key\s+ON agent_memory\.idempotency_records \(scope_key, agent_id, tool, idempotency_key\)/);
    assert.match(sql, /DROP INDEX IF EXISTS agent_memory\.idx_idem_scope_tool_key/);
  });
});

describe("삭제 순서", () => {
  it("단건 삭제는 파편을 먼저 지우고, 지웠을 때만 링크·참조를 정리한다", async () => {
    rowsFor = (sql) => (/^DELETE FROM \S+\.fragments WHERE id = \$1/.test(sql.trim()) ? [{ id: "f1" }] : []);
    await new FragmentWriter().delete("f1", "agent-a", null);
    const order = queries.map(q => q.sql.trim().split(/\s+/).slice(0, 3).join(" "));
    const deleteAt = order.findIndex(s => s.startsWith("DELETE FROM") && /fragments/.test(s));
    const unlinkAt = order.findIndex(s => /fragment_links/.test(s));
    assert.ok(deleteAt >= 0 && unlinkAt > deleteAt, order.join(" | "));
  });

  it("지운 행이 없으면 링크를 건드리지 않는다", async () => {
    await new FragmentWriter().delete("missing", "agent-a", null);
    assert.ok(!queries.some(q => /fragment_links/.test(q.sql)));
  });

  it("에이전트 전체 삭제는 forget과 같은 삭제 연쇄를 쓴다", async () => {
    rowsFor = (sql) => (/SELECT id FROM \S+\.fragments WHERE agent_id = \$1/.test(sql) ? [{ id: "f1" }, { id: "f2" }] : []);
    const writer = new FragmentWriter();
    const calls  = [];
    writer.deleteWithCascade = async (ids, agentId, keyId) => { calls.push({ ids, agentId, keyId }); return { deleted: ids.length }; };
    assert.equal(await writer.deleteByAgent("bench-agent"), 2);
    assert.deepEqual(calls, [{ ids: ["f1", "f2"], agentId: "bench-agent", keyId: null }]);
  });
});

describe("대체 관계 후보 조회", () => {
  it("파편마다 따로 묻지 않고 묶음마다 한 번 묻는다", async () => {
    const frags = Array.from({ length: SUPERSESSION_LOOKUP_BATCH + 5 }, (_, i) => ({
      id: `f${String(i).padStart(4, "0")}`, embedding: "[0.1,0.2]", topic: "t", type: "fact", key_id: null,
      created_at: new Date(0).toISOString()
    }));
    await new ContradictionDetector({})._collectSupersessionPairs(frags);
    const lookups = queries.filter(q => /CROSS JOIN LATERAL/.test(q.sql));
    assert.equal(lookups.length, 2);
    assert.equal(lookups[0].params[0].length, SUPERSESSION_LOOKUP_BATCH);
  });

  it("유사도 구간 밖 후보는 빼고 파편별로 묶는다", async () => {
    rowsFor = () => [
      { src_id: "a", id: "b", content: "x", stated_at: null, workspace: null, similarity: "0.8" },
      { src_id: "a", id: "c", content: "y", stated_at: null, workspace: null, similarity: "0.95" }
    ];
    const map = await new ContradictionDetector({})._supersessionNeighbors([{ id: "a", embedding: "[1]", topic: "t", type: "fact" }]);
    assert.deepEqual(map.get("a").map(n => n.id), ["b"]);
  });
});

describe("세션 종료 요청", () => {
  it("인증을 세션 조회보다 먼저 한다", () => {
    const src   = readFileSync(new URL("../../lib/handlers/mcp-handler.js", import.meta.url), "utf8");
    const start = src.indexOf("export async function handleMcpDelete");
    const body  = src.slice(start, src.indexOf("\nexport ", start + 10));
    assert.ok(body.indexOf("validateAuthentication(") < body.indexOf("validateStreamableSession("));
  });
});
