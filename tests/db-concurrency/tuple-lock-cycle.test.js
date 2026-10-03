/**
 * 행 버전 잠금 대기열 교착 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 여러 파편 행을 id 순으로 잠그는 쓰기 경로가, 같은 행을 id 순으로 잠그는 다른 트랜잭션과
 * 교착하지 않는지 세션 순서를 고정해 확인한다. 고정하는 순서는 다음과 같다.
 *
 *   1. 반복 읽기 트랜잭션 K가 스냅숏을 잡는다.
 *   2. Q가 R을 갱신하고 커밋하지 않는다(R의 이전 버전과 새 버전이 생긴다).
 *   3. 쓰기 경로 W가 A, R, Z를 대상으로 시작하고 A 보유자 때문에 기다린다.
 *      W의 스냅숏은 R의 이전 버전을 본다.
 *   4. 잠금 트랜잭션 P가 B, R을 대상으로 시작하고 B 보유자 때문에 기다린다.
 *   5. Q가 커밋하고 A가 풀린다. W는 R의 새 버전을 잠그고 Z에서 기다린다.
 *   6. K가 R의 이전 버전에 FOR KEY SHARE를 건다. 이전 버전의 xmax는 커밋된 갱신과
 *      살아 있는 키 공유 잠금을 함께 담은 multixact가 된다.
 *   7. B가 풀린다. P는 R의 이전 버전의 튜플 잠금을 쥔 채 새 버전을 쥔 W를 기다린다.
 *   8. Z가 풀린다. W가 갱신 단계로 넘어간다.
 *
 * W의 갱신이 자기 스냅숏의 이전 버전을 다시 건드리면 그 버전의 튜플 잠금을 기다리게 되고
 * P와 서로를 기다린다(40P01). 갱신이 잠근 최신 버전만 다루면 W는 기다리지 않고 끝난다.
 *
 * 한 문장 안에서 잠금과 갱신이 행마다 번갈아 일어나는 계획(touchLinked의 중첩 루프)은
 * 행을 잠근 직후 바로 갱신하므로 이 순서로는 대기열에 끼어들 틈이 없다. 그 경로도 같은
 * 순서로 실행해 교착이 없음을 함께 확인한다.
 */

import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import pg                              from "pg";

const {
  SCHEMA, prepareLaneDatabase, dropLaneDatabase, laneDatabaseName, directClientConfig, directQuery,
  readDeadlockCount, deadlockDelta, installDeadlockProbe, uninstallDeadlockProbe, observedDeadlockStatements
} = await import("./_harness.js");

await prepareLaneDatabase();
installDeadlockProbe();

const { FragmentWriter }  = await import("../../lib/memory/write/FragmentWriter.js");
const { EmbeddingWorker } = await import("../../lib/memory/embedding/EmbeddingWorker.js");
const { shutdownPool }    = await import("../../lib/tools/db.js");

const SESSIONS = ["K", "Q", "HA", "HB", "HZ", "P", "MON"];
const WAIT_MS  = 10_000;

let vector = [];
let serial = 0;

before(async () => {
  const { rows } = await directQuery(
    `SELECT atttypmod AS dims FROM pg_attribute
      WHERE attrelid = '${SCHEMA}.fragments'::regclass AND attname = 'embedding'`
  );
  vector = Array.from({ length: rows[0].dims }, () => 0.01);
});

