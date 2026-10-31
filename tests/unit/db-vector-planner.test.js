import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { transactionSettings } from "../../lib/tools/db.js";

/**
 * 벡터 검색 planner 힌트(seqscan·bitmapscan 끄기, HNSW 반복 탐색)는 opts.forceVectorIndex를 준 트랜잭션에만
 * 걸린다. 이 함수는 비벡터 질의도 거치므로 힌트가 새면 그 질의의 계획이 틀어진다.
 */
const HINTS = ["enable_seqscan", "enable_bitmapscan", "hnsw.iterative_scan"];
const names = (opts) => transactionSettings("default", opts).map(([name, value]) => `${name}=${value}`);

test("forceVectorIndex를 준 트랜잭션에만 planner 힌트를 건다", () => {
  const prev = process.env.MEMENTO_VECTOR_FORCE_INDEX;
  delete process.env.MEMENTO_VECTOR_FORCE_INDEX;
  try {
    assert.deepEqual(names({ forceVectorIndex: true }).filter(s => HINTS.some(h => s.startsWith(`${h}=`))),
      ["enable_seqscan=off", "enable_bitmapscan=off", "hnsw.iterative_scan=relaxed_order"]);
    assert.equal(names({}).some(s => HINTS.some(h => s.startsWith(`${h}=`))), false);
    assert.equal(names("write").some(s => HINTS.some(h => s.startsWith(`${h}=`))), false);
  } finally {
    if (prev === undefined) delete process.env.MEMENTO_VECTOR_FORCE_INDEX;
    else process.env.MEMENTO_VECTOR_FORCE_INDEX = prev;
  }
});

test("토글 env로 힌트를 끌 수 있다", () => {
  const parse = readFileSync(new URL("../../lib/env-parse.js", import.meta.url), "utf8");
  assert.match(parse, /MEMENTO_VECTOR_FORCE_INDEX/, "토글 env 누락");
});
