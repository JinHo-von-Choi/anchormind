/**
 * 링크 일괄 생성 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 * 수정일: 2026-11-04 (링크 쓰기가 파편 행의 linked_to를 갱신하지 않는다)
 *
 * createLinks에 쌍 여러 개를 넘기면 fragment_links 행이 쌍과 같아야 하고, 파편 행(linked_to)은 바뀌지 않아야
 * 한다. 같은 파편 쌍을 여러 연결이 동시에 써도 한 행으로 합쳐진다. 배치 쓰기도 단건과 같이 더 구체적인 기존
 * 관계를 자동 관계로 덮지 않는다.
 */

import { describe, it, after } from "node:test";
import assert                          from "node:assert/strict";
import crypto                          from "node:crypto";

const {
  SCHEMA, prepareLaneDatabase, dropLaneDatabase, seedFragments, directQuery
} = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { LinkStore }    = await import("../../lib/memory/link/LinkStore.js");
const { shutdownPool } = await import("../../lib/tools/db.js");

const topic = `db-lane-pairs-${crypto.randomUUID().slice(0, 8)}`;

after(async () => {
  try {
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

describe("LinkStore.createLinks", () => {
  it("fragment_links 행은 쌍과 같고 파편 행의 linked_to는 바뀌지 않는다", async () => {
    const [e1, e2, e3] = await seedFragments(topic, 3, "error");
    const [d1, d2, d3] = await seedFragments(topic, 3, "decision");
    await directQuery(`UPDATE ${SCHEMA}.fragments SET linked_to = ARRAY[$2::text] WHERE id = $1`, [e1, d3]);
    const pairs = [
      { fromId: e1, toId: d1, relationType: "caused_by" },
      { fromId: e2, toId: d2, relationType: "caused_by" },
      { fromId: e3, toId: d3, relationType: "caused_by" }
    ];

    await new LinkStore().createLinks(pairs, "default");

    const { rows } = await directQuery(
      `SELECT id, COALESCE(linked_to, '{}') AS linked_to FROM ${SCHEMA}.fragments WHERE id = ANY($1::text[])`,
      [[e1, e2, e3, d1, d2, d3]]
    );
    const linked = Object.fromEntries(rows.map(r => [r.id, [...r.linked_to]]));
    assert.deepEqual(linked[e1], [d3], "저장 때 선언한 linked_to만 남는다");
    for (const id of [e2, e3, d1, d2, d3]) assert.deepEqual(linked[id], [], id);

    const links = await directQuery(
      `SELECT from_id, to_id FROM ${SCHEMA}.fragment_links WHERE from_id = ANY($1::text[])`,
      [[e1, e2, e3]]
    );
    assert.deepEqual(
      links.rows.map(r => `${r.from_id}>${r.to_id}`).sort(),
      pairs.map(p => `${p.fromId}>${p.toId}`).sort()
    );
  });

  it("같은 쌍을 여러 연결이 동시에 써도 한 행으로 합쳐지고 교착이 없다", async () => {
    const ids = await seedFragments(topic, 4);
    const pairs = [];
    for (const a of ids) for (const b of ids) if (a !== b) pairs.push({ fromId: a, toId: b, relationType: "related" });
    const store = new LinkStore();
    await Promise.all(Array.from({ length: 6 }, (_, i) => store.createLinks(i % 2 ? pairs : [...pairs].reverse(), "default")));
    const { rows } = await directQuery(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.fragment_links WHERE from_id = ANY($1::text[]) AND to_id = ANY($1::text[])`, [ids]
    );
    assert.equal(rows[0].n, pairs.length);
  });

  it("배치 쓰기도 더 구체적인 기존 관계를 덮지 않고 weight는 큰 값을 남긴다", async () => {
    const [e, d] = await seedFragments(topic, 2);
    const store  = new LinkStore();
    await store.createLink(e, d, "caused_by", "default", 0.4);
    await store.createLinks([{ fromId: e, toId: d, relationType: "temporal", weight: 0.9 }], "default");

    const { rows } = await directQuery(
      `SELECT relation_type, weight FROM ${SCHEMA}.fragment_links WHERE from_id = $1 AND to_id = $2`, [e, d]
    );
    assert.equal(rows[0].relation_type, "caused_by");
    assert.ok(Math.abs(Number(rows[0].weight) - 0.9) < 1e-6);
  });
});
