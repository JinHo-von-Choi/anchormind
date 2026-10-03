/**
 * forget 삭제 연쇄와 고아 사본 정리의 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 실제 행으로 다음을 확인한다.
 *   - forget이 지운 파편을 출처로 한 case_events 요약이 남지 않는다(자료 정합: 삭제 id 참조 요약 0)
 *   - 서버가 기록한 모순 해소 파편(topic contradiction_audit, key_id 없음)이 함께 지워지고, 남은 파편의
 *     linked_to와 fragment_links에 지운 id가 남지 않는다
 *   - 키 범위 밖의 대상과 키가 있는 같은 topic 파편은 건드리지 않는다
 *   - 같은 모순 해소 파편을 가진 두 대상을 동시에 지워도 교착 없이 한 번만 지운다
 *   - 스위치를 끄면 요약이 남고, 정리 스크립트의 함수가 그 고아 요약만 바꾼다
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert                                      from "node:assert/strict";
import crypto                                      from "node:crypto";

process.env.EMBEDDING_BASE_URL = "http://127.0.0.1:9";

const {
  SCHEMA, prepareLaneDatabase, dropLaneDatabase, directQuery,
  installDeadlockProbe, uninstallDeadlockProbe, observedDeadlockStatements
} = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool, getPrimaryPool } = await import("../../lib/tools/db.js");
const { MemoryManager }                = await import("../../lib/memory/MemoryManager.js");
const { FragmentWriter }               = await import("../../lib/memory/write/FragmentWriter.js");
const {
  DELETED_SUMMARY, CONTRADICTION_AUDIT_TOPIC, purgeOrphanCaseSummaries
} = await import("../../lib/memory/write/ForgetCascade.js");

const KEY_A = "fc-key-a";
const KEY_B = "fc-key-b";
const mm    = new MemoryManager();

/** 이 시험의 파편 id */
const fid = () => `fc-${crypto.randomUUID()}`;

/**
 * 파편 한 행을 넣는다.
 *
 * @param {{id: string, content: string, topic?: string, type?: string, keyId?: string|null, linkedTo?: string[]}} row
 */
async function insertFragment({ id, content, topic = "fc-topic", type = "fact", keyId = null, linkedTo = [] }) {
  await directQuery(
    `INSERT INTO ${SCHEMA}.fragments
            (id, content, topic, type, importance, ttl_tier, agent_id, keywords, content_hash, key_id, linked_to)
     VALUES ($1, $2, $3, $4, 0.5, 'warm', 'default', '{}', md5($1), $5, $6::text[])`,
    [id, content, topic, type, keyId, linkedTo]
  );
  return id;
}

/**
 * case_events 한 행을 넣고 event_id를 돌려준다.
 *
 * @param {string} sourceId
 * @param {string} summary
 */
async function insertEvent(sourceId, summary) {
  const { rows } = await directQuery(
    `INSERT INTO ${SCHEMA}.case_events (case_id, event_type, summary, source_fragment_id)
     VALUES ('fc-case', 'decision_committed', $2, $1) RETURNING event_id`,
    [sourceId, summary]
  );
  return rows[0].event_id;
}

/** 지운 id를 출처로 하면서 대체 값이 아닌 요약 수(자료 정합 검사) */
async function leakedSummaries(ids) {
  const { rows } = await directQuery(
    `SELECT count(*)::int AS n FROM ${SCHEMA}.case_events
      WHERE source_fragment_id = ANY($1::text[]) AND summary IS DISTINCT FROM $2`,
    [ids, DELETED_SUMMARY]
  );
  return rows[0].n;
}

/** 지운 id를 아직 가리키는 linked_to, fragment_links, 남은 행 수 */
async function danglingRefs(ids) {
  const { rows } = await directQuery(
    `SELECT (SELECT count(*)::int FROM ${SCHEMA}.fragments WHERE id = ANY($1::text[]))           AS rows_left,
            (SELECT count(*)::int FROM ${SCHEMA}.fragments WHERE linked_to && $1::text[])         AS linked_to_refs,
            (SELECT count(*)::int FROM ${SCHEMA}.fragment_links
              WHERE from_id = ANY($1::text[]) OR to_id = ANY($1::text[]))                         AS link_rows`,
    [ids]
  );
  return rows[0];
}

/**
 * 대상(T, 키 A), 이긴 쪽(W, 키 A), 서버 모순 해소 기록(A, key_id 없음, linked_to [W, T]),
 * 키가 있는 같은 topic 파편(A2), T와 무관한 서버 해소 기록(A3), 출처 이벤트를 넣는다.
 */
