/**
 * 재개형 백필 도우미 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * queryWithAgentVector 를 상태를 가진 가짜 저장소로 바꿔 watermark 이어하기, 행 단위 오류의
 * 실패 행 기록, 행 단위가 아닌 오류의 전파, 완료 작업의 건너뜀, 실패 행 재시도를 검사한다.
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert                              from "node:assert/strict";

/** 가짜 저장소 상태. 시험마다 reset 한다. */
const db = {
  ids: [], badIds: new Set(), batchError: null, errorOnCall: null, tablesExist: true,
  watermarks: new Map(), failures: new Map(), batchCalls: [], queries: [], updated: []
};

function reset(ids) {
  db.ids         = ids;
  db.badIds      = new Set();
  db.batchError  = null;
  db.errorOnCall = null;
  db.tablesExist = true;
  db.watermarks  = new Map();
  db.failures    = new Map();
  db.batchCalls  = [];
  db.queries     = [];
  db.updated     = [];
}

function dataError(id) {
  return Object.assign(new Error(`invalid input for ${id}`), { code: "22P02" });
}

/** 갱신 묶음 문을 흉내 낸다: 후보 id 중 badIds 가 있으면 오류, 아니면 갱신한 것으로 기록한다. */
function runBatchSql(sql, params) {
  const [afterId, limit] = params;
  const onlyMatch = sql.match(/AND id = \$(\d+)/);
  const onlyId    = onlyMatch ? params[Number(onlyMatch[1]) - 1] : null;
  db.batchCalls.push({ afterId, limit, onlyId, params });

  if (db.errorOnCall && db.batchCalls.length === db.errorOnCall.callNo) { const err = db.errorOnCall.error; db.errorOnCall = null; throw err; }
  if (db.batchError) { const err = db.batchError; db.batchError = null; throw err; }

  const pool = onlyId === null ? db.ids.filter(id => id > afterId && !db.updated.includes(id)).slice(0, limit)
                               : db.ids.filter(id => id === onlyId && !db.updated.includes(id));
  const bad = pool.find(id => db.badIds.has(id));
  if (bad !== undefined) throw dataError(bad);
  db.updated.push(...pool);
  return { rows: [{ n: pool.length, last_id: pool.length ? pool[pool.length - 1] : null }] };
}

function runSql(sql, params) {
  db.queries.push(sql);
  if (sql.includes("FOR NO KEY UPDATE")) return runBatchSql(sql, params);
  if (sql.includes("SELECT NOW()"))      return { rows: [{ ts: new Date("2026-10-03T00:00:00Z") }] };
  if (sql.includes("to_regclass"))       return { rows: [db.tablesExist ? { watermark: "w", failure: "f" } : { watermark: null, failure: null }] };
  if (/^\s*SELECT id FROM/.test(sql)) {
    const [afterId, limit] = params;
    return { rows: db.ids.filter(id => id > afterId && !db.updated.includes(id)).slice(0, limit).map(id => ({ id })) };
  }
  return runStateSql(sql, params);
}

function runStateSql(sql, params) {
  if (/INSERT INTO agent_memory\.backfill_watermarks/.test(sql)) {
    if (!db.watermarks.has(params[0])) db.watermarks.set(params[0], { last_id: "", rows_done: 0, status: "running" });
    return { rows: [] };
  }
  if (/SELECT last_id/.test(sql)) {
    const w = db.watermarks.get(params[0]);
    return { rows: [{ last_id: w.last_id, rows_done: String(w.rows_done), status: w.status }] };
  }
  if (/UPDATE agent_memory\.backfill_watermarks\s+SET last_id/.test(sql)) {
    const w = db.watermarks.get(params[0]);
    w.last_id = params[1]; w.rows_done += params[2];
    return { rows: [] };
  }
  if (/SET status = 'completed'/.test(sql)) { db.watermarks.get(params[0]).status = "completed"; return { rows: [] }; }
  if (/DELETE FROM agent_memory\.backfill_watermarks/.test(sql)) { db.watermarks.delete(params[0]); return { rows: [] }; }
  if (/DELETE FROM agent_memory\.backfill_failures WHERE job = \$1 AND row_id/.test(sql)) { db.failures.delete(`${params[0]}/${params[1]}`); return { rows: [] }; }
  if (/DELETE FROM agent_memory\.backfill_failures WHERE job = \$1$/.test(sql.trim())) {
    for (const key of [...db.failures.keys()]) if (key.startsWith(`${params[0]}/`)) db.failures.delete(key);
    return { rows: [] };
  }
  if (/INSERT INTO agent_memory\.backfill_failures/.test(sql)) {
    const key = `${params[0]}/${params[1]}`;
    const old = db.failures.get(key);
    db.failures.set(key, { row_id: params[1], error: params[2], sqlstate: params[3], attempts: old ? old.attempts + 1 : 1 });
    return { rows: [] };
  }
  if (/SELECT row_id FROM agent_memory\.backfill_failures/.test(sql)) {
    return { rows: [...db.failures.values()].map(f => ({ row_id: f.row_id })).sort((a, b) => a.row_id.localeCompare(b.row_id)) };
  }
  if (/SELECT row_id, error, sqlstate, attempts/.test(sql)) return { rows: [...db.failures.values()] };
  throw new Error(`예상하지 못한 SQL: ${sql}`);
}

