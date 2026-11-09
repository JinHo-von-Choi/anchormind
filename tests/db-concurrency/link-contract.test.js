/**
 * 링크 계약 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-11-09
 *
 * 실제 PostgreSQL에서 사이클 탐색 기준, 지운 링크의 복구 규칙, 관계 등급, unlink 계약을 확인한다.
 */

import { describe, it, after } from "node:test";
import assert                  from "node:assert/strict";
import crypto                  from "node:crypto";
import pg                      from "pg";

const {
  SCHEMA, prepareLaneDatabase, dropLaneDatabase, seedFragments, directQuery, directClientConfig
} = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { LinkStore, resolveStoredRelation } = await import("../../lib/memory/link/LinkStore.js");
const { FragmentStore }  = await import("../../lib/memory/write/FragmentStore.js");
const { GraphLinker }    = await import("../../lib/memory/link/GraphLinker.js");
const { MemoryLinker }   = await import("../../lib/memory/processors/MemoryLinker.js");
const { mergeDedupPair } = await import("../../lib/memory/consolidate/SemanticDedup.js");
const { shutdownPool }   = await import("../../lib/tools/db.js");

const topic  = `db-lane-link-${crypto.randomUUID().slice(0, 8)}`;
const store  = new LinkStore();
const linker = new MemoryLinker({ store: new FragmentStore(), index: {} });

