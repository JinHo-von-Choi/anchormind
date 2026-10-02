/**
 * 점수 갱신 최소 변화량 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 최소 변화량이 설정되면 변화가 그보다 작은 행은 다시 쓰지 않고(xmin 불변),
 * 감쇠는 마지막 감쇠 후 24시간이 지난 행을 변화량과 무관하게 갱신한다.
 * 설정이 없으면 모든 대상 행을 갱신한다. 실행마다 전용 데이터베이스를 만들어
 * 쓰고 끝나면 지운다.
 */
import crypto                                     from "node:crypto";
import { describe, it, before, after, afterEach } from "node:test";
import assert                                     from "node:assert/strict";
import pg                                         from "pg";

const { prepareLaneDatabase, dropLaneDatabase, directClientConfig } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool } = await import("../../lib/tools/db.js");

const RUN = `md-${crypto.randomBytes(4).toString("hex")}`;
let   client;

before(async () => {
  client = new pg.Client(directClientConfig());
  await client.connect();
});

after(async () => {
  try {
    await client.end();
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

afterEach(() => {
  delete process.env.MEMENTO_DECAY_MIN_DELTA;
  delete process.env.MEMENTO_UTILITY_MIN_DELTA;
  delete process.env.MEMENTO_SCORE_UPDATE_BATCH;
});

/** 감쇠 시험 행 4개: 직전 감쇠(변화 미미), 30일 전 감쇠(변화 큼), 25시간 전 감쇠(변화 미미, 24시간 초과), 하한 행(직전 감쇠) */
async function seedDecay(tag) {
  const rows = [
    [`${RUN}-${tag}-recent`, 0.5,  "1 minute"],
    [`${RUN}-${tag}-old`,    0.5,  "30 days"],
    [`${RUN}-${tag}-stale`,  0.06, "25 hours"],
    [`${RUN}-${tag}-floor`,  0.05, "1 minute"]
  ];
  for (const [id, importance, ago] of rows) {
    await client.query(
      `INSERT INTO agent_memory.fragments
         (id, content, topic, type, content_hash, ttl_tier, importance, last_decay_at)
       VALUES ($1, $1, 't', 'fact', md5($1), 'cold', $2, NOW() - $3::interval)`,
      [id, importance, ago]);
  }
}

async function xmins(tag) {
  const { rows } = await client.query(
    `SELECT id, xmin::text AS x FROM agent_memory.fragments WHERE id LIKE $1 ORDER BY id`, [`${RUN}-${tag}-%`]);
  return Object.fromEntries(rows.map(r => [r.id.split("-").pop(), r.x]));
}

/** utility 시험 행: 저장값이 계산값에 offset을 더한 값. 30일 미만이라 계산값이 시각에 의존하지 않는다. */
async function seedUtility(tag, offsets) {
  for (const [name, offset] of Object.entries(offsets)) {
    await client.query(
      `INSERT INTO agent_memory.fragments
         (id, content, topic, type, content_hash, ttl_tier, importance, access_count, created_at, utility_score)
       VALUES ($1, $1, 't', 'fact', md5($1), 'cold', 0.4, 3, NOW() - INTERVAL '3 days', (0.4 * (1 + LN(3)) + $2)::real)`,
      [`${RUN}-${tag}-${name}`, offset]);
  }
}

describe("최소 변화량", () => {
  it("감쇠: 변화가 작고 24시간이 안 된 행만 건너뛴다", async () => {
    const tag = "d1";
    await seedDecay(tag);
    const before = await xmins(tag);
    process.env.MEMENTO_DECAY_MIN_DELTA = "0.01";
    const { FragmentGC } = await import("../../lib/memory/consolidate/FragmentGC.js");
    await new FragmentGC().decayImportance();
    const after = await xmins(tag);
    assert.equal(after.recent, before.recent, "변화가 미미한 행은 다시 쓰지 않는다");
    assert.equal(after.floor, before.floor, "하한 행은 24시간 안에는 다시 쓰지 않는다");
    assert.notEqual(after.old, before.old, "변화가 큰 행은 갱신한다");
    assert.notEqual(after.stale, before.stale, "24시간이 지난 행은 갱신한다");
  });

  it("감쇠: 아주 작은 최소 변화량에서도 하한 행을 다시 쓰지 않는다", async () => {
    const tag = "d2";
    await seedDecay(tag);
    const before = await xmins(tag);
    process.env.MEMENTO_DECAY_MIN_DELTA = "1e-10";
    const { FragmentGC } = await import("../../lib/memory/consolidate/FragmentGC.js");
    await new FragmentGC().decayImportance();
    const after = await xmins(tag);
    assert.equal(after.floor, before.floor);
  });

  it("감쇠: 설정이 없으면 모든 대상 행을 갱신한다", async () => {
    const tag = "d3";
    await seedDecay(tag);
    const before = await xmins(tag);
    const { FragmentGC } = await import("../../lib/memory/consolidate/FragmentGC.js");
    await new FragmentGC().decayImportance();
    const after = await xmins(tag);
    assert.notEqual(after.recent, before.recent);
  });

  it("utility: 저장값과의 차이가 최소 변화량 이하인 행은 다시 쓰지 않는다", async () => {
    const tag = "u1";
    await seedUtility(tag, { near: 0.001, far: 0.5 });
    const before = await xmins(tag);
    process.env.MEMENTO_UTILITY_MIN_DELTA = "0.01";
    const { MemoryConsolidator } = await import("../../lib/memory/consolidate/MemoryConsolidator.js");
    await MemoryConsolidator.prototype._updateUtilityScores.call({});
    const after = await xmins(tag);
    assert.equal(after.near, before.near);
    assert.notEqual(after.far, before.far);
  });

  it("utility: 아주 작은 최소 변화량에서도 계산값과 같은 행은 다시 쓰지 않는다", async () => {
    const tag = "u2";
    await seedUtility(tag, { same: 0, far: 0.5 });
    const { MemoryConsolidator } = await import("../../lib/memory/consolidate/MemoryConsolidator.js");
    await MemoryConsolidator.prototype._updateUtilityScores.call({});
    const before = await xmins(tag);
    process.env.MEMENTO_UTILITY_MIN_DELTA = "1e-9";
    await MemoryConsolidator.prototype._updateUtilityScores.call({});
    const after = await xmins(tag);
    assert.equal(after.same, before.same);
    assert.equal(after.far, before.far);
  });
});
