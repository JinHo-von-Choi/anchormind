import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  backfillAgentScopeSnapshots,
  assertBackfillComplete,
  getAgentScopeBackfillStatus,
  getPendingScopeSnapshotCounts,
  hasAgentScopeSnapshotSchema
} from "../../lib/memory/admin/AgentScopeBackfill.js";

function schemaRows() {
  return [
    { table_name: "fragment_versions", column_name: "agent_id" },
    { table_name: "fragment_versions", column_name: "workspace" },
    { table_name: "case_events", column_name: "agent_id" },
    { table_name: "case_events", column_name: "workspace" }
  ];
}

describe("agent scope snapshot backfill", () => {
  it("migration schema 네 컬럼을 모두 확인한다", async () => {
    const complete = { query: async () => ({ rows: schemaRows() }) };
    const partial = { query: async () => ({ rows: schemaRows().slice(0, 3) }) };
    assert.equal(await hasAgentScopeSnapshotSchema(complete), true);
    assert.equal(await hasAgentScopeSnapshotSchema(partial), false);
  });

  it("source 없는 이벤트와 삭제된 source 이벤트를 별도 COUNT로 노출한다", async () => {
    let call = 0;
    const pool = { query: async sql => {
      call++;
      if (call === 1) return { rows: schemaRows() };
      if (/fragment_versions/.test(sql)) return { rows: [{ pending: 8, backfillable: 8 }] };
      return { rows: [{ pending: 7, backfillable: 3, sourceMissing: 2, sourceDeleted: 2 }] };
    } };
    const status = await getAgentScopeBackfillStatus(pool);
    assert.deepEqual(status.caseEvents, {
      pending: 7, backfillable: 3, sourceMissing: 2, sourceDeleted: 2
    });
  });

  it("신뢰 가능한 source가 있는 행만 짧은 배치로 반복 갱신한다", async () => {
    const versionCounts = [2, 1];
    const eventCounts = [2, 0];
    const pool = { query: async sql => {
      if (/information_schema/.test(sql)) return { rows: schemaRows() };
      if (/UPDATE agent_memory\.fragment_versions/.test(sql)) {
        return { rowCount: versionCounts.shift() };
      }
      if (/UPDATE agent_memory\.case_events/.test(sql)) {
        return { rowCount: eventCounts.shift() };
      }
      throw new Error(`unexpected query: ${sql}`);
    } };
    const result = await backfillAgentScopeSnapshots({ batchSize: 2 }, pool);
    assert.deepEqual(result, { fragmentVersions: 3, caseEvents: 2 });
  });

  it("정규화 대상의 pending version/event snapshot을 모두 검사한다", async () => {
    let call = 0;
    const pool = { query: async (_sql, params) => {
      call++;
      if (call === 1) return { rows: schemaRows() };
      assert.deepEqual(params, [["fragment-a", "fragment-b"]]);
      return { rows: [{ fragmentVersions: 2, caseEvents: 3 }] };
    } };
    assert.deepEqual(
      await getPendingScopeSnapshotCounts(["fragment-a", "fragment-b"], pool),
      { fragmentVersions: 2, caseEvents: 3, total: 5 }
    );
  });

  it("backfill 뒤 신뢰 가능한 잔여 행이 있으면 성공 처리하지 않는다", () => {
    assert.doesNotThrow(() => assertBackfillComplete({
      fragmentVersions: { backfillable: 0 }, caseEvents: { backfillable: 0 }
    }));
    assert.throws(() => assertBackfillComplete({
      fragmentVersions: { backfillable: 1 }, caseEvents: { backfillable: 2 }
    }), /left 3 backfillable row/);
  });
});
