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
  reviewPointClause,
  notPendingReviewSql,
  toReviewView,
  dropPendingReview,
  withReviewMarkers,
  recallViewer,
  REVIEW_VIEWER_NONE
} = await import("../../lib/memory/read/ReviewVisibility.js");
const { FragmentReader }     = await import("../../lib/memory/read/FragmentReader.js");
const { ContextBuilder }     = await import("../../lib/memory/read/ContextBuilder.js");
const { MemoryConsolidator } = await import("../../lib/memory/consolidate/MemoryConsolidator.js");
const { buildAnswerPack }    = await import("../../lib/memory/read/AnswerPack.js");
const { layerScope }         = await import("../../lib/memory/read/SearchLayerScope.js");
const { fetchLinkedFragments } = await import("../../lib/memory/read/LinkedFragmentLoader.js");
const { fetchCausalLinks, fetchSessionNeighbors } = await import("../../lib/memory/read/StitchSourceLoader.js");
const { LinkStore }            = await import("../../lib/memory/link/LinkStore.js");
const { CaseRecall }           = await import("../../lib/memory/read/CaseRecall.js");
const { HistoryReconstructor } = await import("../../lib/memory/read/HistoryReconstructor.js");
const { fetchGraphNeighbors }  = await import("../../lib/memory/read/GraphNeighborSearch.js");
const { listWorkingMemoryRows } = await import("../../lib/memory/WorkingMemoryRows.js");
const { ContradictionDetector } = await import("../../lib/memory/link/ContradictionDetector.js");

const PREDICATE = /review_state IS NULL OR (?:\w+\.)?review_state NOT IN \('pending', 'rejected'\) OR (?:\w+\.)?key_id (?:IS NOT DISTINCT FROM \$(\d+)|IS NULL)/;
const NOT_HELD  = /review_state IS NULL OR (?:\w+\.)?review_state NOT IN \('pending', 'rejected'\)\)/;

