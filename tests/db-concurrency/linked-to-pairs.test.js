/**
 * 링크 일괄 생성의 linked_to 정합 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * createLinks에 서로 겹치지 않는 쌍 여러 개를 넘기면 각 파편의 linked_to에는
 * 자기 쌍의 상대만 더해져야 한다. fragment_links 행도 쌍과 같아야 한다.
 */

import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import crypto                          from "node:crypto";

const {
  SCHEMA, assertDatabaseReady, seedFragments, removeTopic, directQuery
} = await import("./_harness.js");
const { LinkStore }    = await import("../../lib/memory/link/LinkStore.js");
const { shutdownPool } = await import("../../lib/tools/db.js");

const topic = `db-lane-pairs-${crypto.randomUUID().slice(0, 8)}`;

before(async () => {
  await assertDatabaseReady();
});

after(async () => {
  await shutdownPool();
  await removeTopic(topic);
});

describe("LinkStore.createLinks linked_to", () => {
  it("각 파편의 linked_to에는 자기 쌍의 상대만 들어간다", async () => {
    const [e1, e2, e3] = await seedFragments(topic, 3, "error");
    const [d1, d2, d3] = await seedFragments(topic, 3, "decision");
    const pairs = [
      { fromId: e1, toId: d1, relationType: "caused_by" },
      { fromId: e2, toId: d2, relationType: "caused_by" },
      { fromId: e3, toId: d3, relationType: "caused_by" }
    ];

    await new LinkStore().createLinks(pairs, "default");

    const { rows } = await directQuery(
      `SELECT id, COALESCE(linked_to, '{}') AS linked_to FROM ${SCHEMA}.fragments
        WHERE id = ANY($1::text[])`,
      [[e1, e2, e3, d1, d2, d3]]
    );
    const linked = Object.fromEntries(rows.map(r => [r.id, [...r.linked_to].sort()]));
    for (const { fromId, toId } of pairs) {
      assert.deepEqual(linked[fromId], [toId], `from ${fromId}`);
      assert.deepEqual(linked[toId], [fromId], `to ${toId}`);
    }

    const links = await directQuery(
      `SELECT from_id, to_id FROM ${SCHEMA}.fragment_links WHERE from_id = ANY($1::text[])`,
      [[e1, e2, e3]]
    );
    assert.deepEqual(
      links.rows.map(r => `${r.from_id}>${r.to_id}`).sort(),
      pairs.map(p => `${p.fromId}>${p.toId}`).sort()
    );
  });

  it("이미 있던 linked_to 값은 유지되고 중복 없이 합쳐진다", async () => {
    const [a, b, c] = await seedFragments(topic, 3);
    await directQuery(`UPDATE ${SCHEMA}.fragments SET linked_to = ARRAY[$2::text] WHERE id = $1`, [a, c]);

    await new LinkStore().createLinks([{ fromId: a, toId: b, relationType: "related" }], "default");
    await new LinkStore().createLinks([{ fromId: a, toId: b, relationType: "related" }], "default");

    const { rows } = await directQuery(
      `SELECT linked_to FROM ${SCHEMA}.fragments WHERE id = $1`, [a]
    );
    assert.deepEqual([...rows[0].linked_to].sort(), [b, c].sort());
  });
});
