/**
 * 연결 미리보기·후보 확장·그래프·이력 조회가 관계 필터, 활성 링크, 검토 가시성, 기간 조건을 같은 계약으로
 * 적용하는지 검증한다.
 */
import { after, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

const queries = [];
const capture = async (sql, params) => {
  queries.push({ sql, params });
  return { rows: [] };
};

mock.module("../../lib/tools/db.js", {
  exports: {
    getPrimaryPool       : () => ({ query: capture }),
    queryWithAgentVector : async (_agentId, sql, params) => capture(sql, params),
    withTransaction      : async (_pool, fn) => fn({ query: capture })
  }
});

const { fetchLinkedFragments }   = await import("../../lib/memory/read/LinkedFragmentLoader.js");
const { fetchSessionNeighbors }  = await import("../../lib/memory/read/StitchSourceLoader.js");
const { fetchGraphNeighbors }    = await import("../../lib/memory/read/GraphNeighborSearch.js");
const { LinkStore }              = await import("../../lib/memory/link/LinkStore.js");
const { FragmentReader }         = await import("../../lib/memory/read/FragmentReader.js");
const { CaseEventStore }         = await import("../../lib/memory/CaseEventStore.js");
const { SearchScope }            = await import("../../lib/memory/read/SearchScope.js");
const { hotCacheOwner }          = await import("../../lib/memory/read/FragmentSearch.js");
const { indexedTerms }           = await import("../../lib/memory/FragmentIndex.js");
const {
  REVIEW_VIEWER_NONE, heldSourceHiddenCondition
} = await import("../../lib/memory/read/ReviewVisibility.js");
const {
  PREVIEW_DEFAULT_RELATIONS, EXPANSION_DEFAULT_RELATIONS, safeRelationType
} = await import("../../lib/memory/link/LinkVisibility.js");

beforeEach(() => {
  queries.length = 0;
});

describe("linked 미리보기 (#103)", () => {
  it("미지정이면 resolved_by·caused_by·related만 고르고 관계 순서를 LIMIT 앞에 둔다", async () => {
    await fetchLinkedFragments(["seed"], { keyId: "key-a" });
    const { sql, params } = queries.at(-1);
    assert.match(sql, /fl\.deleted_at IS NULL/);
    assert.match(sql, /fl\.relation_type = ANY\(\$\d+::text\[\]\)/);
    assert.ok(params.some(p => Array.isArray(p) && p.join() === PREVIEW_DEFAULT_RELATIONS.join()));
    assert.match(sql, /CASE fl\.relation_type WHEN 'resolved_by' THEN 1 WHEN 'caused_by' THEN 2 ELSE 3 END AS relation_rank/);
    assert.match(sql, /ORDER BY l\.relation_rank, l\.weight DESC, l\.to_id\s+LIMIT 3/);
    assert.match(sql, /fl\.from_id = fid\.id/);
    assert.doesNotMatch(sql, /fl\.to_id = fid\.id/);
  });

  it("linkRelationType을 주면 그 관계만 조회한다", async () => {
    await fetchLinkedFragments(["seed"], { relationType: "part_of" });
    assert.ok(queries.at(-1).params.some(p => Array.isArray(p) && p.join() === "part_of"));
  });

  it("허용되지 않은 관계 이름은 미지정과 같다", async () => {
    await fetchLinkedFragments(["seed"], { relationType: "drop table" });
    assert.ok(queries.at(-1).params.some(p => Array.isArray(p) && p.join() === PREVIEW_DEFAULT_RELATIONS.join()));
    assert.equal(safeRelationType("drop table"), null);
    assert.equal(safeRelationType("part_of"), "part_of");
  });
});

describe("후보 확장 (LinkStore)", () => {
  it("양쪽 UNION 모두 활성 링크만 보고, 관계 순서·가중치로 정렬한 뒤 자른다", () => {
    const { sql, params } = new LinkStore()._buildLinkedFragmentsSql({ fromIds: ["seed"], safeRelationType: null, keyId: null });
    assert.equal((sql.match(/l\.deleted_at IS NULL/g) || []).length, 2);
    assert.deepEqual(params[1], [...EXPANSION_DEFAULT_RELATIONS]);
    assert.match(sql, /\) picked\s+ORDER BY relation_order, link_weight DESC, importance DESC, id\s+LIMIT/);
  });

  it("RCA 체인은 지운 링크를 쓰지 않는다", async () => {
    await new LinkStore().getRCAChain("seed", "agent-a", "key-a", ["key-a"], {});
    assert.equal((queries.at(-1).sql.match(/l\.deleted_at IS NULL/g) || []).length, 2);
  });

  it("지운 행에 링크를 다시 만들면 새 링크로 되살린다", async () => {
    await new LinkStore().createLinks([{ fromId: "a", toId: "b", relationType: "related" }], "agent-a");
    const insert = queries.find(q => /INSERT INTO\s+\S*fragment_links/.test(q.sql));
    assert.match(insert.sql, /deleted_at = NULL, delete_reason = NULL/);
  });
});

describe("그래프 이웃", () => {
  it("SQL 점수식으로 정렬한 뒤 상한을 적용한다", async () => {
    await fetchGraphNeighbors(["seed"], 10, "agent-a", ["key-a"], { workspace: "ws-a" });
    const { sql } = queries.at(-1);
    assert.match(sql, /tanh\(_link_weight \* 0\.5\)/);
    assert.match(sql, /\) picked\s+ORDER BY _sql_graph_score DESC, id\s+LIMIT \$3/);
  });
});