after(async () => {
  try {
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

async function linkRow(fromId, toId) {
  const { rows } = await directQuery(
    `SELECT relation_type, weight, deleted_at, delete_reason FROM ${SCHEMA}.fragment_links WHERE from_id = $1 AND to_id = $2`,
    [fromId, toId]
  );
  return rows[0] ?? null;
}

async function seedKey() {
  const key = `lane-${crypto.randomUUID()}`;
  await directQuery(`INSERT INTO ${SCHEMA}.api_keys (id, name, key_hash, key_prefix) VALUES ($1, $1, md5($1), left($1, 8))`, [key]);
  return key;
}

describe("isReachable", () => {
  it("활성 방향 링크만 정방향으로 따라간다", async () => {
    const [a, b, c, d, e, f] = await seedFragments(topic, 6);
    await store.createLink(a, b, "caused_by");
    await store.createLink(b, c, "resolved_by");
    await store.createLink(c, d, "related");
    await store.createLink(a, e, "caused_by");
    await store.softDeleteLink(a, e, "caused_by");
    await directQuery(`UPDATE ${SCHEMA}.fragments SET linked_to = ARRAY[$2::text] WHERE id = $1`, [a, f]);

    assert.equal(await store.isReachable(a, c), true, "방향 링크 경로");
    assert.equal(await store.isReachable(c, a), false, "역방향은 따라가지 않는다");
    assert.equal(await store.isReachable(a, d), false, "무방향 관계는 따라가지 않는다");
    assert.equal(await store.isReachable(a, e), false, "지운 링크는 따라가지 않는다");
    assert.equal(await store.isReachable(a, f), false, "linked_to 값은 따라가지 않는다");
  });

  it("사이클이 있어도 끝나고, 다른 키 파편은 경유하지 않는다", async () => {
    const [a, b, c, target] = await seedFragments(topic, 4);
    await store.createLink(a, b, "caused_by");
    await store.createLink(b, a, "caused_by");
    assert.equal(await store.isReachable(a, target), false);

    const [keyA, keyB] = [await seedKey(), await seedKey()];
    await directQuery(`UPDATE ${SCHEMA}.fragments SET key_id = $2 WHERE id = ANY($1::text[])`, [[c, target], keyA]);
    await directQuery(`UPDATE ${SCHEMA}.fragments SET key_id = $2 WHERE id = $1`, [b, keyB]);
    await store.createLink(c, b, "caused_by");
    await store.createLink(b, target, "caused_by");
    assert.equal(await store.isReachable(c, target, "default", keyA), false, "다른 키 파편을 지나는 경로");
    assert.equal(await store.isReachable(c, target, "default", null), true, "master는 전체 경로");
  });
});

describe("지운 링크의 복구 규칙", () => {
  it("unlink로 지운 행은 자동 경로가 되살리지 않는다", async () => {
    const [a, b] = await seedFragments(topic, 2);
    await store.createLink(a, b, "related");
    assert.equal(await store.softDeleteLink(a, b, "related"), true);

    assert.equal(await store.createLink(a, b, "related"), null, "단건 자동 링크");
    assert.deepEqual(await store.createLinks([{ fromId: a, toId: b, relationType: "caused_by" }]), [], "일괄 자동 링크");
    await new GraphLinker().buildCoRetrievalLinks([a, b], "s", "default");
    assert.ok((await linkRow(a, b)).deleted_at, "함께 회상 링크");
  });

  it("공개 link와 시스템 사실 관계는 되살린다", async () => {
    const [a, b, c, d] = await seedFragments(topic, 4);
    await store.createLink(a, b, "related", "default", 1);
    await store.softDeleteLink(a, b, "related");
    assert.equal(await store.createLink(a, b, "caused_by", "default", 1, { reviveUnlinked: true }), "caused_by");
    const revived = await linkRow(a, b);
    assert.equal(revived.deleted_at, null);
    assert.equal(revived.delete_reason, null);

    await store.createLink(c, d, "related");
    await store.softDeleteLink(c, d, "related");
    assert.equal(await store.createLink(c, d, "superseded_by"), "superseded_by");
    assert.equal((await linkRow(c, d)).deleted_at, null);
  });

  it("다른 사유로 지운 행은 지금처럼 되살린다", async () => {
    const [a, b] = await seedFragments(topic, 2);
    await store.createLink(a, b, "related");
    await directQuery(`UPDATE ${SCHEMA}.fragment_links SET deleted_at = NOW(), delete_reason = 'repair' WHERE from_id = $1`, [a]);
    assert.equal(await store.createLink(a, b, "related"), "related");
    assert.equal((await linkRow(a, b)).deleted_at, null);
  });

  it("가져오기는 일반 삭제 행을 되살리고 활성 행과 unlink 행은 건드리지 않는다", async () => {
    const [a, b, c, d, e, f] = await seedFragments(topic, 6);
    await store.createLink(a, b, "related");
    await directQuery(`UPDATE ${SCHEMA}.fragment_links SET deleted_at = NOW(), delete_reason = 'repair' WHERE from_id = $1`, [a]);
    await store.createLink(c, d, "related");
    await store.softDeleteLink(c, d, "related");
    await store.createLink(e, f, "related");

    const restore = async (from_id, to_id) => {
      const client = new pg.Client(directClientConfig());
      await client.connect();
      try {
        return await store.restoreLink(client, { from_id, to_id, relation_type: "caused_by", weight: 2, confidence: 0.9, decay_rate: 0.01 });
      } finally {
        await client.end();
      }
    };

    assert.deepEqual(await restore(a, b), { created: true });
    assert.equal((await linkRow(a, b)).relation_type, "caused_by");
    assert.equal((await linkRow(a, b)).deleted_at, null);
    assert.deepEqual(await restore(c, d), { created: false });
    assert.ok((await linkRow(c, d)).deleted_at);
    assert.deepEqual(await restore(e, f), { created: false });
    assert.equal((await linkRow(e, f)).relation_type, "related");
  });

  it("의미 중복 병합은 지운 행에 막히지 않고 활성 간선을 승계자로 옮기며 unlink 행은 존중한다", async () => {
    const [keep, old, x, y] = await seedFragments(topic, 4);
    await store.createLink(old, x, "caused_by");
    await store.createLink(keep, x, "related");
    await directQuery(`UPDATE ${SCHEMA}.fragment_links SET deleted_at = NOW(), delete_reason = 'repair' WHERE from_id = $1 AND to_id = $2`, [keep, x]);
    await store.createLink(old, y, "caused_by");
    await store.createLink(keep, y, "related");
    await store.softDeleteLink(keep, y, "related");

    assert.equal((await mergeDedupPair(keep, old)).merged, true);

    const moved = await linkRow(keep, x);
    assert.equal(moved.relation_type, "caused_by");
    assert.equal(moved.deleted_at, null);
    assert.ok((await linkRow(keep, y)).deleted_at, "unlink로 지운 쌍은 그대로다");
  });
});

describe("관계 등급", () => {
  it("보호 관계는 낮은 관계로 덮이지 않고 저장된 관계를 돌려준다", async () => {
    const [a, b, c, d] = await seedFragments(topic, 4);
    await store.createLink(a, b, "superseded_by");
    assert.equal(await store.createLink(a, b, "caused_by"), "superseded_by");
    assert.equal(await store.createLink(a, b, "contradicts"), "superseded_by");

    await store.createLink(c, d, "contradicts");
    assert.equal(await store.createLink(c, d, "resolved_by"), "contradicts");
    assert.equal(await store.createLink(c, d, "superseded_by"), "superseded_by", "모순 해소 전환");
  });

  it("resolveStoredRelation은 저장 결과와 같다", () => {
    assert.equal(resolveStoredRelation(null, "related"), "related");
    assert.equal(resolveStoredRelation("superseded_by", "caused_by"), "superseded_by");
    assert.equal(resolveStoredRelation("related", "caused_by"), "caused_by");
  });
});

describe("link 응답", () => {
  it("기존 관계가 유지되면 실제 관계를 돌려주고 importance를 내리지 않는다", async () => {
    const [err, sol] = await seedFragments(topic, 2, "error");
    await directQuery(`UPDATE ${SCHEMA}.fragments SET importance = 0.8 WHERE id = $1`, [err]);
    await store.createLink(err, sol, "superseded_by");

    const dry = await linker.link({ fromId: err, toId: sol, relationType: "resolved_by", dryRun: true });
    assert.equal(dry.simulated.relationType, "superseded_by");
    assert.equal(dry.simulated.requestedRelationType, "resolved_by");

    const res = await linker.link({ fromId: err, toId: sol, relationType: "resolved_by" });
    assert.deepEqual(res, { linked: true, relationType: "superseded_by", requestedRelationType: "resolved_by" });
    const { rows } = await directQuery(`SELECT importance FROM ${SCHEMA}.fragments WHERE id = $1`, [err]);
    assert.equal(Number(rows[0].importance), 0.8);
  });

  it("unlink한 링크를 link로 다시 걸 수 있다", async () => {
    const [a, b] = await seedFragments(topic, 2);
    await linker.link({ fromId: a, toId: b, relationType: "related" });
    await linker.unlink({ fromId: a, toId: b, relationType: "related" });
    assert.deepEqual(await linker.link({ fromId: a, toId: b, relationType: "related" }), { linked: true, relationType: "related" });
    assert.equal((await linkRow(a, b)).deleted_at, null);
  });
});

describe("unlink", () => {
  it("선택한 방향의 간선만 지우고 파편과 다른 간선을 바꾸지 않으며 이력을 남긴다", async () => {
    const [a, b, c] = await seedFragments(topic, 3);
    await store.createLink(a, b, "caused_by", "default", 0.7);
    await store.createLink(b, a, "related");
    await store.createLink(a, c, "related");
    const before = await directQuery(`SELECT id, importance, valid_to FROM ${SCHEMA}.fragments WHERE id = ANY($1::text[]) ORDER BY id`, [[a, b]]);

    assert.deepEqual(await linker.unlink({ fromId: a, toId: b, relationType: "caused_by" }), { unlinked: true, relationType: "caused_by" });

    const row = await linkRow(a, b);
    assert.ok(row.deleted_at);
    assert.equal(row.delete_reason, "unlink");
    assert.equal(Number(row.weight).toFixed(1), "0.7");
    assert.equal((await linkRow(b, a)).deleted_at, null, "반대 방향");
    assert.equal((await linkRow(a, c)).deleted_at, null, "다른 간선");
    const after = await directQuery(`SELECT id, importance, valid_to FROM ${SCHEMA}.fragments WHERE id = ANY($1::text[]) ORDER BY id`, [[a, b]]);
    assert.deepEqual(after.rows, before.rows);

    const history = await directQuery(
      `SELECT r.action, r.reason FROM ${SCHEMA}.link_reconsolidations r JOIN ${SCHEMA}.fragment_links l ON l.id = r.link_id WHERE l.from_id = $1 AND l.to_id = $2`,
      [a, b]
    );
    assert.deepEqual(history.rows, [{ action: "soft_delete", reason: "unlink" }]);
  });

  it("없는 간선, 반복 호출, 관계 불일치는 변경 없이 성공한다", async () => {
    const [a, b, c] = await seedFragments(topic, 3);
    await store.createLink(a, b, "related");

    assert.deepEqual(await linker.unlink({ fromId: a, toId: c, relationType: "related" }), { unlinked: false, reason: "not_found" });
    assert.deepEqual(await linker.unlink({ fromId: a, toId: b, relationType: "caused_by" }), { unlinked: false, reason: "relation_mismatch", currentRelationType: "related" });
    assert.equal((await linkRow(a, b)).deleted_at, null);

    await linker.unlink({ fromId: a, toId: b, relationType: "related" });
    assert.deepEqual(await linker.unlink({ fromId: a, toId: b, relationType: "related" }), { unlinked: false, reason: "not_found" });
  });

  it("dryRun은 같은 판정을 돌려주고 아무것도 쓰지 않는다", async () => {
    const [a, b] = await seedFragments(topic, 2);
    await store.createLink(a, b, "related");

    const res = await linker.unlink({ fromId: a, toId: b, relationType: "related", dryRun: true });
    assert.deepEqual(res, { dryRun: true, simulated: { fromId: a, toId: b, relationType: "related", would_unlink: true } });
    assert.equal((await linkRow(a, b)).deleted_at, null);
    const history = await directQuery(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.link_reconsolidations r JOIN ${SCHEMA}.fragment_links l ON l.id = r.link_id WHERE l.from_id = $1`, [a]
    );
    assert.equal(history.rows[0].n, 0);
  });

  it("보호 관계를 거부하고, 열린 파편의 어긋난 superseded_by와 닫힌 파편의 일반 링크는 해제한다", async () => {
    const [a, b, c, d, e, f, g, h] = await seedFragments(topic, 8);
    await store.createLink(a, b, "contradicts");
    assert.equal((await linker.unlink({ fromId: a, toId: b, relationType: "contradicts" })).code, "relation_protected");

    await store.createLink(c, d, "superseded_by");
    await directQuery(`UPDATE ${SCHEMA}.fragments SET valid_to = NOW() WHERE id = $1`, [c]);
    assert.equal((await linker.unlink({ fromId: c, toId: d, relationType: "superseded_by" })).code, "relation_protected");
    assert.equal((await linkRow(c, d)).deleted_at, null);

    await store.createLink(e, f, "superseded_by");
    assert.equal((await linker.unlink({ fromId: e, toId: f, relationType: "superseded_by" })).unlinked, true);

    await store.createLink(g, h, "related");
    await directQuery(`UPDATE ${SCHEMA}.fragments SET valid_to = NOW() WHERE id = $1`, [h]);
    assert.equal((await linker.unlink({ fromId: g, toId: h, relationType: "related" })).unlinked, true);
  });

  it("볼 수 없는 파편은 없는 파편과 같은 응답이고, 공유받아도 link 권한이 없으면 지울 수 없다", async () => {
    const [a, b, hidden] = await seedFragments(topic, 3);
    const [keyA, keyB] = [await seedKey(), await seedKey()];
    await directQuery(`UPDATE ${SCHEMA}.fragments SET key_id = $2 WHERE id = ANY($1::text[])`, [[a], keyA]);
    await directQuery(`UPDATE ${SCHEMA}.fragments SET key_id = $2 WHERE id = ANY($1::text[])`, [[b, hidden], keyB]);
    await store.createLink(a, hidden, "related");
    await store.createLink(a, b, "related");

    const hiddenRes  = await linker.unlink({ fromId: a, toId: hidden, relationType: "related", _keyId: keyA, _groupKeyIds: [keyA] });
    const missingRes = await linker.unlink({ fromId: a, toId: "no-such-fragment", relationType: "related", _keyId: keyA, _groupKeyIds: [keyA] });
    assert.deepEqual(hiddenRes, missingRes);
    assert.equal((await linkRow(a, hidden)).deleted_at, null);

    const denied = await linker.unlink({
      fromId: a, toId: b, relationType: "related", _keyId: keyA, _groupKeyIds: [keyA, keyB],
      _groupGrants: { link: [], amend: [], forget: [] }
    });
    assert.equal(denied.code, "not_owner");
    assert.equal((await linkRow(a, b)).deleted_at, null);

    const allowed = await linker.unlink({
      fromId: a, toId: b, relationType: "related", _keyId: keyA, _groupKeyIds: [keyA, keyB],
      _groupGrants: { link: [keyB], amend: [], forget: [] }
    });
    assert.equal(allowed.unlinked, true);
  });

  it("허용하지 않는 relationType은 거부한다", async () => {
    assert.equal((await linker.unlink({ fromId: "a", toId: "b", relationType: "nope" })).code, "invalid_relation");
    assert.equal((await linker.unlink({ fromId: "a", toId: "b" })).code, "invalid_relation");
  });
});

describe("countActiveLinks", () => {
  it("지운 링크와 호출자 키 범위 밖 링크를 세지 않는다", async () => {
    const [a, b, c, d] = await seedFragments(topic, 4);
    const [keyA, keyB] = [await seedKey(), await seedKey()];
    await directQuery(`UPDATE ${SCHEMA}.fragments SET key_id = $2 WHERE id = ANY($1::text[])`, [[a, b, c], keyA]);
    await directQuery(`UPDATE ${SCHEMA}.fragments SET key_id = $2 WHERE id = $1`, [d, keyB]);
    await store.createLink(a, b, "related");
    await store.createLink(c, a, "related");
    await store.createLink(a, d, "related");
    await store.createLink(b, c, "related");
    await store.softDeleteLink(c, a, "related");

    assert.equal(await store.countActiveLinks([a], "default", { keyId: keyA, groupKeyIds: [keyA] }), 1);
    assert.equal(await store.countActiveLinks([a], "default", { keyId: null }), 2, "master");
    assert.equal(await store.countActiveLinks([], "default"), 0);
  });
});
