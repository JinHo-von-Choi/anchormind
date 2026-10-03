/**
 * 본문 어휘 채널 검색 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 질의 함수와 카탈로그 조회를 대역으로 바꿔 다음을 본다.
 *   1. buildLexicalSearchSql: tsquery와 범위 값은 모두 바인딩 값이고, 키, workspace, agent, 필터 조건이 붙는다
 *   2. attachLexicalScores: ts_rank_cd를 그 검색의 최고값 대비 0~1로 바꾸고 원시 열을 지운다
 *   3. LexicalSearch.search: 스위치, 열 없음, 색인 무효, 색인 없음, 빈 질의, 조회 오류
 *   4. RRF와 대체 경로 병합 도우미, 점수 전달
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert                                       from "node:assert/strict";

const warnings = [];
mock.module("../../lib/logger.js", {
  namedExports: {
    logWarn : (msg) => warnings.push(msg),
    logInfo : () => {},
    logError: () => {},
    logDebug: () => {}
  }
});

const {
  buildLexicalSearchSql, attachLexicalScores, LexicalSearch, LEXICAL_CANDIDATE_LIMIT,
  searchLexicalCandidates, lexicalLayer, appendLexicalCandidates, collectLexicalScores, restoreLexicalScores
} = await import("../../lib/memory/read/LexicalSearch.js");
const { resetLexicalSchema } = await import("../../lib/memory/LexicalSchema.js");
const { mergeRRF }           = await import("../../lib/memory/read/RankFusion.js");

beforeEach(() => {
  resetLexicalSchema();
  warnings.length = 0;
  delete process.env.MEMENTO_LEXICAL_CHANNEL;
});

afterEach(() => {
  delete process.env.MEMENTO_LEXICAL_CHANNEL;
});

describe("buildLexicalSearchSql", () => {
  it("tsquery는 첫 바인딩 값이고 일치, 순위, 상한이 붙는다", () => {
    const { sql, params } = buildLexicalSearchSql("'배포' | 'x''y'", { agentId: "agent-1" });
    assert.equal(params[0], "'배포' | 'x''y'");
    assert.equal(params[1], "agent-1");
    assert.match(sql, /f\.content_tokens @@ to_tsquery\('simple', \$1\)/);
    assert.match(sql, /ts_rank_cd\(f\.content_tokens, to_tsquery\('simple', \$1\)\) AS lexical_rank/);
    assert.match(sql, /ORDER BY lexical_rank DESC, f\.created_at DESC, f\.id ASC/);
    assert.equal(params.at(-1), LEXICAL_CANDIDATE_LIMIT);
    assert.match(sql, new RegExp(`LIMIT \\$${params.length}$`));
    assert.doesNotMatch(sql, /배포/);
  });

  it("agent 범위와 superseded 제외가 기본으로 붙는다", () => {
    const { sql } = buildLexicalSearchSql("'a'", {});
    assert.match(sql, /\(f\.agent_id = \$2 OR f\.agent_id = 'default'\)/);
    assert.match(sql, /valid_to IS NULL/);
  });

  it("키 하나와 키 묶음을 바인딩으로 격리한다", () => {
    const single = buildLexicalSearchSql("'a'", { keyId: "k1" });
    assert.match(single.sql, /f\.key_id = \$\d+/);
    assert.ok(single.params.includes("k1"));
    const group = buildLexicalSearchSql("'a'", { keyId: ["k1", "k2"] });
    assert.match(group.sql, /f\.key_id = ANY\(\$\d+::text\[\]\)/);
    assert.ok(group.params.some(p => Array.isArray(p) && p.includes("k2")));
  });

  it("마스터 요청(keyId 없음)은 키 조건을 두지 않는다", () => {
    assert.doesNotMatch(buildLexicalSearchSql("'a'", { keyId: null }).sql.split("WHERE")[1], /key_id/);
  });

  it("workspace 범위를 둔다", () => {
    const { sql, params } = buildLexicalSearchSql("'a'", { workspace: "ws-1" });
    assert.match(sql, /f\.workspace/);
    assert.ok(params.includes("ws-1"));
  });

  it("검색 필터를 모두 바인딩 값으로 붙인다", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const to   = new Date("2026-02-01T00:00:00Z");
    const { sql, params } = buildLexicalSearchSql("'a'", {
      type: "error", topic: "ops", caseId: "c-1", resolutionStatus: "open", phase: "debugging",
      isAnchor: true, affect: ["doubt"], timeRange: { from, to }, minImportance: 0.3, includeSuperseded: true
    });
    for (const column of ["f.type", "f.topic", "f.case_id", "f.resolution_status", "f.phase", "f.is_anchor", "f.affect", "f.created_at >=", "f.created_at <", "f.importance >="]) {
      assert.ok(sql.includes(column), column);
    }
    for (const value of ["error", "ops", "c-1", "open", "debugging", true, from, to, 0.3]) {
      assert.ok(params.includes(value), String(value));
    }
    assert.doesNotMatch(sql, /valid_to IS NULL/);
  });

  it("중요도 하한 기본값은 L2와 같은 0.1이다", () => {
    assert.ok(buildLexicalSearchSql("'a'", {}).params.includes(0.1));
  });

  it("peer agent 범위는 master 요청에서만 허용한다", () => {
    assert.throws(() => buildLexicalSearchSql("'a'", { includePeerAgents: true }));
    assert.match(buildLexicalSearchSql("'a'", { includePeerAgents: true, _isMaster: true }).sql, /peer-agent/);
  });
});

describe("attachLexicalScores", () => {
  it("최고값 대비 비율로 바꾸고 원시 열을 지운다", () => {
    const rows = attachLexicalScores([
      { id: "a", lexical_rank: 0.4 }, { id: "b", lexical_rank: 0.2 }, { id: "c", lexical_rank: 0 }
    ]);
    assert.deepEqual(rows.map(r => r.id), ["a", "b", "c"]);
    assert.deepEqual(rows.map(r => r._lexicalScore), [1, 0.5, 0]);
    assert.ok(rows.every(r => !("lexical_rank" in r)));
  });

  it("모든 순위가 0이면 점수도 0", () => {
    assert.deepEqual(attachLexicalScores([{ id: "a", lexical_rank: 0 }]).map(r => r._lexicalScore), [0]);
  });

  it("문자열로 온 순위도 숫자로 읽는다", () => {
    assert.deepEqual(attachLexicalScores([{ id: "a", lexical_rank: "0.5" }, { id: "b", lexical_rank: "0.25" }])
      .map(r => r._lexicalScore), [1, 0.5]);
  });
});

function stubDb({ column = true, indexes = [{ name: "idx_fragments_content_tokens", valid: true }], rows = [], fail = null } = {}) {
  const calls = { schema: 0, search: [] };
  const run   = async () => {
    calls.schema++;
    return { rows: [{ column_present: column, indexes }] };
  };
  const query = async (agentId, sql, params) => {
    if (fail) throw fail;
    calls.search.push({ agentId, sql, params });
    return { rows: rows.map(r => ({ ...r })) };
  };
  return { search: new LexicalSearch({ run, query }), calls };
}

describe("LexicalSearch.search", () => {
  const ROWS = [{ id: "a", content: "x", lexical_rank: 0.3 }, { id: "b", content: "y", lexical_rank: 0.1 }];

  it("후보에 상대 점수를 붙여 돌려준다", async () => {
    const { search, calls } = stubDb({ rows: ROWS });
    const out = await search.search("운영 서버 재시작", { agentId: "agent-1", keyId: "k1" });
    assert.deepEqual(out.map(r => r.id), ["a", "b"]);
    assert.equal(out[0]._lexicalScore, 1);
    assert.equal(calls.search[0].agentId, "agent-1");
    assert.match(calls.search[0].params[0], /'서버'/);
  });

  it("스위치가 off이면 카탈로그도 읽지 않는다", async () => {
    process.env.MEMENTO_LEXICAL_CHANNEL = "off";
    const { search, calls } = stubDb({ rows: ROWS });
    assert.deepEqual(await search.search("서버", {}), []);
    assert.equal(calls.schema, 0);
    assert.equal(calls.search.length, 0);
  });

  it("열이 없으면 참여하지 않고 경고를 한 번 남긴다", async () => {
    const { search, calls } = stubDb({ column: false, rows: ROWS });
    assert.deepEqual(await search.search("서버", {}), []);
    assert.deepEqual(await search.search("서버", {}), []);
    assert.equal(calls.search.length, 0);
    assert.equal(warnings.length, 1);
  });

  it("색인이 무효이면 참여하지 않는다", async () => {
    const { search, calls } = stubDb({ indexes: [{ name: "idx_fragments_content_tokens", valid: false }], rows: ROWS });
    assert.deepEqual(await search.search("서버", {}), []);
    assert.equal(calls.search.length, 0);
    assert.equal(warnings.length, 1);
  });

  it("색인이 없으면 경고를 한 번 남기고 검색한다", async () => {
    const { search, calls } = stubDb({ indexes: [], rows: ROWS });
    assert.equal((await search.search("서버", {})).length, 2);
    await search.search("서버", {});
    assert.equal(calls.search.length, 2);
    assert.equal(warnings.length, 1);
  });

  it("쓸 토큰이 없는 질의는 조회하지 않는다", async () => {
    const { search, calls } = stubDb({ rows: ROWS });
    assert.deepEqual(await search.search("!!! ...", {}), []);
    assert.deepEqual(await search.search("", {}), []);
    assert.equal(calls.search.length, 0);
  });

  it("조회 오류는 경고로 남기고 빈 결과를 돌려준다", async () => {
    const { search } = stubDb({ fail: Object.assign(new Error("canceling statement"), { code: "57014" }) });
    assert.deepEqual(await search.search("서버", {}), []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /57014|canceling/);
  });
});

describe("검색 계층 연결 도우미", () => {
  it("searchLexicalCandidates: text가 없거나 저장소에 메서드가 없으면 빈 배열", async () => {
    assert.deepEqual(await searchLexicalCandidates({}, { text: "서버" }), []);
    let called = false;
    const store = { searchByLexical: async () => { called = true; return [{ id: "a" }]; } };
    assert.deepEqual(await searchLexicalCandidates(store, { text: "" }), []);
    assert.equal(called, false);
    assert.deepEqual(await searchLexicalCandidates(store, { text: "서버", agentId: "x" }), [{ id: "a" }]);
  });

  it("searchLexicalCandidates: 저장소에 질의 text와 정규화된 질의를 넘긴다", async () => {
    const seen = [];
    const store = { searchByLexical: async (text, opts) => { seen.push({ text, opts }); return []; } };
    const sq    = { text: "서버", keyId: "k1", workspace: "ws" };
    await searchLexicalCandidates(store, sq);
    assert.equal(seen[0].text, "서버");
    assert.equal(seen[0].opts, sq);
  });

  it("lexicalLayer: 프로파일 가중을 쓰고 결과가 있을 때만 경로에 남긴다", () => {
    const path  = [];
    const layer = lexicalLayer([{ id: "a" }], { lexicalWeightFactor: 1.4 }, path);
    assert.deepEqual(layer, { name: "lexical", results: [{ id: "a" }], weightFactor: 1.4 });
    assert.deepEqual(path, ["Lexical:1"]);
    const none = [];
    assert.equal(lexicalLayer([], null, none).weightFactor, 1.0);
    assert.deepEqual(none, []);
  });

  it("mergeRRF는 어휘 점수를 다른 계층에서 먼저 온 객체로 옮긴다", () => {
    const merged = mergeRRF([
      { name: "l3",      results: [{ id: "a", content: "x", similarity: 0.8 }], weightFactor: 1 },
      { name: "lexical", results: [{ id: "a", content: "x", _lexicalScore: 0.6 }, { id: "b", content: "y", _lexicalScore: 1 }], weightFactor: 1 }
    ]);
    const a = merged.find(f => f.id === "a");
    assert.equal(a.similarity, 0.8);
    assert.equal(a._lexicalScore, 0.6);
    assert.equal(merged.find(f => f.id === "b")._lexicalScore, 1);
  });

  it("appendLexicalCandidates: 없는 후보는 뒤에 더하고 있는 후보에는 점수를 옮긴다", () => {
    const combined = [{ id: "l2", content: "x" }];
    const path     = [];
    appendLexicalCandidates(combined, [{ id: "l2", content: "x", _lexicalScore: 0.5 }, { id: "lex", content: "y", _lexicalScore: 1 }], path);
    assert.deepEqual(combined.map(f => f.id), ["l2", "lex"]);
    assert.equal(combined[0]._lexicalScore, 0.5);
    assert.deepEqual(path, ["Lexical:2"]);
  });

  it("collectLexicalScores와 restoreLexicalScores는 id로 점수를 옮긴다", () => {
    const scores = collectLexicalScores([{ id: "a", _lexicalScore: 0.7 }, { id: "b" }]);
    assert.deepEqual([...scores], [["a", 0.7]]);
    const fragments = [{ id: "a" }, { id: "b" }];
    restoreLexicalScores(fragments, scores);
    assert.equal(fragments[0]._lexicalScore, 0.7);
    assert.equal("_lexicalScore" in fragments[1], false);
    restoreLexicalScores(fragments, undefined);
  });
});
