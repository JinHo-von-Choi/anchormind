/**
 * 파편 행 잠금 순서 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 접근 기록 갱신, 연결 파편 접근 기록, 임베딩 일괄 갱신, 링크 일괄 생성을 실제
 * PostgreSQL에서 겹쳐 실행한다. 같은 파편 집합을 서로 다른 순서로 넘겨도 교착
 * (SQLSTATE 40P01)이 한 번도 나지 않아야 한다. 각 경로는 실패를 로그로만 남기는
 * 경우가 있으므로 던져진 오류, pg 클라이언트가 받은 40P01(삼켜진 것 포함),
 * 서버 교착 집계를 모두 센다.
 */

import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import crypto                          from "node:crypto";
import pg                              from "pg";
import { appendFileSync }              from "node:fs";

const {
  SCHEMA, prepareLaneDatabase, dropLaneDatabase, readDeadlockCount, deadlockDelta, directClientConfig,
  seedFragments, shuffled, directQuery,
  installDeadlockProbe, uninstallDeadlockProbe, observedDeadlockStatements
} = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();
installDeadlockProbe();

const { FragmentWriter }  = await import("../../lib/memory/write/FragmentWriter.js");
const { LinkStore }       = await import("../../lib/memory/link/LinkStore.js");
const { EmbeddingWorker } = await import("../../lib/memory/embedding/EmbeddingWorker.js");
const { shutdownPool }    = await import("../../lib/tools/db.js");

const ROUNDS      = Number(process.env.DB_LANE_ROUNDS || 20);
const FRAGMENTS   = 40;
const PER_KIND    = 4;
const SUBSET_SIZE = 25;
const topic       = `db-lane-lock-${crypto.randomUUID().slice(0, 8)}`;

let ids    = [];
let vector = [];

before(async () => {
  ids = await seedFragments(topic, FRAGMENTS);
  /** 연결 파편 접근 기록이 실제로 행을 잠그도록 co_retrieved 링크를 둔다. */
  for (let i = 0; i < FRAGMENTS; i += 2) {
    await directQuery(
      `INSERT INTO ${SCHEMA}.fragment_links (from_id, to_id, relation_type, weight)
       VALUES ($1, $2, 'co_retrieved', 1.0) ON CONFLICT DO NOTHING`,
      [ids[i], ids[(i + 7) % FRAGMENTS]]
    );
  }
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
 * 링크 쌍 4개를 만든다. 호출자 계약에 따라 (min,max) 사전식으로 정렬한다.
 *
 * @returns {Array<{fromId: string, toId: string, relationType: string}>}
 */
function linkPairs() {
  const s     = shuffled(ids).slice(0, 8);
  const pairs = [];
  for (let i = 0; i < 8; i += 2) {
    const key = s[i] < s[i + 1] ? `${s[i]}|${s[i + 1]}` : `${s[i + 1]}|${s[i]}`;
    pairs.push({ fromId: s[i], toId: s[i + 1], relationType: "related", key });
  }
  pairs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return pairs.map(({ fromId, toId, relationType }) => ({ fromId, toId, relationType }));
}

/**
 * 같은 두 행을 서로 반대 순서로 잠그는 두 트랜잭션을 만들어 교착을 일으킨다.
 * 계측이 40P01을 실제로 세는지 확인하는 용도다.
 *
 * @returns {Promise<void>}
 */
async function induceDeadlock() {
  const [rowA, rowB] = await seedFragments(topic, 2);
  const lock         = (client, id) =>
    client.query(`SELECT 1 FROM ${SCHEMA}.fragments WHERE id = $1 FOR UPDATE`, [id]);
  const first  = new pg.Client(directClientConfig());
  const second = new pg.Client(directClientConfig());
  await Promise.all([first.connect(), second.connect()]);
  try {
    await first.query("BEGIN");
    await second.query("BEGIN");
    await lock(first, rowA);
    await lock(second, rowB);
    const settled = await Promise.allSettled([lock(first, rowB), lock(second, rowA)]);
    assert.ok(settled.some(s => s.status === "rejected" && s.reason.code === "40P01"));
  } finally {
    await first.query("ROLLBACK").catch(() => {});
    await second.query("ROLLBACK").catch(() => {});
    await Promise.all([first.end(), second.end()]);
  }
}

describe("교착 계측", () => {
  it("반대 순서로 잠그는 두 트랜잭션의 40P01을 질의 단위로 센다", { timeout: 30_000 }, async () => {
    const baseline = observedDeadlockStatements().length;
    const server0  = await readDeadlockCount();

    await induceDeadlock();

    const observed = observedDeadlockStatements().slice(baseline);
    assert.equal(observed.length, 1, JSON.stringify(observed));
    assert.match(observed[0], /^SELECT 1 FROM agent_memory\.fragments WHERE id = \$1 FOR UPDATE$/);
    assert.equal(await deadlockDelta(server0), 1);
  });
});

describe("파편 행 잠금 순서", () => {
  it(`${ROUNDS}회 동시 실행에서 교착이 0건이다`, { timeout: 120_000 }, async () => {
    const writer = new FragmentWriter();
    const links  = new LinkStore();
    const worker = new EmbeddingWorker();
    worker.embeddingCache = { get: async () => vector, set() {} };

    const probeBase  = observedDeadlockStatements().length;
    const serverBase = await readDeadlockCount();
    const thrown     = [];
    const record     = (kind) => (err) => { thrown.push(`${kind}:${err.code ?? err.message}`); };

    for (let round = 0; round < ROUNDS; round++) {
      const jobs = [];
      for (let k = 0; k < PER_KIND; k++) {
        jobs.push(writer.incrementAccess(shuffled(ids).slice(0, SUBSET_SIZE), "default").catch(record("access")));
        jobs.push(writer.touchLinked(shuffled(ids).slice(0, SUBSET_SIZE), "default", null, { allWorkspaces: true }).catch(record("touch")));
        jobs.push(worker._embedChunk(shuffled(ids).slice(0, SUBSET_SIZE).map(id => ({ id, content: `db-lane ${id}` }))).catch(record("embed")));
        jobs.push(links.createLinks(linkPairs(), "default").catch(record("links")));
      }
      await Promise.all(jobs);
    }

    await shutdownPool();
    const serverDeadlocks = await deadlockDelta(serverBase);
    const observed        = observedDeadlockStatements().slice(probeBase);
    const report          = `rounds=${ROUNDS} thrown=${JSON.stringify(thrown)} ` +
                            `observed40P01=${JSON.stringify(observed)} serverDeadlocks=${serverDeadlocks}`;
    console.log(`[db-lane] ${report}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### DB lock order\n\n\`${report}\`\n`);
    }

    assert.deepEqual(thrown.filter(t => t.endsWith(":40P01")), [], report);
    assert.deepEqual(observed, [], report);
    assert.equal(serverDeadlocks, 0, report);
  });
});
