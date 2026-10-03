/**
 * 검토 대기 파편 가시성 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 쓴 키는 검토 대기 파편을 보고 다른 키(키 그룹 구성원, 마스터 포함)와 주입은 보지 못하는지 본다.
 * 순수 판정(isReviewVisible)과 SQL 술어가 같은 표를 따르는지, recall 질의(키워드, 토픽, 시맨틱, 시간 범위,
 * id 보충 조회, id 조회)와 ANCHOR 조회, 앵커 승격 잠금 문장에 술어가 붙는지, core 후보와 응답 표지를
 * 대역 위에서 확인한다. MEMENTO_REVIEW_QUEUE=off이면 SQL이 바뀌지 않는다.
 */

import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert                                        from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const captured = [];
const realDb   = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", {
  namedExports: {
    ...realDb,
    getPrimaryPool      : () => ({ query: async (sql, params) => { captured.push({ sql, params }); return { rows: [] }; } }),
    queryWithAgentVector: async (_agent, sql, params, opts) => { captured.push({ sql, params, opts }); return { rows: [], rowCount: 0 }; }
  }
});

const {
  reviewViewer,
  isReviewVisible,
  appendReviewVisibility,
  reviewVisibilityParts,
  reviewPointClause,
  notPendingReviewSql,
  toReviewView,
  dropPendingReview,
  withReviewMarkers
} = await import("../../lib/memory/read/ReviewVisibility.js");
const { FragmentReader }     = await import("../../lib/memory/read/FragmentReader.js");
const { ContextBuilder }     = await import("../../lib/memory/read/ContextBuilder.js");
const { MemoryConsolidator } = await import("../../lib/memory/consolidate/MemoryConsolidator.js");
const { buildAnswerPack }    = await import("../../lib/memory/read/AnswerPack.js");
const { layerScope }         = await import("../../lib/memory/read/SearchLayerScope.js");

const PREDICATE = /review_state IS DISTINCT FROM 'pending' OR (?:f\.)?key_id (?:IS NOT DISTINCT FROM \$(\d+)|IS NULL)/;

/** 순수 판정과 SQL 술어가 따르는 표: [파편 상태, 파편 키, 보는 주체, 보이는가] */
const VISIBILITY_TABLE = [
  [null,       "key-a", "key-b", true],
  ["approved", "key-a", "key-b", true],
  ["rejected", "key-a", "key-b", true],
  ["pending",  "key-a", "key-a", true],
  ["pending",  "key-a", "key-b", false],
  ["pending",  "key-a", null,    false],
  ["pending",  null,    null,    true],
  ["pending",  null,    "key-a", false]
];

const saved           = process.env.MEMENTO_REVIEW_QUEUE;
const savedProvenance = process.env.MEMENTO_PROVENANCE;
beforeEach(() => { captured.length = 0; delete process.env.MEMENTO_REVIEW_QUEUE; });
afterEach(() => {
  if (saved === undefined) delete process.env.MEMENTO_REVIEW_QUEUE;
  else process.env.MEMENTO_REVIEW_QUEUE = saved;
  if (savedProvenance === undefined) delete process.env.MEMENTO_PROVENANCE;
  else process.env.MEMENTO_PROVENANCE = savedProvenance;
});

