/**
 * 재개형 백필 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * watermark 표와 실패 행 표를 운영 절차와 같은 문장으로 만든 뒤, 트리거로 만든 행 단위 오류와
 * 행 단위가 아닌 오류에서 도우미가 기록하고 이어하는지 검사한다. 실행마다 전용 데이터베이스를
 * 만들어 쓰고 끝나면 지운다.
 */
import crypto                          from "node:crypto";
import { describe, it, after } from "node:test";
import assert                          from "node:assert/strict";

const { prepareLaneDatabase, dropLaneDatabase, directQuery, seedFragments } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool } = await import("../../lib/tools/db.js");
const {
  ensureBackfillTables, runResumableBackfill, retryBackfillFailures, listBackfillFailures, BackfillTableMissingError, BackfillConcurrentRunError
} = await import("../../lib/memory/consolidate/resumableBackfill.js");

const RUN = `rb-${crypto.randomBytes(4).toString("hex")}`;

/** 대상: topic 이 일치하고 importance 가 0.75 가 아닌 행. 갱신하면 대상에서 빠진다. */
function specFor(topic, job, batchSize = 40) {
  return {
    job, batchSize,
    where:  "topic = $4 AND importance <> 0.75",
    set:    "importance = 0.75",
    params: [topic]
  };
}

async function countDone(topic) {
  const { rows } = await directQuery(
    "SELECT count(*)::int AS n FROM agent_memory.fragments WHERE topic = $1 AND importance = 0.75", [topic]);
  return rows[0].n;
}

/** id 를 지정해 트리거 오류를 낸다. state 는 SQLSTATE. 빈 값이면 트리거를 지운다. */
async function setPoison(ids, sqlstate) {
  await directQuery("DROP TRIGGER IF EXISTS rb_poison ON agent_memory.fragments");
  await directQuery("DROP FUNCTION IF EXISTS agent_memory.rb_poison_fn()");
  if (!sqlstate) return;
  await directQuery(`
    CREATE FUNCTION agent_memory.rb_poison_fn() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id = ANY (ARRAY[${ids.map(id => `'${id}'`).join(",")}]) THEN
        RAISE EXCEPTION 'poison %', NEW.id USING ERRCODE = '${sqlstate}';
      END IF;
      RETURN NEW;
    END $$`);
  await directQuery(
    "CREATE TRIGGER rb_poison BEFORE UPDATE ON agent_memory.fragments FOR EACH ROW EXECUTE FUNCTION agent_memory.rb_poison_fn()");
}

async function watermark(job) {
  const { rows } = await directQuery(
    "SELECT last_id, rows_done::int AS rows_done, status FROM agent_memory.backfill_watermarks WHERE job = $1", [job]);
  return rows[0];
}

