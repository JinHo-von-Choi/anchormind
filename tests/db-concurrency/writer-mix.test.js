/**
 * 파편 쓰기 경로 혼합 부하 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 같은 파편 집합을 다루는 쓰기 경로를 실제 PostgreSQL에서 한꺼번에 겹쳐 실행한다. recall
 * 부수효과(접근 기록, 연결 파편 접근 기록), 임베딩 일괄 저장, 링크 일괄 생성과 linked_to 갱신,
 * forget의 일괄 삭제와 linked_to 정리, 감쇠 묶음 갱신, TTL 계층 전환, EMA 감쇠, 앵커 승격에
 * 더해, 오래된 스냅숏으로 키 공유 잠금을 거는 트랜잭션과 외래키 검사를 일으키는 링크 삽입을
 * 함께 돌린다. 서버 교착 집계, pg 클라이언트가 받은 40P01, 잠금 충돌 재시도 지표가 모두 0이어야
 * 한다. 재시도가 교착을 가리지 않도록 서버 집계로 판정한다.
 *
 * DB_LANE_ROUNDS(기본 10)로 회차 수를 바꾼다.
 */

import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import crypto                          from "node:crypto";
import pg                              from "pg";

const {
  SCHEMA, prepareLaneDatabase, dropLaneDatabase, readDeadlockCount, deadlockDelta, directClientConfig,
  seedFragments, shuffled, directQuery,
  installDeadlockProbe, uninstallDeadlockProbe, observedDeadlockStatements
} = await import("./_harness.js");

await prepareLaneDatabase();
installDeadlockProbe();

const { FragmentWriter }     = await import("../../lib/memory/write/FragmentWriter.js");
const { LinkStore }          = await import("../../lib/memory/link/LinkStore.js");
const { EmbeddingWorker }    = await import("../../lib/memory/embedding/EmbeddingWorker.js");
const { FragmentGC }         = await import("../../lib/memory/consolidate/FragmentGC.js");
const { MemoryConsolidator } = await import("../../lib/memory/consolidate/MemoryConsolidator.js");
const { deadlockRetriesTotal } = await import("../../lib/tools/lock-retry.js");
const { shutdownPool }       = await import("../../lib/tools/db.js");

const ROUNDS      = Number(process.env.DB_LANE_ROUNDS || 10);
const FRAGMENTS   = 40;
const SUBSET_SIZE = 20;
const topic       = `db-lane-mix-${crypto.randomUUID().slice(0, 8)}`;

let ids    = [];
let vector = [];

