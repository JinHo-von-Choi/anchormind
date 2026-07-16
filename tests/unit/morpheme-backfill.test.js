/**
 * P2a: MorphemeBackfill 배치 처리 검증.
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 */
import { test } from "node:test";
import assert   from "node:assert/strict";
import { processMorphemeBackfill } from "../../lib/memory/consolidate/MorphemeBackfill.js";

function makeMockPool(rows) {
  const updated = [];
  const pool = {
    updated,
    async query(sql, params) {
      if (/SELECT id, content/i.test(sql)) {
        return { rows, rowCount: rows.length };
      }
      if (/UPDATE .*morpheme_indexed = true/i.test(sql)) {
        updated.push(params[0]);
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  };
  return pool;
}

const morphemeIndex = {
  tokenizeCalls: [],
  registerCalls: [],
  async tokenize(text) { this.tokenizeCalls.push(text); return text.split(/\s+/); },
  async getOrRegisterEmbeddings(m) { this.registerCalls.push(m); return []; }
};

test("morpheme_indexed=false 파편을 tokenize→register→UPDATE 처리한다", async () => {
  const pool = makeMockPool([
    { id: "frag-1", content: "nginx 재시작" },
    { id: "frag-2", content: "포트 변경" }
  ]);
  const count = await processMorphemeBackfill({ pool, morphemeIndex, batchSize: 500 });
  assert.equal(count, 2);
  assert.deepEqual(pool.updated.sort(), ["frag-1", "frag-2"]);
  assert.equal(morphemeIndex.tokenizeCalls.length, 2);
});

test("대상 파편이 없으면 0을 반환하고 부작용이 없다", async () => {
  const pool = makeMockPool([]);
  const count = await processMorphemeBackfill({ pool, morphemeIndex, batchSize: 500 });
  assert.equal(count, 0);
  assert.equal(pool.updated.length, 0);
});
