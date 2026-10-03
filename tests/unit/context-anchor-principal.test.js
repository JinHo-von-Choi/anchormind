/**
 * context 앵커 주입 줄의 비식별 주체 표지 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 앵커 후보 조회 대역 위에서 [ANCHOR MEMORY] 줄이 키 이름이나 키 id 대신 `k:` 해시 표지를 싣는지,
 * 응답 파편이 key_id를 드러내지 않는지, MEMENTO_ANCHOR_PERMISSION=off에서 표지가 없는지 본다.
 */

import { describe, it, mock, afterEach } from "node:test";
import assert                            from "node:assert/strict";

import { ContextBuilder }       from "../../lib/memory/read/ContextBuilder.js";
import { anchorPrincipalLabel } from "../../lib/memory/anchorPolicy.js";

const KEY = "c0ffee00-1234-4abc-8def-001122334455";

function anchorRow(id, keyId, content) {
  return {
    id, type: "fact", topic: "synthetic-anchor", content, importance: 0.9,
    workspace: null, created_at: "2026-01-01T00:00:00.000Z", key_id: keyId, candidate_count: "2"
  };
}

function makeBuilder() {
  const pool = {
    query: mock.fn(async () => ({
      rows: [anchorRow("a-key", KEY, "synthetic key anchor"), anchorRow("a-master", null, "synthetic master anchor")]
    }))
  };
  const builder = new ContextBuilder({
    recall : mock.fn(async () => ({ fragments: [] })),
    store  : { searchBySource: mock.fn(async () => []) },
    index  : { getWorkingMemory: mock.fn(async () => []), setSeenIds: mock.fn(async () => {}) },
    getPool: () => pool
  });
  return { builder, pool };
}

afterEach(() => { delete process.env.MEMENTO_ANCHOR_PERMISSION; });

describe("앵커 주입 줄 주체 표지", () => {
  it("키 앵커는 k: 해시 표지, master 앵커는 master 표지를 붙인다", async () => {
    const { builder, pool } = makeBuilder();
    const result = await builder.build({ types: ["fact"], tokenBudget: 2000 });
    const lines  = result.injectionText.split("\n");

    assert.ok(lines.includes(`- [${anchorPrincipalLabel(KEY)}] synthetic key anchor`), result.injectionText);
    assert.ok(lines.includes("- [master] synthetic master anchor"), result.injectionText);
    assert.ok(!result.injectionText.includes(KEY), "키 id가 주입 줄에 있다");
    assert.match(pool.query.mock.calls[0].arguments[0], /\bkey_id\b/);
  });

  it("응답 앵커 파편은 key_id 대신 principal을 싣는다", async () => {
    const { builder } = makeBuilder();
    const result = await builder.build({ types: ["fact"], tokenBudget: 2000 });
    const keyAnchor = result.fragments.find(f => f.id === "a-key");
    assert.equal(keyAnchor.principal, anchorPrincipalLabel(KEY));
    assert.equal(Object.hasOwn(keyAnchor, "key_id"), false);
  });

  it("MEMENTO_ANCHOR_PERMISSION=off이면 표지를 붙이지 않는다", async () => {
    process.env.MEMENTO_ANCHOR_PERMISSION = "off";
    const { builder } = makeBuilder();
    const result = await builder.build({ types: ["fact"], tokenBudget: 2000 });
    const lines  = result.injectionText.split("\n");
    assert.ok(lines.includes("- synthetic key anchor"), result.injectionText);
    const keyAnchor = result.fragments.find(f => f.id === "a-key");
    assert.equal(Object.hasOwn(keyAnchor, "principal"), false);
    assert.equal(Object.hasOwn(keyAnchor, "key_id"), false);
  });
});