/** 순수 판정과 SQL 술어가 따르는 표: [파편 상태, 파편 키, 보는 주체, 보이는가] */
const VISIBILITY_TABLE = [
  [null,       "key-a", "key-b", true],
  ["approved", "key-a", "key-b", true],
  ["rejected", "key-a", "key-b", false],
  ["rejected", "key-a", "key-a", true],
  ["rejected", "key-a", null,    false],
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
      const sqlVisible    = !["pending", "rejected"].includes(state) || writerMatches;
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
    assert.equal(conditions[0], "(review_state IS NULL OR review_state NOT IN ('pending', 'rejected') OR key_id IS NULL)");
  });

  it("주입 후보 조회의 보는 주체(REVIEW_VIEWER_NONE)는 쓴 키도 예외로 두지 않는다", () => {
    const params = [];
    const conditions = [];
    appendReviewVisibility(conditions, params, { viewerKeyId: REVIEW_VIEWER_NONE });
    assert.deepEqual(params, []);
    assert.equal(conditions[0], "(f.review_state IS NULL OR f.review_state NOT IN ('pending', 'rejected'))");
    assert.equal(isReviewVisible({ review_state: "pending", key_id: "own" }, REVIEW_VIEWER_NONE), false);
    assert.equal(recallViewer({ excludePendingReview: true }, "own"), REVIEW_VIEWER_NONE);
    assert.equal(recallViewer({}, "own"), "own");
  });

  it("주입과 승격 술어는 쓴 키도 예외가 아니다", () => {
    assert.equal(notPendingReviewSql(), " AND (review_state IS NULL OR review_state NOT IN ('pending', 'rejected'))");
    assert.equal(notPendingReviewSql("f"), " AND (f.review_state IS NULL OR f.review_state NOT IN ('pending', 'rejected'))");
  });

  it("id 조회 술어는 API 키 조회에만 붙는다", () => {
    const params = ["id"];
    assert.equal(reviewPointClause(params, null), "");
    assert.match(reviewPointClause(params, "key-a"), /^ AND \(review_state IS NULL OR review_state NOT IN \('pending', 'rejected'\) OR key_id IS NOT DISTINCT FROM \$2\)$/);
    assert.deepEqual(params, ["id", "key-a"]);
  });

  it("MEMENTO_REVIEW_QUEUE=off여도 가시성 술어는 그대로다(off는 새 표지만 멈춘다)", () => {
    process.env.MEMENTO_REVIEW_QUEUE = "off";
    const params = [];
    const conditions = [];
    assert.equal(appendReviewVisibility(conditions, params, { viewerKeyId: "k" }), ", f.review_state");
    assert.match(conditions[0], PREDICATE);
    assert.match(reviewPointClause(params, "k"), PREDICATE);
    assert.match(notPendingReviewSql(), NOT_HELD);
    assert.equal(isReviewVisible({ review_state: "pending", key_id: "a" }, "b"), false);
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
    assert.match(last().sql, /f\.affect,\s+f\.content_hash, f\.review_state/);
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

  it("MEMENTO_REVIEW_QUEUE=off여도 recall 질의의 술어는 그대로다", async () => {
    process.env.MEMENTO_REVIEW_QUEUE = "off";
    await reader.searchByKeywords(["k"], { keyId: ["own", "peer"], viewerKeyId: "own" });
    assert.equal(viewerParam(last()), "own");
  });

  it("대체 체인은 호출 키 기준 술어를 거친다", async () => {
    const origGetById = reader.getById;
    reader.getById = async () => ({ id: "a" });
    try {
      await reader.getHistory("a", "default", "own", ["own", "peer"]);
    } finally {
      reader.getById = origGetById;
    }
    const chain = captured.find(q => /superseded_by/.test(q.sql));
    assert.equal(viewerParam(chain), "own");
  });

  it("계층 공통 범위 옵션은 보는 주체를 싣는다", () => {
    assert.equal(layerScope({ viewerKeyId: "own" }).viewerKeyId, "own");
    assert.deepEqual(layerScope({ workspace: "w", allWorkspaces: true, _isMaster: true, includePeerAgents: true, isAnchor: false }), {
      workspace: "w", allWorkspaces: true, _isMaster: true, includePeerAgents: true, isAnchor: false, viewerKeyId: undefined
    });
  });
});

describe("recall 부속 경로의 술어", () => {
  const group = ["own", "peer"];
  const viewerOf = ({ sql, params }) => {
    const matches = [...sql.matchAll(new RegExp(PREDICATE.source, "g"))];
    assert.ok(matches.length > 0, sql);
    return [...new Set(matches.map(m => (m[1] ? params[Number(m[1]) - 1] : null)))];
  };

  it("연결 미리보기, 인과 이웃, 세션 이웃, 그래프 이웃, 연결 확장, RCA 체인, 사례, 이력 재구성에 호출 키 기준 술어가 붙는다", async () => {
    await fetchLinkedFragments(["a"], { keyId: "own", groupKeyIds: group });
    assert.deepEqual(viewerOf(captured.at(-1)), ["own"]);
    await fetchCausalLinks(["a"], { keyId: "own", groupKeyIds: group });
    assert.deepEqual(viewerOf(captured.at(-1)), ["own"]);
    await fetchSessionNeighbors([{ id: "a", session_id: "s", created_at: new Date() }], { keyId: "own", groupKeyIds: group });
    assert.deepEqual(viewerOf(captured.at(-1)), ["own"]);
    await fetchGraphNeighbors(["a"], 10, "default", group, { viewerKeyId: "own" });
    assert.deepEqual(viewerOf(captured.at(-1)), ["own"]);
    await new LinkStore().getLinkedFragments(["a"], null, "default", group, { viewerKeyId: "own" });
    assert.deepEqual(viewerOf(captured.at(-1)), ["own"]);
    await new LinkStore().getRCAChain("a", "default", "own", group);
    assert.deepEqual(viewerOf(captured.at(-1)), ["own"]);
    await new CaseRecall().buildCaseTriples([{ id: "a", case_id: "c1" }], { keyId: "own", groupKeyIds: group });
    assert.deepEqual(viewerOf(captured.find(q => /case_id = ANY\(\$1\)/.test(q.sql))), ["own"]);
    await new HistoryReconstructor()._fetchTimelineParameterized({ caseId: "c1", keyId: "own", groupKeyIds: group, limit: 10 });
    assert.deepEqual(viewerOf(captured.at(-1)), ["own"]);
  });

  it("마스터 호출은 마스터가 쓴 검토 대기 파편만 본다(key_id IS NULL)", async () => {
    await fetchLinkedFragments(["a"], {});
    assert.deepEqual(viewerOf(captured.at(-1)), [null]);
  });
});

