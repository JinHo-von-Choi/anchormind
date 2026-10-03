/**
 * 만료 GC 처리량 검사(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 실제 PostgreSQL에서 만료 후보 조건, 주기당 삭제 상한, 청크 반복, 스위치 off의 50건 한도, 보호 대상
 * 보존, 작업 기억 행 정리, 청크 잠금 대기 상한, 적체 게이지를 확인한다. 실행마다 전용 데이터베이스를
 * 만들어 쓰고 끝나면 지운다.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert                                       from "node:assert/strict";
import crypto                                       from "node:crypto";
import pg                                           from "pg";

const { prepareLaneDatabase, dropLaneDatabase, directClientConfig } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool }  = await import("../../lib/tools/db.js");
const { FragmentGC }    = await import("../../lib/memory/consolidate/FragmentGC.js");
const { gcBacklog }     = await import("../../lib/memory/consolidate/gc-metrics.js");

const TAG = `gc${Date.now().toString(36)}`;
const KEYS = ["MEMENTO_GC_THROUGHPUT", "MEMENTO_GC_MAX_DELETE_PER_CYCLE", "MEMENTO_DB_LOCK_RETRY_MAX"];

let client;

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

beforeEach(async () => {
  for (const k of KEYS) delete process.env[k];
  await client.query("DELETE FROM agent_memory.fragments");
});

/** 만료 후보 조건을 모두 만족하는 행(30일 전 생성, 무접근, utility 0.01)을 넣고 id 목록을 돌려준다. */
async function seedExpirable(count, { tier = "warm", anchor = false, ageDays = 30, utility = 0.01 } = {}) {
  const ids = Array.from({ length: count }, () => `${TAG}-${crypto.randomUUID()}`);
  await client.query(
    `INSERT INTO agent_memory.fragments
            (id, content, type, topic, importance, ttl_tier, is_anchor, agent_id, keywords, content_hash,
             utility_score, created_at, accessed_at)
     SELECT id, 'gc ' || id, 'fact', 'gc-test', 0.5, $2, $3, 'default', '{}', md5(id),
            $4, NOW() - make_interval(days => $5), NULL
       FROM unnest($1::text[]) AS id`,
    [ids, tier, anchor, utility, ageDays]
  );
  return ids;
}

const countOf = async (ids) =>
  (await client.query("SELECT count(*)::int AS n FROM agent_memory.fragments WHERE id = ANY($1)", [ids])).rows[0].n;

describe("만료 삭제의 주기당 상한과 청크 반복", () => {
  it("상한 150건이면 한 번에 150건을 지우고 다음 호출이 나머지를 지운다", async () => {
    process.env.MEMENTO_GC_MAX_DELETE_PER_CYCLE = "150";
    const ids = await seedExpirable(230);
    const gc  = new FragmentGC();

    assert.equal(await gc.deleteExpired(), 150);
    assert.equal(await countOf(ids), 80);
    assert.equal((await gcBacklog.get()).values[0].value, 80);

    assert.equal(await gc.deleteExpired(), 80);
    assert.equal(await countOf(ids), 0);
    assert.equal((await gcBacklog.get()).values[0].value, 0);

    assert.equal(await gc.deleteExpired(), 0);
  });

  it("기본 한도에서 주기당 삭제 수가 기존 50건을 넘는다", async () => {
    const ids = await seedExpirable(420);
    assert.equal(await new FragmentGC().deleteExpired(), 420);
    assert.equal(await countOf(ids), 0);
  });

  it("MEMENTO_GC_THROUGHPUT=off이면 주기당 50건만 지운다", async () => {
    process.env.MEMENTO_GC_THROUGHPUT = "off";
    const ids = await seedExpirable(120);
    assert.equal(await new FragmentGC().deleteExpired(), 50);
    assert.equal(await countOf(ids), 70);
  });

  it("utility가 낮은 행부터 지운다", async () => {
    process.env.MEMENTO_GC_THROUGHPUT = "off";
    const low  = await seedExpirable(50, { utility: 0.001 });
    const high = await seedExpirable(50, { utility: 0.1 });
    await new FragmentGC().deleteExpired();
    assert.equal(await countOf(low), 0);
    assert.equal(await countOf(high), 50);
  });
});

describe("보호 대상과 후보 조건", () => {
  it("permanent, 앵커, 유예 기간 안의 행, 분할 자식이 남은 원본은 지우지 않는다", async () => {
    const permanent = await seedExpirable(5, { tier: "permanent" });
    const anchors   = await seedExpirable(5, { anchor: true });
    const recent    = await seedExpirable(5, { ageDays: 1 });
    const [parent]  = await seedExpirable(1);
    const childId   = `${TAG}-${crypto.randomUUID()}`;
    await client.query(
      `INSERT INTO agent_memory.fragments (id, content, type, topic, importance, ttl_tier, agent_id, keywords, content_hash, source)
       VALUES ($1, 'child', 'fact', 'gc-test', 0.5, 'warm', 'default', '{}', md5($1), $2)`,
      [childId, `split:${parent}`]
    );
    const victims = await seedExpirable(7);

    assert.equal(await new FragmentGC().deleteExpired(), 7);
    assert.equal(await countOf(victims), 0);
    assert.equal(await countOf([...permanent, ...anchors, ...recent, parent, childId]), 5 + 5 + 5 + 2);
  });

  it("작업 기억 행은 24시간이 지나면 지우고 반환값은 일반 파편 삭제 수다", async () => {
    await client.query(
      `INSERT INTO agent_memory.fragments (id, content, topic, type, content_hash, source, session_id, valid_to, created_at)
       VALUES ($1, 'wm', 't', 'fact', md5($1), 'wm-fallback', 's', NOW(), NOW() - INTERVAL '30 hours'),
              ($2, 'wm', 't', 'fact', md5($2), 'wm-fallback', 's', NOW(), NOW() - INTERVAL '2 hours')`,
      [`${TAG}-old`, `${TAG}-new`]
    );
    const victims = await seedExpirable(3);
    assert.equal(await new FragmentGC().deleteExpired(), 3);
    assert.equal(await countOf(victims), 0);
    assert.equal(await countOf([`${TAG}-old`]), 0);
    assert.equal(await countOf([`${TAG}-new`]), 1);
  });
});

describe("청크 잠금 대기 상한", () => {
  it("다른 트랜잭션이 후보 행을 쥐고 있으면 잠금 대기 상한 뒤 실패한다", async () => {
    process.env.MEMENTO_DB_LOCK_RETRY_MAX = "0";
    const [held] = await seedExpirable(1, { utility: 0.0001 });
    await seedExpirable(5);
    const holder = new pg.Client(directClientConfig());
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM agent_memory.fragments WHERE id = $1 FOR UPDATE", [held]);
      const started = Date.now();
      await assert.rejects(() => new FragmentGC().deleteExpired(), (err) => err.code === "55P03");
      const waited = Date.now() - started;
      assert.ok(waited >= 2500 && waited < 8000, `대기 ${waited}ms`);
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
    assert.equal(await new FragmentGC().deleteExpired(), 6);
  });
});
