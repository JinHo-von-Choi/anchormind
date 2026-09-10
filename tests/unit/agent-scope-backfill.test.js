import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  backfillAgentScopeSnapshots,
  assertBackfillComplete,
  getAgentScopeBackfillStatus,
  getPendingScopeSnapshotCounts,
  hasAgentScopeSnapshotSchema,
  warnPendingAgentScopeSnapshots
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
    const versionCounts = [2, 1, 1, 0];
    const eventCounts = [2, 0];
    const pool = { query: async sql => {
      if (/information_schema/.test(sql)) return { rows: schemaRows() };
      if (/SELECT COUNT/.test(sql)) return { rows: [{ pending: 0, backfillable: 0 }] };
      if (/UPDATE agent_memory\.fragment_versions/.test(sql)) {
        return { rowCount: versionCounts.shift() };
      }
      if (/UPDATE agent_memory\.case_events/.test(sql)) {
        return { rowCount: eventCounts.shift() };
      }
      throw new Error(`unexpected query: ${sql}`);
    } };
    const result = await backfillAgentScopeSnapshots({ batchSize: 2 }, pool);
    assert.deepEqual(result, { fragmentVersions: 4, caseEvents: 2 });
    assert.deepEqual(versionCounts, []);
    assert.deepEqual(eventCounts, []);
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

  it("계속 가득 차는 version 배치를 제한하고 커밋된 진행 이후 재개한다", async () => {
    let pending = 4;
    let concurrentWriter = true;
    let updateCalls = 0;
    const pool = { query: async sql => {
      if (/information_schema/.test(sql)) return { rows: schemaRows() };
      if (/SELECT COUNT/.test(sql)) return { rows: [{ pending: 0, backfillable: 0 }] };
      updateCalls++;
      if (/UPDATE agent_memory\.fragment_versions/.test(sql)) {
        const updated = Math.min(pending, 2);
        pending -= updated;
        if (concurrentWriter) pending += 2;
        return { rowCount: updated };
      }
      return { rowCount: 0 };
    } };

    await assert.rejects(
      backfillAgentScopeSnapshots({ batchSize: 2, maxBatches: 3 }, pool),
      error => {
        assert.equal(error.code, "SNAPSHOT_BACKFILL_LIMIT");
        assert.deepEqual(error.progress, { fragmentVersions: 6, caseEvents: 0, batches: 3 });
        assert.match(error.message, /committed progress: versions=6, events=0; rerun to resume/);
        return true;
      }
    );
    assert.equal(updateCalls, 3);
    assert.equal(pending, 4);
    concurrentWriter = false;
    assert.deepEqual(await backfillAgentScopeSnapshots({ batchSize: 2 }, pool), {
      fragmentVersions: 4, caseEvents: 0
    });
    assert.equal(pending, 0);
  });

  it("case event가 계속 유입되어도 두 테이블을 합친 배치 상한을 지킨다", async () => {
    let updateCalls = 0;
    const pool = { query: async sql => {
      if (/information_schema/.test(sql)) return { rows: schemaRows() };
      updateCalls++;
      return { rowCount: /UPDATE agent_memory\.case_events/.test(sql) ? 2 : 0 };
    } };
    await assert.rejects(
      backfillAgentScopeSnapshots({ batchSize: 2, maxBatches: 3 }, pool),
      error => {
        assert.deepEqual(error.progress, { fragmentVersions: 0, caseEvents: 4, batches: 3 });
        return true;
      }
    );
    assert.equal(updateCalls, 3);
  });

  it("마지막 허용 배치에서 완료하면 정상 반환한다", async () => {
    const counts = [2, 0, 1, 0];
    const pool = { query: async sql => {
      if (/information_schema/.test(sql)) return { rows: schemaRows() };
      if (/SELECT COUNT/.test(sql)) return { rows: [{ pending: 0, backfillable: 0 }] };
      return { rowCount: counts.shift() };
    } };
    assert.deepEqual(
      await backfillAgentScopeSnapshots({ batchSize: 2, maxBatches: 4 }, pool),
      { fragmentVersions: 2, caseEvents: 1 }
    );
    assert.deepEqual(counts, []);
  });

  it("유한한 양의 정수가 아닌 배치 상한은 DB 접근 전에 거부한다", async () => {
    const pool = { query: () => assert.fail("unexpected database access") };
    for (const maxBatches of [0, -1, 1.5, Infinity, NaN, "3", true, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(
        backfillAgentScopeSnapshots({ maxBatches }, pool), /maxBatches must be a positive safe integer/
      );
    }
  });

  it("backfill 뒤 신뢰 가능한 잔여 행이 있으면 성공 처리하지 않는다", () => {
    assert.doesNotThrow(() => assertBackfillComplete({
      fragmentVersions: { backfillable: 0 }, caseEvents: { backfillable: 0 }
    }));
    assert.throws(() => assertBackfillComplete({
      fragmentVersions: { backfillable: 1 }, caseEvents: { backfillable: 2 }
    }), /left 3 backfillable row/);
  });

  it("잠긴 행으로 zero batch가 나와도 직접 호출자는 미완료 상태를 받는다", async () => {
    const pool = { query: async sql => {
      if (/information_schema/.test(sql)) return { rows: schemaRows() };
      if (/SELECT COUNT/.test(sql)) return { rows: [{ pending: 1, backfillable: 1 }] };
      assert.match(sql, /SKIP LOCKED/);
      return { rowCount: 0 };
    } };
    await assert.rejects(backfillAgentScopeSnapshots({}, pool), error => {
      assert.equal(error.code, "SNAPSHOT_BACKFILL_INCOMPLETE");
      assert.equal(error.status.fragmentVersions.pending, 1);
      assert.deepEqual(error.progress, { fragmentVersions: 0, caseEvents: 0, batches: 2 });
      return true;
    });
  });

  it("복구할 source가 없는 snapshot은 구조화된 미완료 보고로 남긴다", () => {
    const status = { migrationReady: true,
      fragmentVersions: { pending: 0, backfillable: 0 },
      caseEvents: { pending: 3, backfillable: 0, sourceMissing: 2, sourceDeleted: 1 } };
    assert.throws(() => assertBackfillComplete(status), error => {
      assert.equal(error.code, "SNAPSHOT_BACKFILL_INCOMPLETE");
      assert.equal(error.status, status);
      assert.match(error.message, /sourceMissing=2, sourceDeleted=1/);
      return true;
    });
  });

  it("migration 후 두 테이블의 pending 집계만 경고하고 데이터를 변경하지 않는다", async () => {
    for (const table of ["fragment_versions", "case_events"]) {
      const warnings = [];
      const pool = { query: async sql => {
        assert.match(sql.trim(), /^SELECT/);
        if (/information_schema/.test(sql)) return { rows: schemaRows() };
        return { rows: [{ pending: sql.includes(table) ? 2 : 0, backfillable: 0 }] };
      } };
      await warnPendingAgentScopeSnapshots(pool, text => warnings.push(text));
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /anchor-scope --backfill-snapshots/);
    }
    const warnings = [];
    await warnPendingAgentScopeSnapshots({ query: async () => ({ rows: [] }) },
      text => warnings.push(text));
    assert.deepEqual(warnings, []);
  });
});