describe("세션 이웃", () => {
  it("시간창과 파편별 상한을 SQL에서 적용한다", async () => {
    await fetchSessionNeighbors(
      [{ id: "f1", session_id: "s1", created_at: "2026-10-01T00:00:00Z" }],
      { keyId: "key-a" }, 30, 6
    );
    const { sql, params } = queries.at(-1);
    assert.match(sql, /unnest\(\$1::text\[\], \$2::text\[\], \$3::timestamptz\[\]\)/);
    assert.match(sql, /BETWEEN t\.created_at - \$\d+::interval AND t\.created_at \+ \$\d+::interval/);
    assert.ok(params.includes("30 minutes"));
    assert.ok(params.includes(6));
  });
});

describe("검토 가시성", () => {
  it("source 조회의 주입 경로는 쓴 키에게서도 검토 대기·거절 파편을 뺀다", async () => {
    await new FragmentReader().searchBySource("learning_extraction", "agent-a", ["key-a"], 5, { viewerKeyId: REVIEW_VIEWER_NONE });
    const { sql } = queries.at(-1);
    assert.match(sql, /review_state IS NULL OR review_state NOT IN \('pending', 'rejected'\)\)/);
    assert.doesNotMatch(sql, /key_id IS NOT DISTINCT FROM/);
  });

  it("source 조회의 일반 경로는 호출 키가 쓴 검토 파편만 허용한다", async () => {
    await new FragmentReader().searchBySource("session:abc", "agent-a", "key-a", 5, {});
    const { sql, params } = queries.at(-1);
    assert.match(sql, /OR key_id IS NOT DISTINCT FROM \$\d+/);
    assert.ok(params.includes("key-a"));
  });

  it("숨긴 원본에서 나온 이벤트 조건은 보는 주체에 따라 달라진다", () => {
    const keyed = [];
    assert.match(heldSourceHiddenCondition(keyed, { viewerKeyId: "key-a" }, "ce.source_fragment_id"), /NOT \(rv\.key_id IS NOT DISTINCT FROM \$1\)/);
    assert.deepEqual(keyed, ["key-a"]);
    assert.match(heldSourceHiddenCondition([], { viewerKeyId: null }, "ce.source_fragment_id"), /NOT \(rv\.key_id IS NULL\)/);
    assert.match(heldSourceHiddenCondition([], { viewerKeyId: REVIEW_VIEWER_NONE }, "ce.source_fragment_id"), /NOT \(FALSE\)/);
    assert.throws(() => heldSourceHiddenCondition([], {}, "x; drop"), TypeError);
  });

  it("사례 이벤트·간선·근거 조회가 숨긴 원본의 이벤트를 뺀다", async () => {
    const store = new CaseEventStore();
    const scope = { keyId: "key-a", groupKeyIds: ["key-a"], agentId: "agent-a", workspace: "ws-a" };
    await store.getByCase("case-a", scope);
    await store.getEdgesByEvents(["00000000-0000-4000-8000-000000000001"], scope);
    await store.getEvidenceByEvents(["00000000-0000-4000-8000-000000000001"], scope);
    const [byCase, edges, evidence] = queries;
    assert.match(byCase.sql, /rv\.id = ce\.source_fragment_id/);
    assert.match(edges.sql, /rv\.id = ce_from\.source_fragment_id/);
    assert.match(edges.sql, /rv\.id = ce_to\.source_fragment_id/);
    assert.match(evidence.sql, /rv\.id = ce\.source_fragment_id/);
    assert.match(evidence.sql, /f\.review_state IS NULL OR f\.review_state NOT IN/);
  });
});

describe("기간 조건 (SearchScope)", () => {
  const range = { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-02-01T00:00:00Z"), basis: "created" };

  it("[from, to) 밖의 파편과 시각을 알 수 없는 파편을 뺀다", () => {
    const scope = new SearchScope({ allWorkspaces: true, timeRange: range });
    assert.equal(scope.isNoop(), false);
    assert.equal(scope.applyTo({ created_at: "2026-01-15T00:00:00Z" }), true);
    assert.equal(scope.applyTo({ created_at: "2025-12-31T23:59:59Z" }), false);
    assert.equal(scope.applyTo({ created_at: "2026-02-01T00:00:00Z" }), false);
    assert.equal(scope.applyTo({}), false);
  });

  it("basis=event는 event_time, mention_time, created_at 순으로 본다", () => {
    const scope = new SearchScope({ allWorkspaces: true, timeRange: { ...range, basis: "event" } });
    assert.equal(scope.applyTo({ event_time: "2026-01-10T00:00:00Z", created_at: "2026-05-01T00:00:00Z" }), true);
    assert.equal(scope.applyTo({ mention_time: "2025-06-01T00:00:00Z", created_at: "2026-01-10T00:00:00Z" }), false);
  });
});

describe("캐시와 역색인", () => {
  it("Hot Cache는 파편을 쓴 키의 namespace에 저장한다", () => {
    assert.equal(hotCacheOwner({ key_id: "key-b" }, ["key-a", "key-b"]), "key-b");
    assert.equal(hotCacheOwner({ key_id: null }, ["key-a"]), null);
    assert.equal(hotCacheOwner({}, ["key-a"]), "key-a");
    assert.equal(hotCacheOwner({}, ["key-a", "key-b"]), undefined);
    assert.equal(hotCacheOwner({}, null), null);
  });

  it("색인과 해제가 같은 낱말 목록을 쓴다", () => {
    const terms = indexedTerms(["Nginx"], "nginx 리버스 프록시 인증서 갱신 절차");
    assert.ok(terms.includes("nginx"));
    assert.ok(terms.length > 1);
    assert.deepEqual(indexedTerms(["A"], null), ["a"]);
  });
});