after(async () => {
  try {
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

describe("재개형 백필 실서버", () => {
  it("표가 없으면 거부하고, 운영 절차 문장으로 만든 뒤에는 두 번 만들어도 오류가 없다", async () => {
    const topic = `${RUN}-none`;
    await seedFragments(topic, 3);
    await assert.rejects(runResumableBackfill(specFor(topic, `${RUN}-none`)), BackfillTableMissingError);
    assert.equal(await countDone(topic), 0);

    await ensureBackfillTables(sql => directQuery(sql));
    await ensureBackfillTables(sql => directQuery(sql));
  });

  it("모든 대상 행을 갱신하고 watermark 를 완료로 남긴다", async () => {
    const topic = `${RUN}-all`;
    await seedFragments(topic, 130);
    const result = await runResumableBackfill(specFor(topic, `${RUN}-all`));
    assert.equal(result.rowsUpdated, 130);
    assert.equal(await countDone(topic), 130);
    const w = await watermark(`${RUN}-all`);
    assert.equal(w.status, "completed");
    assert.equal(w.rows_done, 130);

    const again = await runResumableBackfill(specFor(topic, `${RUN}-all`));
    assert.equal(again.alreadyCompleted, true);
  });

  it("행 단위가 아닌 오류로 중단되면 watermark 부터 이어서 끝낸다", async () => {
    const topic = `${RUN}-resume`;
    const job   = `${RUN}-resume`;
    const ids   = (await seedFragments(topic, 100)).sort();
    /** 정렬상 61번째 행이 속한 묶음(41~80번째)에서 연결 계열 오류를 낸다. */
    await setPoison([ids[60]], "08006");
    try {
      await assert.rejects(runResumableBackfill(specFor(topic, job)), err => err.code === "08006");
    } finally {
      await setPoison([], null);
    }
    const stopped = await watermark(job);
    assert.equal(stopped.status, "running");
    assert.equal(stopped.last_id, ids[39]);
    assert.equal(stopped.rows_done, 40);
    assert.equal(await countDone(topic), 40);
    assert.deepEqual(await listBackfillFailures(job), []);

    const resumed = await runResumableBackfill(specFor(topic, job));
    assert.equal(resumed.resumedFrom, ids[39]);
    assert.equal(resumed.rowsUpdated, 60);
    assert.equal(await countDone(topic), 100);
    assert.equal((await watermark(job)).rows_done, 100);
  });

  it("행 단위 오류는 그 행만 기록하고 나머지를 갱신하며, 고친 뒤 재시도로 해결한다", async () => {
    const topic = `${RUN}-poison`;
    const job   = `${RUN}-poison`;
    const ids   = (await seedFragments(topic, 90)).sort();
    await setPoison([ids[10], ids[70]], "22023");

    const result = await runResumableBackfill(specFor(topic, job));
    assert.equal(result.failedRows, 2);
    assert.equal(result.rowsUpdated, 88);
    assert.equal(await countDone(topic), 88);
    const failures = await listBackfillFailures(job);
    assert.deepEqual(failures.map(f => f.row_id).sort(), [ids[10], ids[70]].sort());
    assert.ok(failures.every(f => f.sqlstate === "22023" && f.error_class === "data_exception" && f.attempts === 1));
    assert.ok(failures.every(f => !JSON.stringify(f).includes("poison")));
    assert.equal((await watermark(job)).status, "completed");

    const stillBad = await retryBackfillFailures(specFor(topic, job));
    assert.deepEqual(stillBad, { resolved: 0, stillFailing: 2 });
    assert.ok((await listBackfillFailures(job)).every(f => f.attempts === 2));

    await setPoison([], null);
    const fixed = await retryBackfillFailures(specFor(topic, job));
    assert.deepEqual(fixed, { resolved: 2, stillFailing: 0 });
    assert.deepEqual(await listBackfillFailures(job), []);
    assert.equal(await countDone(topic), 90);
  });

  it("다른 실행이 watermark 를 진행했으면 멈추고 watermark 를 되돌리지 않는다", async () => {
    const topic = `${RUN}-cas`;
    const job   = `${RUN}-cas`;
    const ids   = (await seedFragments(topic, 100)).sort();
    /** 두 번째 묶음의 행이 갱신될 때 다른 실행이 watermark 를 옮긴 것처럼 같은 트랜잭션에서 값을 바꾼다. */
    await directQuery("DROP TRIGGER IF EXISTS rb_other_run ON agent_memory.fragments");
    await directQuery("DROP FUNCTION IF EXISTS agent_memory.rb_other_run_fn()");
    await directQuery(`
      CREATE FUNCTION agent_memory.rb_other_run_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE agent_memory.backfill_watermarks SET last_id = 'zzzz' WHERE job = '${job}';
        RETURN NEW;
      END $$`);
    await directQuery(`
      CREATE TRIGGER rb_other_run AFTER UPDATE ON agent_memory.fragments
        FOR EACH ROW WHEN (NEW.id = '${ids[50]}') EXECUTE FUNCTION agent_memory.rb_other_run_fn()`);
    try {
      await assert.rejects(runResumableBackfill(specFor(topic, job)), BackfillConcurrentRunError);
    } finally {
      await directQuery("DROP TRIGGER IF EXISTS rb_other_run ON agent_memory.fragments");
      await directQuery("DROP FUNCTION IF EXISTS agent_memory.rb_other_run_fn()");
    }
    const w = await watermark(job);
    assert.equal(w.last_id, "zzzz");
    assert.equal(w.status, "running");
    assert.equal(w.rows_done, 40);
  });

  it("restart 는 처음부터 다시 실행한다", async () => {
    const topic = `${RUN}-restart`;
    const job   = `${RUN}-restart`;
    await seedFragments(topic, 10);
    await runResumableBackfill(specFor(topic, job));
    await directQuery("UPDATE agent_memory.fragments SET importance = 0.5 WHERE topic = $1", [topic]);

    const skipped = await runResumableBackfill(specFor(topic, job));
    assert.equal(skipped.alreadyCompleted, true);
    assert.equal(await countDone(topic), 0);

    const again = await runResumableBackfill({ ...specFor(topic, job), restart: true });
    assert.equal(again.rowsUpdated, 10);
    assert.equal(await countDone(topic), 10);
  });
});
