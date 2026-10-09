/**
 * FragmentReader.searchBySegments: 본 검색(searchBySemantic)과 같은 필터를 거는지, 신선도 조건과 집약 구조를 갖는지
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert                              from "node:assert/strict";

let captured = null;
let nextRows = [];
mock.module("../../lib/tools/db.js", {
  exports: {
    getPrimaryPool      : () => ({ query: async () => ({ rows: [] }) }),
    queryWithAgentVector: async (_agent, sql, params, opts) => {
      captured = { sql, params, opts };
      return { rows: nextRows };
    }
  }
});

const { FragmentReader } = await import("../../lib/memory/read/FragmentReader.js");

/** WHERE 절의 AND 조건을 $N을 실제 값으로 풀어 정규화한 목록으로 돌려준다 */
function conditionsOf(sql, params) {
  const where = sql.slice(sql.indexOf("WHERE ") + 6).split(/\n\s*(?:ORDER BY|GROUP BY|LIMIT)/)[0];
  return where.split(/\s+AND\s+(?![^()]*\))/).map(c => c.replace(/\s+/g, " ").trim().replace(/\$(\d+)/g, (_, n) => `«${JSON.stringify(params[Number(n) - 1])}»`));
}

const FILTERS = {
  limit: 30, minSimilarity: 0.4, agentId: "agent-1", keyId: ["k1", "k2"], workspace: "ws-a", affect: ["confidence", "doubt"],
  timeRange: { from: "2026-01-01", to: "2026-02-01" }, type: "decision", topic: "t-1", isAnchor: false, includeSuperseded: false, viewerKeyId: "k1"
};

beforeEach(() => { captured = null; nextRows = []; });

/** WHERE 절 본문만 돌려준다(선택 컬럼의 f.key_id 등과 섞이지 않게) */
const whereOf = sql => sql.slice(sql.indexOf("WHERE "), sql.indexOf("ORDER BY s.embedding"));

describe("searchBySegments 필터 동등성", () => {
  it("본 검색과 같은 필터 조건(값 포함)을 건다", async () => {
    const reader = new FragmentReader();
    await reader.searchBySemantic([0.1, 0.2], FILTERS);
    const main = conditionsOf(captured.sql, captured.params);
    await reader.searchBySegments([0.1, 0.2], { ...FILTERS, segVersion: "v1-w300-s150-m12" });
    const seg  = conditionsOf(captured.sql, captured.params);

    /** 구간 전용 조건(벡터/신선도/버전)과 본 검색 전용 조건(f.embedding)을 빼면 나머지가 같아야 한다 */
    const own = c => /embedding|content_hash|seg_version/.test(c);
    const mainFilters = main.filter(c => !own(c)).sort();
    const segFilters  = seg.filter(c => !own(c)).sort();
    assert.ok(mainFilters.length >= 8, `필터가 충분히 있어야 한다: ${mainFilters.length}`);
    assert.deepEqual(segFilters, mainFilters);
  });

  it("옵션 없이도 에이전트/유효기간 조건은 건다", async () => {
    await new FragmentReader().searchBySegments([0.1], { segVersion: "v" });
    assert.match(captured.sql, /f\.agent_id/);
    assert.match(captured.sql, /valid_to/);
  });

  it("master 키(keyId null)는 키 조건을 걸지 않는다", async () => {
    await new FragmentReader().searchBySegments([0.1], { segVersion: "v", keyId: null });
    assert.doesNotMatch(whereOf(captured.sql), /f\.key_id\s*(=|IN|<>)/);            // 검토 가시성의 "key_id IS NULL"은 격리 조건이 아니다
  });

  it("키가 있으면 부모 fragments의 key_id로 건다(구간 표에는 키 열이 없다)", async () => {
    await new FragmentReader().searchBySegments([0.1], { segVersion: "v", keyId: "k1" });
    assert.match(whereOf(captured.sql), /f\.key_id\s*(=|IN)/);
    assert.doesNotMatch(captured.sql, /\bs\.key_id\b/);
  });
});

describe("searchBySegments 구조", () => {
  it("신선도(부모 해시)와 분할 버전과 NULL 벡터 제외 조건이 있다", async () => {
    await new FragmentReader().searchBySegments([0.1], { segVersion: "v1-w300-s150-m12" });
    assert.match(captured.sql, /s\.embedding IS NOT NULL/);
    assert.match(captured.sql, /s\.source_content_hash = f\.content_hash/);
    assert.match(captured.sql, /s\.seg_version = \$5/);
    assert.equal(captured.params[4], "v1-w300-s150-m12");
  });

  it("안쪽에서 구간 이웃을 rowLimit개 고르고 바깥에서 조각별 최대로 집약해 limit개를 돌려준다", async () => {
    await new FragmentReader().searchBySegments([0.1], { segVersion: "v", limit: 30, rowLimit: 120 });
    assert.match(captured.sql, /ORDER BY s\.embedding <=> \$1::vector ASC\s+LIMIT \$\d+\s*\)\s*knn/);
    assert.match(captured.sql, /MAX\(knn\.similarity\)/);
    assert.match(captured.sql, /GROUP BY knn\.fragment_id/);
    assert.match(captured.sql, /LIMIT \$3\s*\)\s*agg/);
    assert.equal(captured.params[2], 30);
    assert.ok(captured.params.includes(120));
    assert.equal(captured.opts.forceVectorIndex, true);
  });

  it("rowLimit이 limit보다 작으면 limit을 쓴다", async () => {
    await new FragmentReader().searchBySegments([0.1], { segVersion: "v", limit: 50, rowLimit: 10 });
    assert.ok(captured.params.includes(50));
    assert.ok(!captured.params.includes(10));
  });

  it("segVersion이 없으면 던진다", async () => {
    await assert.rejects(() => new FragmentReader().searchBySegments([0.1], {}), /segVersion/);
  });

  it("결과는 유사도 내림차순이다", async () => {
    nextRows = [{ id: "a", similarity: 0.5 }, { id: "b", similarity: 0.9 }];
    const rows = await new FragmentReader().searchBySegments([0.1], { segVersion: "v" });
    assert.deepEqual(rows.map(r => r.id), ["b", "a"]);
  });
});