describe("모순 해소", () => {
  const frag = (id, extra = {}) => ({ id, key_id: "own", created_at: "2026-10-0" + (id === "new" ? "3" : "1") + "T00:00:00Z", content: id, ...extra });

  it("검토 대기나 거절 파편이 끼면 대체 링크를 만들거나 파편을 닫지 않는다", async () => {
    for (const held of ["pending", "rejected"]) {
      const links = [];
      const detector = new ContradictionDetector({ createLink: async (...args) => { links.push(args); } });
      captured.length = 0;
      await detector.resolveContradiction(frag("new", { review_state: held }), frag("old"), "r");
      await detector.resolveContradiction(frag("new"), frag("old", { review_state: held }), "r");
      assert.deepEqual(links, [], held);
      assert.ok(!captured.some(q => /SET valid_to/.test(q.sql)), held);

      const consolidator = Object.create(MemoryConsolidator.prototype);
      consolidator.store = { createLink: async (...args) => { links.push(args); } };
      await consolidator._resolveContradiction(frag("new", { review_state: held }), frag("old"), "r");
      assert.deepEqual(links, [], held);
    }
  });

  it("모순 탐지 후보 질의는 검토 대기와 거절 파편을 뺀다", async () => {
    captured.length = 0;
    await new ContradictionDetector({}).detectContradictions().catch(() => {});
    const newFrags = captured.find(q => /watermark_at/.test(q.sql));
    assert.ok(newFrags, "새 파편 질의");
    assert.match(newFrags.sql, NOT_HELD);
  });
});

describe("앵커 승격", () => {
  it("검토 대기 파편은 승격 잠금 대상에서 빠진다", async () => {
    const consolidator = Object.create(MemoryConsolidator.prototype);
    await consolidator._promoteAnchors();
    assert.match(last().opts.lock.sql, /is_anchor = FALSE AND access_count >= 10 AND importance >= 0\.8 AND \(review_state IS NULL OR review_state NOT IN \('pending', 'rejected'\)\)/);
  });

  function last() { return captured.at(-1); }
});

/** 앵커 하나와 유형별 core 파편 두 개(쓴 키의 검토 대기 하나)를 돌려주는 ContextBuilder */
function makeBuilder(queries, workingMemory = []) {
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
    index  : { getWorkingMemory: async () => workingMemory, setSeenIds: async () => {} },
    getPool: () => pool
  });
}

const wmItem = (id, extra = {}) => ({
  id, content: `${id} body`, type: "fact", agent_id: "default", key_id: "own", workspace: null,
  added_at: "2026-10-03T00:00:00Z", created_at: "2026-10-03T00:00:00Z", ...extra
});