async function seedContradiction() {
  const t  = await insertFragment({ id: fid(), content: "fc 대상 파편 본문 사본 확인용 문장", keyId: KEY_A });
  const w  = await insertFragment({ id: fid(), content: "fc 이긴 파편 본문", keyId: KEY_A });
  const a  = await insertFragment({
    id: fid(), content: "[모순 해결] \"fc 대상 파편 본문 사본 확인용 문장\" 파편이 대체됨",
    topic: CONTRADICTION_AUDIT_TOPIC, type: "decision", keyId: null, linkedTo: [w, t]
  });
  const a2 = await insertFragment({ id: fid(), content: "fc 키 소유 같은 topic", topic: CONTRADICTION_AUDIT_TOPIC, keyId: KEY_B, linkedTo: [t] });
  const a3 = await insertFragment({ id: fid(), content: "fc 무관한 해소 기록", topic: CONTRADICTION_AUDIT_TOPIC, linkedTo: [w] });
  await directQuery(`UPDATE ${SCHEMA}.fragments SET linked_to = ARRAY[$2::text] WHERE id = $1`, [w, a]);
  await directQuery(
    `INSERT INTO ${SCHEMA}.fragment_links (from_id, to_id, relation_type)
     VALUES ($1, $2, 'related'), ($3, $2, 'superseded_by')`,
    [a, w, t]
  );
  const e1 = await insertEvent(t, "fc 대상 파편 본문 사본 확인용 문장");
  const e2 = await insertEvent(t, "fc 대상 파편 본문 두 번째 사본");
  const e3 = await insertEvent(w, "fc 이긴 파편 본문");
  await directQuery(
    `INSERT INTO ${SCHEMA}.fragment_evidence (fragment_id, event_id, kind) VALUES ($1, $2, 'produced_by')`,
    [t, e1]
  );
  return { t, w, a, a2, a3, e1, e2, e3 };
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

describe("forget 삭제 연쇄(실제 행)", () => {
  const saved = process.env.MEMENTO_FORGET_CASCADE;
  beforeEach(() => { delete process.env.MEMENTO_FORGET_CASCADE; });
  after(() => {
    if (saved === undefined) delete process.env.MEMENTO_FORGET_CASCADE;
    else process.env.MEMENTO_FORGET_CASCADE = saved;
  });

  it("migration-054 색인이 유효하게 있다", async () => {
    const { rows } = await directQuery(
      `SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'idx_ce_source_fragment_id'`
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].valid, true);
    assert.match(rows[0].def, /\(source_fragment_id\) WHERE \(source_fragment_id IS NOT NULL\)/);
  });

  it("id forget이 요약을 바꾸고 서버 해소 기록을 지우며 영수증을 돌려준다", async () => {
    const s   = await seedContradiction();
    const res = await mm.forget({ id: s.t, agentId: "default", _keyId: KEY_A, _groupKeyIds: [KEY_A] });

    assert.equal(res.deleted, 1);
    assert.deepEqual(res.purged, { case_summaries: 2, audit_fragments: 1 });

    assert.equal(await leakedSummaries([s.t, s.a]), 0);
    const refs = await danglingRefs([s.t, s.a]);
    assert.deepEqual(refs, { rows_left: 0, linked_to_refs: 0, link_rows: 0 });

    const { rows } = await directQuery(
      `SELECT event_id, summary FROM ${SCHEMA}.case_events WHERE event_id = ANY($1::uuid[])`,
      [[s.e1, s.e2, s.e3]]
    );
    const summary = Object.fromEntries(rows.map(r => [r.event_id, r.summary]));
    assert.equal(summary[s.e1], DELETED_SUMMARY);
    assert.equal(summary[s.e2], DELETED_SUMMARY);
    assert.equal(summary[s.e3], "fc 이긴 파편 본문");

    const left = await directQuery(
      `SELECT id FROM ${SCHEMA}.fragments WHERE id = ANY($1::text[]) ORDER BY id`, [[s.w, s.a2, s.a3]]
    );
    assert.deepEqual(left.rows.map(r => r.id), [s.w, s.a2, s.a3].sort());
  });

  it("다시 forget하면 이미 없는 대상으로 응답하고 아무것도 바꾸지 않는다", async () => {
    const s = await seedContradiction();
    await mm.forget({ id: s.t, _keyId: KEY_A, _groupKeyIds: [KEY_A] });
    const again = await mm.forget({ id: s.t, _keyId: KEY_A, _groupKeyIds: [KEY_A] });
    assert.equal(again.deleted, 0);
    assert.equal(again.error, undefined);
  });

  it("키 범위 밖의 대상은 지우지 않고 요약과 해소 기록도 그대로 둔다", async () => {
    const s   = await seedContradiction();
    const out = await new FragmentWriter().deleteWithCascade([s.t], "default", KEY_B);

    assert.deepEqual(out, { deleted: 0, purged: { case_summaries: 0, audit_fragments: 0 } });
    assert.equal(await leakedSummaries([s.t]), 2);
    const { rows } = await directQuery(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.fragments WHERE id = ANY($1::text[])`, [[s.t, s.a]]
    );
    assert.equal(rows[0].n, 2);
  });

  it("topic forget은 대상 여러 개의 요약을 한 트랜잭션에서 바꾼다", async () => {
    const topic = `fc-topic-${crypto.randomUUID().slice(0, 8)}`;
    const ids   = [];
    for (let i = 0; i < 3; i++) {
      const id = await insertFragment({ id: fid(), content: `fc topic 본문 ${i}`, topic, keyId: KEY_A });
      await insertEvent(id, `fc topic 본문 ${i}`);
      ids.push(id);
    }
    const res = await mm.forget({ topic, _keyId: KEY_A, _groupKeyIds: [KEY_A] });

    assert.equal(res.deleted, 3);
    assert.deepEqual(res.purged, { case_summaries: 3, audit_fragments: 0 });
    assert.equal(await leakedSummaries(ids), 0);
  });

  it("같은 해소 기록을 가진 두 대상을 동시에 지워도 교착 없이 한 번만 지운다", async () => {
    installDeadlockProbe();
    try {
      for (let round = 0; round < 8; round++) {
        const t1 = await insertFragment({ id: fid(), content: `fc 동시 1 ${round}`, keyId: KEY_A });
        const t2 = await insertFragment({ id: fid(), content: `fc 동시 2 ${round}`, keyId: KEY_A });
        const a  = await insertFragment({
          id: fid(), content: `fc 동시 해소 ${round}`, topic: CONTRADICTION_AUDIT_TOPIC, linkedTo: [t1, t2]
        });
        await insertEvent(t1, "fc 동시 사본 1");
        await insertEvent(t2, "fc 동시 사본 2");

        const writer = new FragmentWriter();
        const [r1, r2] = await Promise.all([
          writer.deleteWithCascade([t1], "default", KEY_A),
          writer.deleteWithCascade([t2], "default", KEY_A)
        ]);

        assert.equal(r1.deleted + r2.deleted, 2);
        assert.equal(r1.purged.audit_fragments + r2.purged.audit_fragments, 1);
        assert.equal(await leakedSummaries([t1, t2, a]), 0);
        assert.deepEqual(await danglingRefs([t1, t2, a]), { rows_left: 0, linked_to_refs: 0, link_rows: 0 });
      }
      assert.deepEqual(observedDeadlockStatements(), []);
    } finally {
      uninstallDeadlockProbe();
    }
  });
});

describe("스위치 off와 고아 사본 정리(실제 행)", () => {
  const saved = process.env.MEMENTO_FORGET_CASCADE;
  after(() => {
    if (saved === undefined) delete process.env.MEMENTO_FORGET_CASCADE;
    else process.env.MEMENTO_FORGET_CASCADE = saved;
  });

  it("off이면 요약과 해소 기록이 남고, 정리 함수가 원본 없는 요약만 바꾼다", async () => {
    process.env.MEMENTO_FORGET_CASCADE = "off";
    const s   = await seedContradiction();
    const res = await mm.forget({ id: s.t, _keyId: KEY_A, _groupKeyIds: [KEY_A] });
    assert.equal(res.deleted, 1);
    assert.equal(Object.hasOwn(res, "purged"), false);
    assert.equal(await leakedSummaries([s.t]), 2);

    const pool    = getPrimaryPool();
    const preview = await purgeOrphanCaseSummaries(pool);
    assert.equal(preview.mode, "dry-run");
    assert.ok(preview.orphans >= 2);
    assert.ok(preview.sample_event_ids.includes(String(s.e1)));
    assert.equal(await leakedSummaries([s.t]), 2, "미리보기는 바꾸지 않는다");

    const done = await purgeOrphanCaseSummaries(pool, { execute: true, batchSize: 1 });
    assert.equal(done.mode, "execute");
    assert.equal(done.updated, preview.orphans);
    assert.equal(await leakedSummaries([s.t]), 0);

    const { rows } = await directQuery(
      `SELECT summary FROM ${SCHEMA}.case_events WHERE event_id = $1`, [s.e3]
    );
    assert.equal(rows[0].summary, "fc 이긴 파편 본문", "원본이 있는 요약은 그대로다");
    assert.equal((await purgeOrphanCaseSummaries(pool)).orphans, 0);
  });
});