mock.module("../../lib/tools/db.js", {
  exports: { queryWithAgentVector: async (_agent, sql, params = []) => runSql(sql, params) }
});

const {
  runResumableBackfill, retryBackfillFailures, listBackfillFailures, ensureBackfillTables,
  isRowLevelError, BackfillError, BackfillTableMissingError, BACKFILL_TABLES_DDL
} = await import("../../lib/memory/consolidate/resumableBackfill.js");

const { unreferencedParamGuard } = await import("../../lib/memory/consolidate/idOrderedUpdate.js");

const SPEC = { job: "job-a", where: "importance < $4", set: "importance = $4", params: [0.9], batchSize: 2 };
const ids  = n => Array.from({ length: n }, (_, i) => `f${String(i + 1).padStart(3, "0")}`);

beforeEach(() => reset(ids(5)));

describe("runResumableBackfill 정상 경로", () => {
  it("묶음마다 watermark 를 기록하고 끝나면 완료로 표시한다", async () => {
    const result = await runResumableBackfill(SPEC);
    assert.equal(result.rowsUpdated, 5);
    assert.equal(result.failedRows, 0);
    assert.equal(result.lastId, "f005");
    assert.equal(result.alreadyCompleted, false);
    assert.deepEqual(db.watermarks.get("job-a"), { last_id: "f005", rows_done: 5, status: "completed" });
    assert.deepEqual(db.batchCalls.map(c => c.afterId), ["", "f002", "f004", "f005"]);
  });

  it("params 는 $4 부터 갱신 문에 전달한다", async () => {
    await runResumableBackfill(SPEC);
    assert.ok(db.batchCalls.every(c => c.params[3] === 0.9));
  });

  it("완료된 작업은 묶음을 실행하지 않는다", async () => {
    await runResumableBackfill(SPEC);
    db.batchCalls.length = 0;
    const again = await runResumableBackfill(SPEC);
    assert.equal(again.alreadyCompleted, true);
    assert.equal(again.rowsUpdated, 0);
    assert.equal(db.batchCalls.length, 0);
  });

  it("restart 는 watermark 와 실패 기록을 지우고 처음부터 실행한다", async () => {
    await runResumableBackfill(SPEC);
    db.updated = [];
    db.batchCalls.length = 0;
    const again = await runResumableBackfill({ ...SPEC, restart: true });
    assert.equal(again.alreadyCompleted, false);
    assert.equal(again.resumedFrom, "");
    assert.equal(again.rowsUpdated, 5);
  });
});

describe("runResumableBackfill 이어하기", () => {
  it("행 단위가 아닌 오류는 그대로 던지고 watermark 는 성공한 묶음까지 남는다", async () => {
    db.errorOnCall = { callNo: 2, error: Object.assign(new Error("연결 끊김"), { code: "08006" }) };
    await assert.rejects(runResumableBackfill(SPEC), err => err.code === "08006");
    assert.equal(db.watermarks.get("job-a").last_id, "f002");
    assert.equal(db.watermarks.get("job-a").status, "running");
    assert.equal(db.failures.size, 0);

    db.batchCalls.length = 0;
    const result = await runResumableBackfill(SPEC);
    assert.equal(result.resumedFrom, "f002");
    assert.equal(result.rowsUpdated, 3);
    assert.equal(db.batchCalls[0].afterId, "f002");
    assert.deepEqual(db.updated, ids(5));
    assert.equal(db.watermarks.get("job-a").rows_done, 5);
    assert.equal(db.watermarks.get("job-a").status, "completed");
  });
});

