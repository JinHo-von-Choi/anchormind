import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * queryWithAgentVector가 벡터 검색 트랜잭션에 planner 힌트를 주입하는지
 * 소스 레벨로 검증한다. 실 DB 연결 없이 SET LOCAL 문 존재를 보장.
 */
test("queryWithAgentVector gates planner hints behind opts.forceVectorIndex", () => {
  const src = readFileSync(new URL("../../lib/tools/db.js", import.meta.url), "utf8");
  const fn  = src.slice(src.indexOf("export async function queryWithAgentVector"));
  assert.match(fn, /opts\.forceVectorIndex/, "forceVectorIndex 게이트 누락");
  assert.match(fn, /SET LOCAL enable_seqscan = off/, "enable_seqscan SET LOCAL 누락");
  assert.match(fn, /SET LOCAL enable_bitmapscan = off/, "enable_bitmapscan SET LOCAL 누락");
  assert.match(fn, /SET LOCAL hnsw\.iterative_scan/, "iterative_scan SET LOCAL 누락");
  assert.match(fn, /readVectorForceIndex\(process\.env\)/, "토글 판독 누락");
  const parse = readFileSync(new URL("../../lib/env-parse.js", import.meta.url), "utf8");
  assert.match(parse, /MEMENTO_VECTOR_FORCE_INDEX/, "토글 env 누락");
});
