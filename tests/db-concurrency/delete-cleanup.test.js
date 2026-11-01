/**
 * 삭제 뒤 정리와 topic forget 범위의 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-11-02
 *
 * 단위 시험 대역은 조회가 돌려줄 열을 시험이 채워 주므로, 실제 SQL이 그 열을 읽는지 확인하지 못한다
 * (topic 조회가 ttl_tier를 읽지 않아 permanent 보호가 동작하지 않은 결함이 그렇게 통과했다).
 * 실제 행으로 다음을 확인한다.
 *   - 만료 삭제(GC)가 다른 파편 linked_to의 참조, 사례 요약 사본, 묶음 요약을 forget과 같이 정리한다
 *   - 죽은 참조 정리가 없는 id만 지우고 남은 참조의 순서를 지킨다
 *   - topic forget은 force 없이 permanent를 남기고, 그룹의 다른 키 파편은 고르지도 지우지도 않는다
 *   - getByIds가 affect와 key_id를 읽는다
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert                                      from "node:assert/strict";
import crypto                                      from "node:crypto";

process.env.EMBEDDING_BASE_URL = "http://127.0.0.1:9";

const { SCHEMA, prepareLaneDatabase, dropLaneDatabase, directQuery } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool }        = await import("../../lib/tools/db.js");
const { MemoryManager }       = await import("../../lib/memory/MemoryManager.js");
const { FragmentStore }       = await import("../../lib/memory/write/FragmentStore.js");
const { FragmentGC, gcCandidateParams } = await import("../../lib/memory/consolidate/FragmentGC.js");
const { DELETED_SUMMARY }     = await import("../../lib/memory/write/ForgetCascade.js");

const KEY_A = "dc-key-a";
const KEY_B = "dc-key-b";
const mm    = new MemoryManager();
const store = new FragmentStore();

const fid = () => `dc-${crypto.randomUUID()}`;

/**
 * 파편 한 행을 넣는다. 기본값은 GC 후보가 되지 않는 최근 파편이다.
 *
 * @param {Object} row
 */
async function insertFragment({ id = fid(), content, topic = "dc-topic", type = "fact", keyId = null, linkedTo = [],
  ttlTier = "warm", importance = 0.5, utility = 1, ageDays = 0, affect = "neutral" }) {
  await directQuery(
    `INSERT INTO ${SCHEMA}.fragments
            (id, content, topic, type, importance, ttl_tier, agent_id, keywords, content_hash, key_id, linked_to,
             utility_score, created_at, affect)
     VALUES ($1, $2, $3, $4, $5, $6, 'default', '{}', md5($1), $7, $8::text[], $9,
             now() - make_interval(days => $10), $11)`,
    [id, content ?? `dc 본문 ${id}`, topic, type, importance, ttlTier, keyId, linkedTo, utility, ageDays, affect]
  );
  return id;
}

before(async () => {
  for (const id of [KEY_A, KEY_B]) {
    await directQuery(
      `INSERT INTO ${SCHEMA}.api_keys (id, name, key_hash, key_prefix) VALUES ($1, $1, md5($1), left($1, 8))`,
      [id]
    );
  }
});