describe("runResumableBackfill 실패 행 기록", () => {
  it("행 단위 오류가 난 행을 기록하고 나머지를 갱신하며 watermark 가 그 행을 지난다", async () => {
    db.badIds = new Set(["f003"]);
    const result = await runResumableBackfill(SPEC);
    assert.equal(result.failedRows, 1);
    assert.equal(result.rowsUpdated, 4);
    assert.deepEqual(db.updated, ["f001", "f002", "f004", "f005"]);
    assert.equal(db.watermarks.get("job-a").status, "completed");
    const failures = await listBackfillFailures("job-a");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].row_id, "f003");
    assert.equal(failures[0].sqlstate, "22P02");
  });

  it("무결성 위반(23 계열)도 행 단위 오류로 본다", () => {
    assert.equal(isRowLevelError({ code: "23505" }), true);
    assert.equal(isRowLevelError({ code: "22003" }), true);
  });

  const notRow = ["08006", "40P01", "57014", "42703", "53300", undefined];
  for (const code of notRow) {
    it(`SQLSTATE ${code} 는 행 단위 오류가 아니다`, () => {
      assert.equal(isRowLevelError({ code }), false);
    });
  }

  it("실패 후보를 찾지 못하면 원 오류를 던진다", async () => {
    db.ids = [];
    db.batchError = dataError("none");
    await assert.rejects(runResumableBackfill(SPEC), err => err.code === "22P02");
    assert.equal(db.failures.size, 0);
  });

  it("후보 id 조회 문은 where 가 쓰지 않는 값을 text 로 참조한다", async () => {
    db.badIds = new Set(["f001"]);
    await runResumableBackfill({ ...SPEC, where: "importance < 1", set: "importance = $4" });
    const select = db.queries.find(q => /^\s*SELECT id FROM/.test(q));
    assert.match(select, /\$3::text IS NOT NULL/);
    assert.match(select, /\$4::text IS NOT NULL/);
  });
});

describe("retryBackfillFailures", () => {
  it("성공한 행은 기록에서 지우고 다시 실패한 행은 시도 횟수를 올린다", async () => {
    db.badIds = new Set(["f002", "f004"]);
    await runResumableBackfill(SPEC);
    assert.equal(db.failures.size, 2);

    db.badIds = new Set(["f004"]);
    const result = await retryBackfillFailures(SPEC);
    assert.deepEqual(result, { resolved: 1, stillFailing: 1 });
    const failures = await listBackfillFailures("job-a");
    assert.deepEqual(failures.map(f => [f.row_id, f.attempts]), [["f004", 2]]);
    assert.ok(db.updated.includes("f002"));
  });

  it("행 단위가 아닌 오류는 던진다", async () => {
    db.badIds = new Set(["f001"]);
    await runResumableBackfill(SPEC);
    db.batchError = Object.assign(new Error("취소"), { code: "57014" });
    await assert.rejects(retryBackfillFailures(SPEC), err => err.code === "57014");
    assert.equal(db.failures.size, 1);
  });
});

describe("입력과 선행 조건", () => {
  const badJobs = ["", "Upper", "has space", "a/b", "x".repeat(65), null, 7];
  for (const job of badJobs) {
    it(`job 이름 ${JSON.stringify(job)} 는 거부한다`, async () => {
      await assert.rejects(runResumableBackfill({ ...SPEC, job }), BackfillError);
      assert.equal(db.queries.length, 0);
    });
  }

  const badSizes = [0, -1, 1.5, "10", NaN, undefined];
  for (const batchSize of badSizes) {
    it(`batchSize ${String(batchSize)} 는 거부한다`, async () => {
      await assert.rejects(runResumableBackfill({ ...SPEC, batchSize }), BackfillError);
    });
  }

  it("표가 없으면 묶음을 실행하지 않고 거부한다", async () => {
    db.tablesExist = false;
    await assert.rejects(runResumableBackfill(SPEC), BackfillTableMissingError);
    await assert.rejects(retryBackfillFailures(SPEC),  BackfillTableMissingError);
    assert.equal(db.batchCalls.length, 0);
  });

  it("ensureBackfillTables 는 두 표의 멱등 문장을 실행한다", async () => {
    const seen = [];
    await ensureBackfillTables(async sql => { seen.push(sql); });
    assert.equal(seen.length, 2);
    assert.ok(seen.every(s => /CREATE TABLE IF NOT EXISTS agent_memory\.backfill_/.test(s)));
    assert.deepEqual(seen, [...BACKFILL_TABLES_DDL]);
  });
});

describe("unreferencedParamGuard", () => {
  const cases = [
    ["where 가 $3 와 $4 를 쓰면 조각이 없다",          "a < $3 AND b > $4", 1, ""],
    ["where 가 아무것도 안 쓰면 $3 과 $4 를 막는다",    "b IS NULL",         1, " AND $3::text IS NOT NULL AND $4::text IS NOT NULL"],
    ["where 가 $4 만 쓰면 $3 만 막는다",               "b > $4",            1, " AND $3::text IS NOT NULL"],
    ["params 가 없으면 $3 만 대상이다",                "b IS NULL",         0, " AND $3::text IS NOT NULL"],
    ["params 둘이면 $5 까지 본다",                     "b > $4",            2, " AND $3::text IS NOT NULL AND $5::text IS NOT NULL"]
  ];
  for (const [name, where, count, expected] of cases) {
    it(name, () => assert.equal(unreferencedParamGuard(where, count), expected));
  }
});