after(async () => {
  uninstallDeadlockProbe();
  try {
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

/**
 * 사전식 순서가 S < A < B < R < Z 인 파편 다섯 개를 만든다.
 *
 * @returns {Promise<{S: string, A: string, B: string, R: string, Z: string}>}
 */
async function seedRows() {
  const prefix = `tlc${String(++serial).padStart(3, "0")}`;
  const rows   = { S: `${prefix}-0s`, A: `${prefix}-1a`, B: `${prefix}-2b`, R: `${prefix}-3r`, Z: `${prefix}-4z` };
  await directQuery(
    `INSERT INTO ${SCHEMA}.fragments
            (id, content, type, topic, importance, ttl_tier, agent_id, keywords, content_hash)
     SELECT id, 'db-lane ' || id, 'fact', 'db-lane-tuple', 0.5, 'warm', 'default', '{}', md5(id)
       FROM unnest($1::text[]) AS id`,
    [Object.values(rows)]
  );
  /** touchLinked가 A, R, Z를 대상으로 고르도록 S와 co_retrieved로 잇는다. */
  await directQuery(
    `INSERT INTO ${SCHEMA}.fragment_links (from_id, to_id, relation_type, weight)
     SELECT $1, to_id, 'co_retrieved', 1.0 FROM unnest($2::text[]) AS to_id`,
    [rows.S, [rows.A, rows.R, rows.Z]]
  );
  return rows;
}

/**
 * 기다림 조건이 참이 될 때까지 짧게 다시 확인한다.
 *
 * @param {() => Promise<boolean>} check
 * @param {string} what
 * @returns {Promise<void>}
 */
async function until(check, what) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`시간 안에 성립하지 않음: ${what}`);
}

/**
 * 고정 순서를 재현하고 쓰기 경로와 잠금 트랜잭션의 결과를 돌려준다.
 *
 * @param {(rows: object) => Promise<unknown>} runWriter W. A, R, Z를 잠그고 갱신하는 쓰기 경로
 * @returns {Promise<{writer: string, locker: string, serverDeadlocks: number, observed: string[]}>}
 */
async function runScenario(runWriter) {
  const rows    = await seedRows();
  const clients = Object.fromEntries(SESSIONS.map(name => [name, new pg.Client(directClientConfig())]));
  await Promise.all(Object.values(clients).map(c => c.connect()));
  const pids = {};
  for (const name of SESSIONS) {
    pids[name] = (await clients[name].query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  }
  const { K, Q, HA, HB, HZ, P, MON } = clients;
  const ownPids      = Object.values(pids);
  const probeBase    = observedDeadlockStatements().length;
  const serverBase   = await readDeadlockCount();
  let   writerResult = null;
  let   lockerResult = null;
  const lockRow      = (client, id) =>
    client.query(`SELECT id FROM ${SCHEMA}.fragments WHERE id = $1 FOR NO KEY UPDATE`, [id]);
  const xidOf        = async (client) => (await client.query("SELECT txid_current()::text AS x")).rows[0].x;

  /** pid가 기다리는 transactionid 잠금의 xid 목록 */
  const waitingXids = async (pid) => (await MON.query(
    `SELECT transactionid::text AS x FROM pg_locks
      WHERE pid = $1 AND locktype = 'transactionid' AND NOT granted`, [pid]
  )).rows.map(r => r.x);
  const holdsTupleLock = async (pid) => (await MON.query(
    "SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'tuple' AND granted", [pid]
  )).rowCount > 0;

  try {
    await K.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await K.query(`SELECT count(*) FROM ${SCHEMA}.fragments`);

    await Q.query("BEGIN");
    await Q.query(`UPDATE ${SCHEMA}.fragments SET accessed_at = NOW() WHERE id = $1`, [rows.R]);

    for (const [client, id] of [[HA, rows.A], [HB, rows.B], [HZ, rows.Z]]) {
      await client.query("BEGIN");
      await lockRow(client, id);
    }
    const xidA = await xidOf(HA);
    const xidB = await xidOf(HB);
    const xidZ = await xidOf(HZ);

    const writer = Promise.resolve().then(() => runWriter(rows)).then(() => "ok", err => err.code ?? err.message);
    let writerPid = null;
    await until(async () => {
      const { rows: found } = await MON.query(
        `SELECT pid FROM pg_stat_activity
          WHERE datname = $1 AND wait_event_type = 'Lock' AND pid <> ALL($2::int[])`,
        [laneDatabaseName(), ownPids]
      );
      writerPid = found[0]?.pid ?? null;
      return writerPid !== null && (await waitingXids(writerPid)).includes(xidA);
    }, "쓰기 경로가 A에서 기다림");

    await P.query("BEGIN");
    const locker = P.query(
      `SELECT id FROM ${SCHEMA}.fragments WHERE id = ANY($1::text[]) ORDER BY id FOR NO KEY UPDATE`,
      [[rows.R, rows.B]]
    ).then(() => P.query("COMMIT")).then(() => "ok", err => err.code ?? err.message);
    await until(async () => (await waitingXids(pids.P)).includes(xidB), "잠금 트랜잭션이 B에서 기다림");

    await Q.query("COMMIT");
    await HA.query("COMMIT");
    await until(async () => (await waitingXids(writerPid)).includes(xidZ), "쓰기 경로가 R을 잠그고 Z에서 기다림");

    await K.query(`SELECT id FROM ${SCHEMA}.fragments WHERE id = $1 FOR KEY SHARE`, [rows.R]);

    await HB.query("COMMIT");
    await until(async () => {
      const waits = await waitingXids(pids.P);
      return waits.length > 0 && !waits.includes(xidB) && await holdsTupleLock(pids.P);
    }, "잠금 트랜잭션이 R의 이전 버전 튜플 잠금을 쥐고 기다림");

    await HZ.query("COMMIT");
    [writerResult, lockerResult] = await Promise.all([writer, locker]);
    await K.query("COMMIT");
  } finally {
    for (const client of Object.values(clients)) {
      await client.query("ROLLBACK").catch(() => {});
      await client.end().catch(() => {});
    }
  }

  /** 서버 교착 집계는 백엔드가 끝날 때 반영되므로 연결을 닫은 뒤에 읽는다. */
  return {
    writer         : writerResult,
    locker         : lockerResult,
    serverDeadlocks: await deadlockDelta(serverBase, 1500),
    observed       : observedDeadlockStatements().slice(probeBase)
  };
}

/**
 * 결과에 교착이 없어야 한다.
 *
 * @param {{writer: string, locker: string, serverDeadlocks: number, observed: string[]}} result
 */
function assertNoDeadlock(result) {
  const report = JSON.stringify(result);
  assert.equal(result.writer, "ok", report);
  assert.equal(result.locker, "ok", report);
  assert.deepEqual(result.observed, [], report);
  assert.equal(result.serverDeadlocks, 0, report);
}

describe("행 버전 잠금 대기열", () => {
  it("incrementAccess는 이전 버전 튜플 잠금을 쥔 대기자와 교착하지 않는다", { timeout: 60_000 }, async () => {
    const writer = new FragmentWriter();
    assertNoDeadlock(await runScenario(rows => writer.incrementAccess([rows.Z, rows.R, rows.A], "default")));
  });

  it("touchLinked는 이전 버전 튜플 잠금을 쥔 대기자와 교착하지 않는다", { timeout: 60_000 }, async () => {
    const writer = new FragmentWriter();
    assertNoDeadlock(await runScenario(rows =>
      writer.touchLinked([rows.S], "default", null, { allWorkspaces: true })));
  });

  it("임베딩 일괄 저장은 이전 버전 튜플 잠금을 쥔 대기자와 교착하지 않는다", { timeout: 60_000 }, async () => {
    const worker = new EmbeddingWorker();
    worker.embeddingCache = { get: async () => vector, set() {} };
    assertNoDeadlock(await runScenario(rows =>
      worker._embedChunk([rows.Z, rows.R, rows.A].map(id => ({ id, content: `db-lane ${id}` })))));
  });
});
