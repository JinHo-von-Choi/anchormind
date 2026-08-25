/**
 * Unit tests: type/topic 스코프가 시맨틱·시간창 경로와 사후 필터에 정합 적용되는지 검증.
 *
 * 기존에는 type 필터가 L1/L2에만 걸려, timeRange 지정 시 temporal 레이어가
 * 타입 무관 파편을 수집하고 RRF에서 2.0 가중을 받아 상위를 점령했다.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

let capturedSql = "";
const dbModuleUrl = new URL("../../lib/tools/db.js", import.meta.url).href;

mock.module(dbModuleUrl, {
  namedExports: {
    getPrimaryPool      : () => ({ query: async () => ({ rows: [] }) }),
    queryWithAgentVector: async (_agent, sql) => { capturedSql = sql; return { rows: [] }; }
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
});

describe("SearchScope type/topic 사후 필터", () => {
  it("type 불일치 파편을 걸러낸다", () => {
    const scope = new SearchScope({ type: "decision" });
    assert.equal(scope.applyTo({ type: "decision", topic: "x" }), true);
    assert.equal(scope.applyTo({ type: "fact", topic: "x" }), false);
  });

  it("topic 불일치 파편을 걸러낸다", () => {
    const scope = new SearchScope({ topic: "infra" });
    assert.equal(scope.applyTo({ type: "fact", topic: "infra" }), true);
    assert.equal(scope.applyTo({ type: "fact", topic: "hr" }), false);
  });

  it("미지정 scope는 no-op으로 판정된다", () => {
    assert.equal(new SearchScope({}).isNoop(), true);
    assert.equal(new SearchScope({ type: "fact" }).isNoop(), false);
    assert.equal(new SearchScope({ topic: "infra" }).isNoop(), false);
  });

  it("fromQuery가 sq의 type/topic을 전달한다", () => {
    const scope = SearchScope.fromQuery({ type: "error", topic: "nginx" });
    assert.equal(scope.type, "error");
    assert.equal(scope.topic, "nginx");
  });
});
