/**
 * 시맨틱 검색 임계값 위치 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert                              from "node:assert/strict";

let captured = null;
mock.module("../../lib/tools/db.js", {
  exports: {
    getPrimaryPool      : () => ({ query: async () => ({ rows: [] }) }),
    queryWithAgentVector: async (_agent, sql, params, opts) => {
      captured = { sql, params, opts };
      return { rows: [] };
    }
  }
});

const { FragmentReader } = await import("../../lib/memory/read/FragmentReader.js");

/** outer 질의를 안쪽(KNN)과 바깥으로 나누고 안쪽 LIMIT 값을 찾는다 */
function splitOuter() {
  const [inner, outer] = captured.sql.split(/\)\s*knn/);
  assert.ok(outer, "바깥 질의가 있어야 한다");
  const ref            = Number(inner.match(/LIMIT \$(\d+)\s*$/)[1]);
  return { inner, outer, candidates: captured.params[ref - 1] };
}

beforeEach(() => {
  captured = null;
  delete process.env.MEMENTO_SEMANTIC_THRESHOLD_MODE;
});

describe("시맨틱 임계값 위치", () => {
  it("미설정이면 임계값이 KNN WHERE 안에 있고 LIMIT은 $3이다", async () => {
    await new FragmentReader().searchBySemantic([0.1, 0.2], { limit: 30, minSimilarity: 0.4 });
    assert.match(captured.sql, /WHERE[\s\S]*1 - \(f\.embedding <=> \$1::vector\) >= \$2[\s\S]*LIMIT \$3\s*$/);
    assert.doesNotMatch(captured.sql, /\)\s*knn/);
    assert.equal(captured.params.length, 4);
  });

  it("outer면 이웃 max(limit, 80)개를 고른 뒤 바깥에서 임계값과 limit을 적용한다", async () => {
    process.env.MEMENTO_SEMANTIC_THRESHOLD_MODE = "outer";
    await new FragmentReader().searchBySemantic([0.1, 0.2], { limit: 30, minSimilarity: 0.4, keyId: "k1" });
    const { inner, outer, candidates } = splitOuter();
    assert.doesNotMatch(inner, />= \$2/);
    assert.match(outer, /knn\.similarity >= \$2/);
    assert.match(outer, /ORDER BY knn\.similarity DESC\s+LIMIT \$3/);
    assert.equal(candidates, 80);
    assert.equal(captured.params[1], 0.4);
    assert.equal(captured.params[2], 30);
    assert.equal(captured.opts.forceVectorIndex, true);
  });

  it("limit이 80보다 크면 이웃 수도 limit이다", async () => {
    process.env.MEMENTO_SEMANTIC_THRESHOLD_MODE = "outer";
    await new FragmentReader().searchBySemantic([0.1, 0.2], { limit: 120 });
    assert.equal(splitOuter().candidates, 120);
  });
});