after(async () => {
  try {
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

describe("삭제 뒤 정리(실제 행)", () => {
  it("만료 삭제가 linked_to 참조, 사례 요약 사본, 묶음 요약을 정리한다", async () => {
    const gone = await insertFragment({ content: "dc 만료될 파편 본문", importance: 0.1, utility: 0.05, ageDays: 120 });
    const keep = await insertFragment({ content: "dc 남는 파편", linkedTo: [gone] });
    await directQuery(
      `INSERT INTO ${SCHEMA}.case_events (case_id, event_type, summary, source_fragment_id)
       VALUES ('dc-case', 'decision_committed', 'dc 만료될 파편 본문', $1)`, [gone]);
    await directQuery(
      `INSERT INTO ${SCHEMA}.fragment_digest (kind, subject, content, source_ids, source_hash, item_count)
       VALUES ('topic_timeline', 'dc-topic', 'dc 묶음 요약', ARRAY[$1, $2]::text[], md5($1), 2)`, [gone, keep]);

    await new FragmentGC()._deleteExpiredChunk(gcCandidateParams(), 50);

    const { rows: [state] } = await directQuery(
      `SELECT (SELECT count(*)::int FROM ${SCHEMA}.fragments WHERE id = $1)                                AS rows_left,
              (SELECT linked_to FROM ${SCHEMA}.fragments WHERE id = $2)                                    AS keep_linked,
              (SELECT count(*)::int FROM ${SCHEMA}.case_events
                WHERE source_fragment_id = $1 AND summary IS DISTINCT FROM $3)                             AS leaked,
              (SELECT count(*)::int FROM ${SCHEMA}.fragment_digest WHERE source_ids && ARRAY[$1]::text[])  AS digests`,
      [gone, keep, DELETED_SUMMARY]);
    assert.equal(state.rows_left, 0, "만료 후보가 지워져야 한다");
    assert.deepEqual(state.keep_linked, []);
    assert.equal(state.leaked, 0);
    assert.equal(state.digests, 0);
  });

  it("죽은 참조 정리는 없는 id만 지우고 남은 참조의 순서를 지킨다", async () => {
    const live1 = await insertFragment({ content: "dc 살아 있는 1" });
    const live2 = await insertFragment({ content: "dc 살아 있는 2" });
    const owner = await insertFragment({ content: "dc 참조를 가진 파편", linkedTo: [live2, "dc-missing-1", live1, "dc-missing-2"] });

    const dry = await store.sweepDeadReferences({ dryRun: true });
    assert.ok(dry.references >= 2);
    const { rows: [before] } = await directQuery(`SELECT linked_to FROM ${SCHEMA}.fragments WHERE id = $1`, [owner]);
    assert.equal(before.linked_to.length, 4, "dryRun은 고치지 않는다");

    const out = await store.sweepDeadReferences({ batch: 2 });
    assert.ok(out.references >= 2);
    const { rows: [after] } = await directQuery(`SELECT linked_to FROM ${SCHEMA}.fragments WHERE id = $1`, [owner]);
    assert.deepEqual(after.linked_to, [live2, live1]);
  });
});

describe("topic forget 범위(실제 행)", () => {
  const saved = process.env.MEMENTO_FORGET_CASCADE;
  beforeEach(() => { delete process.env.MEMENTO_FORGET_CASCADE; });
  after(() => {
    if (saved === undefined) delete process.env.MEMENTO_FORGET_CASCADE;
    else process.env.MEMENTO_FORGET_CASCADE = saved;
  });

  it("force 없이는 permanent를 남기고 protected로 센다(조회가 ttl_tier를 읽는다)", async () => {
    const topic = `dc-perm-${crypto.randomUUID()}`;
    const warm  = await insertFragment({ topic, keyId: KEY_A, importance: 0.9 });
    const perm  = await insertFragment({ topic, keyId: KEY_A, importance: 0.95, ttlTier: "permanent" });

    const dry = await mm.forget({ topic, dryRun: true, _keyId: KEY_A, _groupKeyIds: [KEY_A] });
    assert.deepEqual(dry.simulated.fragment_ids, [warm]);
    assert.equal(dry.simulated.protected, 1);

    const res = await mm.forget({ topic, _keyId: KEY_A, _groupKeyIds: [KEY_A] });
    assert.equal(res.deleted, 1);
    assert.equal(res.protected, 1);
    const { rows } = await directQuery(`SELECT id FROM ${SCHEMA}.fragments WHERE topic = $1`, [topic]);
    assert.deepEqual(rows.map(r => r.id), [perm]);
  });

  it("그룹의 다른 키 파편은 미리보기에도 실제 삭제에도 들어가지 않는다", async () => {
    const topic = `dc-group-${crypto.randomUUID()}`;
    const mine  = await insertFragment({ topic, keyId: KEY_A });
    const other = await insertFragment({ topic, keyId: KEY_B });

    const dry = await mm.forget({ topic, dryRun: true, _keyId: KEY_A, _groupKeyIds: [KEY_A, KEY_B] });
    assert.deepEqual(dry.simulated.fragment_ids, [mine]);

    const res = await mm.forget({ topic, _keyId: KEY_A, _groupKeyIds: [KEY_A, KEY_B] });
    assert.equal(res.deleted, 1);
    const { rows } = await directQuery(`SELECT id FROM ${SCHEMA}.fragments WHERE topic = $1`, [topic]);
    assert.deepEqual(rows.map(r => r.id), [other]);

    const byId = await mm.forget({ id: other, _keyId: KEY_A, _groupKeyIds: [KEY_A, KEY_B] });
    assert.equal(byId.deleted, 0);
    assert.match(byId.error, /No permission/);
  });
});

describe("조회 투영(실제 행)", () => {
  it("getByIds가 affect와 key_id를 읽는다", async () => {
    const id = await insertFragment({ keyId: KEY_A, affect: "frustration" });
    const [row] = await store.getByIds([id], "default", KEY_A);
    assert.equal(row.affect, "frustration");
    assert.equal(row.key_id, KEY_A);
  });
});