describe("가시성 술어", () => {
  for (const [state, key, viewer, visible] of VISIBILITY_TABLE) {
    it(`${state ?? "NULL"} 파편(키 ${key ?? "마스터"})을 ${viewer ?? "마스터"}가 ${visible ? "본다" : "보지 못한다"}`, () => {
      assert.equal(isReviewVisible({ review_state: state, key_id: key }, viewer), visible);
    });
  }

  it("SQL 술어는 같은 표를 따른다(쓴 키 비교는 NULL 동치)", () => {
    for (const [state, key, viewer, visible] of VISIBILITY_TABLE) {
      const conditions = [];
      const params     = [];
      appendReviewVisibility(conditions, params, { viewerKeyId: viewer });
      const [cond]  = conditions;
      const match   = cond.match(PREDICATE);
      assert.ok(match, cond);
      const writerMatches = match[1] ? (key ?? null) === (params[Number(match[1]) - 1] ?? null) : key === null;
      const sqlVisible    = state !== "pending" || writerMatches;
      assert.equal(sqlVisible, visible, `${state} ${key} ${viewer}`);
    }
  });

  it("보는 주체는 viewerKeyId, 단일 키, 원소 하나인 배열 순으로 정하고 그룹 배열은 마스터로 본다", () => {
    assert.equal(reviewViewer({ viewerKeyId: "own", keyId: ["own", "peer"] }), "own");
    assert.equal(reviewViewer({ viewerKeyId: null, keyId: "k" }), null);
    assert.equal(reviewViewer({ keyId: "k" }), "k");
    assert.equal(reviewViewer({ keyId: ["k"] }), "k");
    assert.equal(reviewViewer({ keyId: ["k", "peer"] }), null);
    assert.equal(reviewViewer({}), null);
  });

  it("마스터 보는 주체는 자리표시자를 늘리지 않는다", () => {
    const params = [];
    const conditions = [];
    appendReviewVisibility(conditions, params, { viewerKeyId: null }, "");
    assert.deepEqual(params, []);
    assert.equal(conditions[0], "(review_state IS DISTINCT FROM 'pending' OR key_id IS NULL)");
  });

  it("주입과 승격 술어는 쓴 키도 예외가 아니다", () => {
    assert.equal(notPendingReviewSql(), " AND review_state IS DISTINCT FROM 'pending'");
    assert.equal(notPendingReviewSql("f"), " AND f.review_state IS DISTINCT FROM 'pending'");
  });

  it("id 조회 술어는 API 키 조회에만 붙는다", () => {
    const params = ["id"];
    assert.equal(reviewPointClause(params, null), "");
    assert.match(reviewPointClause(params, "key-a"), /^ AND \(review_state IS DISTINCT FROM 'pending' OR key_id IS NOT DISTINCT FROM \$2\)$/);
    assert.deepEqual(params, ["id", "key-a"]);
  });

  it("MEMENTO_REVIEW_QUEUE=off이면 모든 조각이 비고 매개변수가 늘지 않는다", () => {
    process.env.MEMENTO_REVIEW_QUEUE = "off";
    const params = [];
    const conditions = [];
    assert.equal(appendReviewVisibility(conditions, params, { viewerKeyId: "k" }), "");
    assert.deepEqual(reviewVisibilityParts(params, { viewerKeyId: "k" }), { clause: "", select: "", column: "" });
    assert.equal(reviewPointClause(params, "k"), "");
    assert.equal(notPendingReviewSql(), "");
    assert.deepEqual(params, []);
    assert.deepEqual(conditions, []);
  });

  it("별칭은 식별자만 받는다", () => {
    assert.throws(() => appendReviewVisibility([], [], {}, "f; DROP"), TypeError);
  });
});

describe("recall 질의의 술어", () => {
  const reader = new FragmentReader();
  const last   = () => captured.at(-1);
  const viewerParam = ({ sql, params }) => {
    const match = sql.match(PREDICATE);
    assert.ok(match, sql);
    return match[1] ? params[Number(match[1]) - 1] : null;
  };

  it("키워드, 토픽, 시간 범위, 시맨틱 검색에 쓴 키 기준 술어와 검토 열이 붙는다", async () => {
    const options = { keyId: ["own", "peer"], viewerKeyId: "own", agentId: "default" };
    await reader.searchByKeywords(["k"], options);
    assert.equal(viewerParam(last()), "own");
    assert.match(last().sql, /f\.affect, f\.review_state/);
    await reader.searchByTopic("t", options);
    assert.equal(viewerParam(last()), "own");
    await reader.searchByTimeRange(null, null, options);
    assert.equal(viewerParam(last()), "own");
    await reader.searchBySemantic([0.1, 0.2], options);
    assert.equal(viewerParam(last()), "own");
    assert.equal(last().opts.forceVectorIndex, true);
  });

  it("id 보충 조회는 보는 주체를, id 조회는 호출 키를 쓴다", async () => {
    await reader.getByIds(["a"], "default", ["own", "peer"], [], { viewerKeyId: "own" });
    assert.equal(viewerParam(last()), "own");
    await reader.getById("a", "default", "own", ["own", "peer"]);
    assert.equal(viewerParam(last()), "own");
    await reader.getById("a", "default", null, []);
    assert.doesNotMatch(last().sql, /review_state/);
  });

  it("갱신 판정용 id 조회는 검토 열을 함께 읽는다", async () => {
    await reader.getById("a", "default", "own", [], { withReview: true });
    assert.match(last().sql, /assertion_status, review_state, review_reason/);
  });

  it("MEMENTO_REVIEW_QUEUE=off이면 recall 질의에 검토 술어와 열이 없다", async () => {
    process.env.MEMENTO_REVIEW_QUEUE = "off";
    await reader.searchByKeywords(["k"], { keyId: ["own"], viewerKeyId: "own" });
    assert.doesNotMatch(last().sql, /review_state/);
    await reader.getById("a", "default", "own", [], { withReview: true });
    assert.doesNotMatch(last().sql, /review_state/);
  });

  it("계층 공통 범위 옵션은 보는 주체를 싣는다", () => {
    assert.equal(layerScope({ viewerKeyId: "own" }).viewerKeyId, "own");
    assert.deepEqual(layerScope({ workspace: "w", allWorkspaces: true, _isMaster: true, includePeerAgents: true, isAnchor: false }), {
      workspace: "w", allWorkspaces: true, _isMaster: true, includePeerAgents: true, isAnchor: false, viewerKeyId: undefined
    });
  });
});

describe("앵커 승격", () => {
  it("검토 대기 파편은 승격 잠금 대상에서 빠진다", async () => {
    const consolidator = Object.create(MemoryConsolidator.prototype);
    await consolidator._promoteAnchors();
    assert.match(last().opts.lock.sql, /is_anchor = FALSE AND access_count >= 10 AND importance >= 0\.8 AND review_state IS DISTINCT FROM 'pending'/);
  });

  function last() { return captured.at(-1); }
});