before(async () => {
  ids = await seedFragments(topic, FRAGMENTS);
  for (let i = 0; i < FRAGMENTS; i += 2) {
    await directQuery(
      `INSERT INTO ${SCHEMA}.fragment_links (from_id, to_id, relation_type, weight)
       VALUES ($1, $2, 'co_retrieved', 1.0) ON CONFLICT DO NOTHING`,
      [ids[i], ids[(i + 7) % FRAGMENTS]]
    );
  }
  /** 감쇠, 계층 전환, 앵커 승격의 대상이 되도록 일부 행의 값을 바꾼다. */
  await directQuery(
    `UPDATE ${SCHEMA}.fragments
        SET importance = 0.85, access_count = 12, quality_verified = TRUE, ema_activation = 0.5,
            accessed_at = NOW() - INTERVAL '45 days'
      WHERE id = ANY($1)`,
    [ids.filter((_, i) => i % 3 === 0)]
  );
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
 * 반복 읽기 스냅숏을 먼저 잡고 잠시 뒤 대상 행에 키 공유 잠금을 거는 트랜잭션. 그 사이 갱신된
 * 행은 이전 버전에 잠금이 걸린다. 외래키 검사와 같은 잠금 강도다.
 *
 * @param {string[]} targets
 * @returns {Promise<void>}
 */
async function staleKeyShare(targets) {
  const client = new pg.Client(directClientConfig());
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await client.query(`SELECT count(*) FROM ${SCHEMA}.fragments`);
    await new Promise(resolve => setTimeout(resolve, 5 + crypto.randomInt(20)));
    for (const id of targets) {
      await client.query(`SELECT id FROM ${SCHEMA}.fragments WHERE id = $1 FOR KEY SHARE`, [id]);
    }
    await new Promise(resolve => setTimeout(resolve, crypto.randomInt(20)));
    await client.query("COMMIT");
  } finally {
    await client.end();
  }
}

/**
 * 외래키 검사를 일으키는 링크 삽입. 두 끝 파편에 키 공유 잠금이 걸린다.
 *
 * @returns {Promise<void>}
 */
async function linkInsert() {
  const [a, b] = shuffled(ids);
  await directQuery(
    `INSERT INTO ${SCHEMA}.fragment_links (from_id, to_id, relation_type, weight)
     VALUES ($1, $2, 'co_retrieved', 1.0)
     ON CONFLICT (from_id, to_id) DO UPDATE SET weight = ${SCHEMA}.fragment_links.weight + 1`,
    [a, b]
  );
}

/**
 * 링크 쌍 2개를 (min,max) 사전식으로 정렬해 만든다.
 *
 * @returns {Array<{fromId: string, toId: string, relationType: string}>}
 */
function linkPairs() {
  const s     = shuffled(ids).slice(0, 4);
  const pairs = [0, 2].map(i => ({ fromId: s[i], toId: s[i + 1], relationType: "related",
    key: s[i] < s[i + 1] ? `${s[i]}|${s[i + 1]}` : `${s[i + 1]}|${s[i]}` }));
  pairs.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return pairs.map(({ fromId, toId, relationType }) => ({ fromId, toId, relationType }));
}

/**
 * 지울 파편 둘을 만들고 기존 파편의 linked_to에 넣는다. deleteMany가 linked_to 정리와 삭제를
 * 기존 파편 집합 위에서 하도록 한다.
 *
 * @returns {Promise<string[]>}
 */
async function disposableLinked() {
  const doomed = await seedFragments(topic, 2);
  await directQuery(
    `UPDATE ${SCHEMA}.fragments SET linked_to = linked_to || $2::text[] WHERE id = ANY($1)`,
    [shuffled(ids).slice(0, 3), doomed]
  );
  return doomed;
}

/**
 * 재시도 지표의 전체 합.
 *
 * @returns {Promise<number>}
 */
async function retryTotal() {
  const { values } = await deadlockRetriesTotal.get();
  return values.reduce((sum, v) => sum + v.value, 0);
}

describe("파편 쓰기 경로 혼합 부하", () => {
  it(`${ROUNDS}회 혼합 실행에서 교착이 0건이다`, { timeout: 300_000 }, async () => {
    const writer = new FragmentWriter();
    const links  = new LinkStore();
    const worker = new EmbeddingWorker();
    const gc     = new FragmentGC();
    worker.embeddingCache = { get: async () => vector, set() {} };

    const probeBase  = observedDeadlockStatements().length;
    const serverBase = await readDeadlockCount();
    const retryBase  = await retryTotal();
    const thrown     = [];
    const record     = (kind) => (err) => { thrown.push(`${kind}:${err.code ?? err.message}`); };
    const subset     = () => shuffled(ids).slice(0, SUBSET_SIZE);

    for (let round = 0; round < ROUNDS; round++) {
      const doomed = await disposableLinked();
      const jobs   = [];
      for (let k = 0; k < 3; k++) {
        jobs.push(writer.incrementAccess(subset(), "default").catch(record("access")));
        jobs.push(writer.incrementAccess(subset(), "default", { noEma: true }).catch(record("access_noema")));
        jobs.push(writer.touchLinked(subset(), "default", null, { allWorkspaces: true }).catch(record("touch")));
        jobs.push(worker._embedChunk(subset().map(id => ({ id, content: `db-lane ${id}` }))).catch(record("embed")));
        jobs.push(links.createLinks(linkPairs(), "default").catch(record("links")));
        jobs.push(staleKeyShare(subset().slice(0, 6)).catch(record("keyshare")));
        jobs.push(linkInsert().catch(record("link_insert")));
      }
      jobs.push(writer.deleteMany(doomed, "default").catch(record("delete_many")));
      jobs.push(gc.decayImportance().catch(record("decay")));
      jobs.push(gc.transitionTTL().catch(record("tier")));
      jobs.push(gc.decayEmaActivation().catch(record("ema")));
      jobs.push(MemoryConsolidator.prototype._promoteAnchors.call({}).catch(record("anchor")));
      await Promise.all(jobs);
    }

    await shutdownPool();
    const serverDeadlocks = await deadlockDelta(serverBase);
    const observed        = observedDeadlockStatements().slice(probeBase);
    const retries         = await retryTotal() - retryBase;
    const report          = `rounds=${ROUNDS} thrown=${JSON.stringify(thrown)} observed40P01=${JSON.stringify(observed)} ` +
                            `serverDeadlocks=${serverDeadlocks} retries=${retries}`;
    console.log(`[db-lane-mix] ${report}`);

    assert.deepEqual(thrown, [], report);
    assert.deepEqual(observed, [], report);
    assert.equal(serverDeadlocks, 0, report);
    assert.equal(retries, 0, report);
  });
});