describe("ANCHOR와 CORE 주입", () => {
  /** 출처 등급 판정과 떼어 검토 대기 판정만 본다(출처 판정은 provenance-read 시험). */
  beforeEach(() => { process.env.MEMENTO_PROVENANCE = "off"; });

  it("앵커 조회는 검토 대기 파편을 빼고 core 후보에서도 쓴 키의 검토 대기 파편을 뺀다", async () => {
    const queries = [];
    const result  = await makeBuilder(queries).build({ types: ["error"], _keyId: "own" });
    const anchorSql = queries.filter(sql => /is_anchor = TRUE/.test(sql));
    assert.ok(anchorSql.length > 0);
    for (const sql of anchorSql) assert.match(sql, NOT_HELD);
    assert.ok(!result.injectionText.includes("pending body"), result.injectionText);
    assert.ok(result.injectionText.includes("ok body"), result.injectionText);
    assert.ok(!result.fragments.some(f => f.id === "pending"));
  });

  it("MEMENTO_REVIEW_QUEUE=off여도 앵커 술어와 core 거르기는 그대로다", async () => {
    process.env.MEMENTO_REVIEW_QUEUE = "off";
    const queries = [];
    const result  = await makeBuilder(queries).build({ types: ["error"], _keyId: "own" });
    for (const sql of queries.filter(q => /is_anchor = TRUE/.test(q))) assert.match(sql, NOT_HELD);
    assert.ok(!result.injectionText.includes("pending body"), result.injectionText);
  });

  it("core 후보 recall은 검토 대기와 거절 파편을 SQL에서 빼도록 요청한다", async () => {
    const seen = [];
    const builder = new ContextBuilder({
      recall : async (params) => { seen.push(params); return { fragments: [] }; },
      store  : { searchBySource: async () => [] },
      index  : { getWorkingMemory: async () => [], setSeenIds: async () => {} },
      getPool: () => ({ query: async () => ({ rows: [] }) })
    });
    await builder.build({ types: ["error"], _keyId: "own" });
    assert.ok(seen.length > 0);
    for (const params of seen) assert.equal(params.excludePendingReview, true);
  });

  it("세션 작업 기억의 검토 대기 항목도 주입하지 않는다", async () => {
    const wm = [wmItem("wm-pending", { review_state: "pending" }), wmItem("wm-ok")];
    const result = await makeBuilder([], wm).build({ types: ["error"], _keyId: "own", sessionId: "s1" });
    assert.ok(result.injectionText.includes("wm-ok body"), result.injectionText);
    assert.ok(!result.injectionText.includes("wm-pending body"), result.injectionText);
  });

  it("작업 기억 대체 행 조회는 검토 대기 행을 읽지 않는다", async () => {
    await listWorkingMemoryRows("s1");
    assert.match(captured.at(-1).sql, /valid_to IS NOT NULL AND \(review_state IS NULL OR review_state NOT IN \('pending', 'rejected'\)\)/);
  });

  it("dropPendingReview는 표지나 상태가 검토 대기인 후보만 뺀다", () => {
    const map = new Map([["fact", [{ id: "a", pending_review: true }, { id: "b", review_state: "pending" }, { id: "c" }, { id: "d", review_rejected: true }]]]);
    assert.deepEqual(dropPendingReview(map).get("fact").map(f => f.id), ["c"]);
    assert.equal(map.get("fact").length, 4, "입력 맵은 그대로다");
  });
});

describe("쓴 키의 recall 응답 표지", () => {
  it("검토 열을 지우고 검토 대기 파편에 pending_review를 단다", () => {
    assert.deepEqual(toReviewView({ id: "a", review_state: "pending" }), { id: "a", pending_review: true });
    assert.deepEqual(toReviewView({ id: "b", review_state: null }), { id: "b" });
    const plain = { id: "c" };
    assert.equal(toReviewView(plain), plain);
  });

  it("거절 파편(쓴 키의 includeSuperseded 조회)에는 review_rejected를 달고 off에서도 같다", () => {
    process.env.MEMENTO_REVIEW_QUEUE = "off";
    assert.deepEqual(toReviewView({ id: "a", review_state: "rejected" }), { id: "a", review_rejected: true });
    assert.deepEqual(toReviewView({ id: "b", review_state: "pending" }), { id: "b", pending_review: true });
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