/** 앵커 하나와 유형별 core 파편 두 개(쓴 키의 검토 대기 하나)를 돌려주는 ContextBuilder */
function makeBuilder(queries) {
  const recall = async params => {
    if (params.topic === "session_reflect") return { fragments: [] };
    return {
      fragments: [
        { id: "pending", type: params.type, content: "pending body", importance: 0.9, agent_id: "default", key_id: "own",
          workspace: null, created_at: "2026-09-20T10:00:00Z", assertion_status: "observed", pending_review: true },
        { id: "ok", type: params.type, content: "ok body", importance: 0.8, agent_id: "default", key_id: "own",
          workspace: null, created_at: "2026-09-21T10:00:00Z", assertion_status: "observed" }
      ]
    };
  };
  const pool = {
    query: async sql => {
      queries.push(sql);
      return { rows: [] };
    }
  };
  return new ContextBuilder({
    recall,
    store  : { searchBySource: async () => [] },
    index  : { getWorkingMemory: async () => [], setSeenIds: async () => {} },
    getPool: () => pool
  });
}

describe("ANCHOR와 CORE 주입", () => {
  /** 출처 등급 판정과 떼어 검토 대기 판정만 본다(출처 판정은 provenance-read 시험). */
  beforeEach(() => { process.env.MEMENTO_PROVENANCE = "off"; });

  it("앵커 조회는 검토 대기 파편을 빼고 core 후보에서도 쓴 키의 검토 대기 파편을 뺀다", async () => {
    const queries = [];
    const result  = await makeBuilder(queries).build({ types: ["error"], _keyId: "own" });
    const anchorSql = queries.filter(sql => /is_anchor = TRUE/.test(sql));
    assert.ok(anchorSql.length > 0);
    for (const sql of anchorSql) assert.match(sql, /AND review_state IS DISTINCT FROM 'pending'/);
    assert.ok(!result.injectionText.includes("pending body"), result.injectionText);
    assert.ok(result.injectionText.includes("ok body"), result.injectionText);
    assert.ok(!result.fragments.some(f => f.id === "pending"));
  });

  it("MEMENTO_REVIEW_QUEUE=off이면 앵커 술어가 없고 core를 거르지 않는다", async () => {
    process.env.MEMENTO_REVIEW_QUEUE = "off";
    const queries = [];
    const result  = await makeBuilder(queries).build({ types: ["error"], _keyId: "own" });
    for (const sql of queries) assert.doesNotMatch(sql, /review_state/);
    assert.ok(result.injectionText.includes("pending body"), result.injectionText);
  });

  it("dropPendingReview는 표지나 상태가 검토 대기인 후보만 뺀다", () => {
    const map = new Map([["fact", [{ id: "a", pending_review: true }, { id: "b", review_state: "pending" }, { id: "c" }]]]);
    assert.deepEqual(dropPendingReview(map).get("fact").map(f => f.id), ["c"]);
    assert.equal(map.get("fact").length, 3, "입력 맵은 그대로다");
  });
});

describe("쓴 키의 recall 응답 표지", () => {
  it("검토 열을 지우고 검토 대기 파편에 pending_review를 단다", () => {
    assert.deepEqual(toReviewView({ id: "a", review_state: "pending" }), { id: "a", pending_review: true });
    assert.deepEqual(toReviewView({ id: "b", review_state: null }), { id: "b" });
    const plain = { id: "c" };
    assert.equal(toReviewView(plain), plain);
  });

  it("MEMENTO_REVIEW_QUEUE=off이면 행을 바꾸지 않는다", () => {
    process.env.MEMENTO_REVIEW_QUEUE = "off";
    const row = { id: "a", review_state: "pending" };
    assert.equal(toReviewView(row), row);
  });

  it("기본 형식 응답에는 pending_review와 낮은 신뢰 표지를 fields와 무관하게 싣는다", () => {
    const base   = { success: true, fragments: [{ id: "a" }, { id: "b" }] };
    const marked = withReviewMarkers(base, [{ id: "a", pending_review: true }, { id: "b" }]);
    assert.deepEqual(marked.fragments, [{ id: "a", pending_review: true, low_trust: true }, { id: "b" }]);
    assert.equal(withReviewMarkers(base, [{ id: "a" }, { id: "b" }]), base);
  });

  it("답 꾸러미 항목과 여는 줄에 review=pending을 싣는다", () => {
    const pack = buildAnswerPack([
      { id: "a", content: "pending", topic: "t", type: "fact", created_at: "2026-09-30T00:00:00Z", pending_review: true },
      { id: "b", content: "plain", topic: "t", type: "fact", created_at: "2026-09-30T00:00:00Z" }
    ]);
    assert.equal(pack.items[0].review, "pending");
    assert.equal(Object.hasOwn(pack.items[1], "review"), false);
    const openers = pack.text.split("\n").filter(line => line.includes('id="'));
    assert.match(openers[0], / review=pending>>>$/);
    assert.doesNotMatch(openers[1], /review=/);
  });
});
