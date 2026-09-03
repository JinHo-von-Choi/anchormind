/**
 * Unit tests: type/topic 스코프가 시맨틱·시간창 경로와 사후 필터에 정합 적용되는지 검증.
 *
 * 기존에는 type 필터가 L1/L2에만 걸려, timeRange 지정 시 temporal 레이어가
 * 타입 무관 파편을 수집하고 RRF에서 2.0 가중을 받아 상위를 점령했다.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

let capturedSql = "";
let capturedParams = [];
mock.module("../../lib/tools/db.js", {
  exports: {
    getPrimaryPool      : () => ({ query: async () => ({ rows: [] }) }),
    queryWithAgentVector: async (_agent, sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    }
  }
});

const { FragmentReader } = await import("../../lib/memory/read/FragmentReader.js");
const { SearchScope }    = await import("../../lib/memory/read/SearchScope.js");

describe("searchBySemantic 스코프", () => {
  it("type 지정 시 SQL에 type 조건이 포함된다", async () => {
    capturedSql = "";
    await new FragmentReader().searchBySemantic([0.1, 0.2], { type: "decision" }).catch(() => {});
    assert.ok(capturedSql.includes("f.type = $"), `type 조건 누락: ${capturedSql.slice(0, 200)}`);
  });

  it("topic 지정 시 SQL에 topic 조건이 포함된다", async () => {
    capturedSql = "";
    await new FragmentReader().searchBySemantic([0.1, 0.2], { topic: "infra" }).catch(() => {});
    assert.ok(capturedSql.includes("f.topic = $"), `topic 조건 누락: ${capturedSql.slice(0, 200)}`);
  });

  it("미지정 시 조건을 추가하지 않는다", async () => {
    capturedSql = "";
    await new FragmentReader().searchBySemantic([0.1, 0.2], {}).catch(() => {});
    assert.ok(!capturedSql.includes("f.type = $"));
    assert.ok(!capturedSql.includes("f.topic = $"));
  });
});

describe("searchByTimeRange 스코프", () => {
  it("type/topic 지정 시 SQL 조건이 포함된다", async () => {
    capturedSql = "";
    await new FragmentReader().searchByTimeRange("2026-01-01", "2026-02-01",
      { agentId: "a1", type: "decision", topic: "infra" }).catch(() => {});
    assert.ok(capturedSql.includes("type = $"), "type 조건 누락");
    assert.ok(capturedSql.includes("topic = $"), "topic 조건 누락");
  });

  it("미지정 시 시간창 전체를 수집한다", async () => {
    capturedSql = "";
    await new FragmentReader().searchByTimeRange("2026-01-01", "2026-02-01", { agentId: "a1" }).catch(() => {});
    assert.ok(!capturedSql.includes("type = $"));
  });

  for (const isAnchor of [true, false]) {
    it(`isAnchor=${isAnchor} + includeSuperseded=true면 만료 파편도 SQL 후보에 포함한다`, async () => {
      capturedSql = "";
      capturedParams = [];
      await new FragmentReader().searchByTimeRange(null, null, {
        agentId: "synthetic-agent",
        isAnchor,
        includeSuperseded: true
      });

      assert.match(capturedSql, /is_anchor = \$/);
      assert.doesNotMatch(capturedSql, /valid_to IS NULL/);
      assert.ok(capturedParams.includes(isAnchor));
    });
  }

  it("includeSuperseded 미지정 시 기존 valid_to 필터를 유지한다", async () => {
    capturedSql = "";
    await new FragmentReader().searchByTimeRange(null, null, {
      agentId: "synthetic-agent",
      isAnchor: false
    });
    assert.match(capturedSql, /valid_to IS NULL/);
  });
});

describe("SearchScope type/topic 사후 필터", () => {
  it("type 불일치 파편을 걸러낸다", () => {
    const scope = new SearchScope({ type: "decision" });
    assert.equal(scope.applyTo({ type: "decision", topic: "x", workspace: null }), true);
    assert.equal(scope.applyTo({ type: "fact", topic: "x", workspace: null }), false);
  });

  it("topic 불일치 파편을 걸러낸다", () => {
    const scope = new SearchScope({ topic: "infra" });
    assert.equal(scope.applyTo({ type: "fact", topic: "infra", workspace: null }), true);
    assert.equal(scope.applyTo({ type: "fact", topic: "hr", workspace: null }), false);
  });

  it("미지정 scope는 global-only이고 allWorkspaces만 no-op이다", () => {
    assert.equal(new SearchScope({}).isNoop(), false);
    assert.equal(new SearchScope({ allWorkspaces: true }).isNoop(), true);
    assert.equal(new SearchScope({ type: "fact" }).isNoop(), false);
    assert.equal(new SearchScope({ topic: "infra" }).isNoop(), false);
  });

  it("fromQuery가 sq의 type/topic을 전달한다", () => {
    const scope = SearchScope.fromQuery({ type: "error", topic: "nginx" });
    assert.equal(scope.type, "error");
    assert.equal(scope.topic, "nginx");
  });
});

describe("isAnchor 3상태 검색 계약", () => {
  it("SearchScope true/false/미지정을 구분한다", () => {
    const anchor    = { is_anchor: true, workspace: null };
    const nonAnchor = { is_anchor: false, workspace: null };

    assert.equal(new SearchScope({ isAnchor: true }).applyTo(anchor), true);
    assert.equal(new SearchScope({ isAnchor: true }).applyTo(nonAnchor), false);
    assert.equal(new SearchScope({ isAnchor: false }).applyTo(anchor), false);
    assert.equal(new SearchScope({ isAnchor: false }).applyTo(nonAnchor), true);
    assert.equal(new SearchScope({}).applyTo(anchor), true);
    assert.equal(new SearchScope({}).applyTo(nonAnchor), true);
    assert.equal(new SearchScope({ isAnchor: false }).isNoop(), false);
    assert.equal(SearchScope.fromQuery({ isAnchor: false }).isAnchor, false);
  });

  it("null/문자열 true/false를 3상태로 정규화하고 잘못된 값은 거부한다", () => {
    assert.equal(new SearchScope({ isAnchor: null }).isAnchor, undefined);
    assert.equal(new SearchScope({ isAnchor: null }).isNoop(), false);
    assert.equal(new SearchScope({ isAnchor: "true" }).isAnchor, true);
    assert.equal(new SearchScope({ isAnchor: " false " }).isAnchor, false);
    assert.throws(
      () => new SearchScope({ isAnchor: "yes" }),
      /isAnchor must be null, a boolean/
    );
  });

  it("keyword/topic/semantic/time/source SQL에 false도 명시 필터로 전달한다", async () => {
    const reader = new FragmentReader();
    const calls = [
      () => reader.searchByKeywords(["synthetic"], { isAnchor: false }),
      () => reader.searchByTopic("synthetic", { isAnchor: false }),
      () => reader.searchBySemantic([0.1, 0.2], { isAnchor: false }),
      () => reader.searchByTimeRange("2026-01-01", "2026-02-01", { isAnchor: false }),
      () => reader.searchBySource("synthetic-source", "synthetic-agent", null, 5, { isAnchor: false })
    ];

    for (const call of calls) {
      capturedSql = "";
      capturedParams = [];
      await call();
      assert.match(capturedSql, /(?:f\.)?is_anchor = \$/);
      assert.ok(capturedParams.includes(false));
    }
  });

  it("isAnchor 미지정 SQL은 앵커 조건을 추가하지 않는다", async () => {
    capturedSql = "";
    capturedParams = [];
    await new FragmentReader().searchByTopic("synthetic", {});
    assert.doesNotMatch(capturedSql, /(?:f\.)?is_anchor = \$/);
    assert.ok(!capturedParams.includes(true) && !capturedParams.includes(false));
  });

  it("source 조회도 includeSuperseded=true이면 valid_to 조건을 제거하고 값을 반환 필드에 싣는다", async () => {
    capturedSql = "";
    capturedParams = [];
    await new FragmentReader().searchBySource(
      "synthetic-source",
      "synthetic-agent",
      null,
      5,
      { includeSuperseded: true }
    );

    assert.doesNotMatch(capturedSql, /valid_to IS NULL/);
    assert.match(capturedSql, /workspace, valid_to,/);
  });

  it("ID hydration도 includeSuperseded=true이면 만료 파편을 SQL 후보에 포함한다", async () => {
    capturedSql = "";
    await new FragmentReader().getByIds(
      ["synthetic-id"], "synthetic-agent", null, [], { includeSuperseded: true }
    );
    assert.doesNotMatch(capturedSql, /valid_to IS NULL/);
  });
});
