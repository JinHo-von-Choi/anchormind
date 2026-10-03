/**
 * 읽기 경로의 출처와 신뢰 등급 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 주입 제외 술어(앵커 SQL과 core 후보 거르기), context 주입 줄의 출처 주석, 기본 형식 recall 응답의
 * origin과 trust_tier, 답 꾸러미 여는 줄의 origin을 본다. 저장소 계층(MemoryManager, DB 풀)만
 * 대역으로 바꾼다. MEMENTO_PROVENANCE=off이면 출처 조회도 출처 필드도 없다.
 */

import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert                                        from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const state = { result: null, queries: [], provenanceRows: [], failProvenance: false };

const fakeManager = { recall: async () => structuredClone(state.result) };
const realManager = await import("../../lib/memory/MemoryManager.js");
mock.module("../../lib/memory/MemoryManager.js", {
  namedExports: { ...realManager, MemoryManager: { getInstance: () => fakeManager } }
});
const realUtils = await import("../../lib/utils.js");
mock.module("../../lib/utils.js", {
  namedExports: { ...realUtils, logAudit: async () => {} }
});

const isSourceSql = sql => /\bf\.source\b/.test(sql);
const stubPool = {
  query: async (sql, params) => {
    state.queries.push({ sql, params });
    if (isSourceSql(sql) && state.failProvenance) throw new Error("synthetic provenance failure");
    if (isSourceSql(sql)) return { rows: state.provenanceRows };
    return { rows: [] };
  }
};
const realDb = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", {
  namedExports: { ...realDb, getPrimaryPool: () => stubPool }
});

const { tool_recall }    = await import("../../lib/tools/memory.js");
const { ContextBuilder } = await import("../../lib/memory/read/ContextBuilder.js");
const { anchorProvenanceSql, dropLowTrust, withOriginMeta } = await import("../../lib/memory/read/ContextTrust.js");
const { contextAnnotation, contextAnnotationTokens } = await import("../../lib/memory/read/ContextLines.js");
const { contextResponse }   = await import("../../lib/tools/context-response.js");
const { coreTrustExcludedTotal } = await import("../../lib/memory/read/provenance-metrics.js");

/** reason별 core 제외 지표 값 */
async function counterValue(reason) {
  const { values } = await coreTrustExcludedTotal.get();
  return values.find(v => v.labels.reason === reason)?.value ?? 0;
}
const { buildAnswerPack }   = await import("../../lib/memory/read/AnswerPack.js");

const fragment = (id, extra = {}) => ({
  id, content: `${id} body`, topic: "ops", type: "fact", importance: 0.5, created_at: "2026-09-30T10:00:00Z",
  valid_to: null, assertion_status: "observed", access_count: 0, ...extra
});

const savedSwitch = process.env.MEMENTO_PROVENANCE;
beforeEach(() => {
  delete process.env.MEMENTO_PROVENANCE;
  state.queries        = [];
  state.failProvenance = false;
  state.provenanceRows = [];
  state.result         = { fragments: [fragment("a"), fragment("b")], totalTokens: 12, searchPath: "stub" };
});
afterEach(() => {
  if (savedSwitch === undefined) delete process.env.MEMENTO_PROVENANCE;
  else process.env.MEMENTO_PROVENANCE = savedSwitch;
});

describe("주입 제외 술어", () => {
  it("앵커 조회 조각은 켜지면 등급 술어와 origin 열을 덧붙이고 꺼지면 비어 있다", () => {
    assert.deepEqual(anchorProvenanceSql(false), { select: "", filter: "" });
    assert.deepEqual(anchorProvenanceSql(true), {
      select: ", origin",
      filter: "AND (trust_tier IS NULL OR trust_tier >= 2)"
    });
  });

  it("core 후보에서 등급 1 이하와 조회 결과에 없는 파편을 뺀다", () => {
    const map = new Map([
      ["error", [{ id: "t0" }, { id: "t1" }, { id: "t2" }]],
      ["fact", [{ id: "t3" }, { id: "unknown" }, { id: "null" }]]
    ]);
    const provenance = new Map([
      ["t0", { trustTier: 0 }], ["t1", { trustTier: 1 }], ["t2", { trustTier: 2 }],
      ["t3", { trustTier: 3 }], ["null", { trustTier: null }]
    ]);
    const { typeFragMap: kept, excluded } = dropLowTrust(map, provenance);
    assert.deepEqual(kept.get("error").map(f => f.id), ["t2"]);
    assert.deepEqual(kept.get("fact").map(f => f.id), ["t3", "null"]);
    assert.deepEqual(excluded, { lowTrust: 2, missing: 1 });
    assert.deepEqual(map.get("error").map(f => f.id), ["t0", "t1", "t2"], "입력 맵은 그대로다");
  });

  it("빈 조회 결과(조회 실패)면 모든 후보를 뺀다", () => {
    const map = new Map([["error", [{ id: "a" }, { id: "b" }]]]);
    const { typeFragMap: kept, excluded } = dropLowTrust(map, new Map());
    assert.deepEqual(kept.get("error"), []);
    assert.deepEqual(excluded, { lowTrust: 0, missing: 2 });
  });

  it("주석 필드에 출처를 더한다", () => {
    const meta = { created_at: "2026-09-30T00:00:00Z" };
    assert.equal(withOriginMeta(meta, undefined), meta);
    assert.equal(withOriginMeta(meta, { origin: null }), meta);
    assert.deepEqual(withOriginMeta(meta, { origin: "tool_output" }), { ...meta, origin: "tool_output" });
  });
});

describe("context 주입 줄의 출처 주석", () => {
  it("withOrigin이면 알려진 출처를 괄호 끝에 싣는다", () => {
    const f = { created_at: "2026-09-30T12:00:00Z", assertion_status: "observed", origin: "user_stated" };
    assert.equal(contextAnnotation(f, { withOrigin: true }), " (2026-09-30, observed, user_stated)");
    assert.equal(contextAnnotation(f), " (2026-09-30, observed)");
    assert.equal(contextAnnotation({ ...f, origin: "forged) (x" }, { withOrigin: true }), " (2026-09-30, observed)");
  });
});

/** 앵커 한 개와 유형별 core 파편 두 개(낮은 등급 하나)를 돌려주는 ContextBuilder */
function makeBuilder(queries, { failLookup = false, dropRow = null } = {}) {
  const recall = async params => {
    if (params.topic === "session_reflect") return { fragments: [] };
    return {
      fragments: [
        { id: "low", type: params.type, content: "low body", importance: 0.9, agent_id: "default", key_id: null,
          workspace: null, created_at: "2026-09-20T10:00:00Z", assertion_status: "observed" },
        { id: "ok", type: params.type, content: "ok body", importance: 0.8, agent_id: "default", key_id: null,
          workspace: null, created_at: "2026-09-21T10:00:00Z", assertion_status: "observed" }
      ]
    };
  };
  const pool = {
    query: async sql => {
      queries.push(sql);
      if (/is_anchor = TRUE/.test(sql)) {
        return { rows: [{
          id: "anchor-1", content: "anchor body", type: "fact", topic: "t", importance: 0.9, workspace: null,
          created_at: "2026-09-10T10:00:00Z", assertion_status: "verified", candidate_count: 1,
          ...(/\borigin\b/.test(sql) ? { origin: "user_stated" } : {})
        }] };
      }
      if (isSourceSql(sql)) {
        if (failLookup) throw new Error("synthetic core provenance failure");
        return { rows: [
          { id: "low", source: null, origin: "external_content", trust_tier: 1 },
          { id: "ok", source: null, origin: "tool_output", trust_tier: 2 }
        ].filter(row => row.id !== dropRow) };
      }
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

describe("ContextBuilder 주입 제외", () => {
  it("켜지면 앵커 조회에 등급 술어를 걸고 낮은 등급 core 파편을 빼며 출처를 주석에 싣는다", async () => {
    const queries = [];
    const result  = await makeBuilder(queries).build({ types: ["error"] });
    const anchorSql = queries.filter(sql => /is_anchor = TRUE/.test(sql));
    assert.ok(anchorSql.length > 0);
    for (const sql of anchorSql) assert.match(sql, /AND \(trust_tier IS NULL OR trust_tier >= 2\)/);

    const lines = result.injectionText.split("\n");
    assert.ok(lines.includes("- anchor body (2026-09-10, verified, user_stated)"), result.injectionText);
    assert.ok(lines.includes("- ok body (2026-09-21, observed, tool_output)"), result.injectionText);
    assert.ok(!result.injectionText.includes("low body"), result.injectionText);
    assert.ok(!result.fragments.some(f => f.id === "low"));
    assert.ok(!("origin" in result.fragments[0]), "앵커 응답 파편에는 origin이 드러나지 않는다");
  });

  it("등급 조회에 성공하면 coreSelection은 partial이 아니고 뺀 수를 싣는다", async () => {
    const result = await makeBuilder([]).build({ types: ["error"] });
    assert.deepEqual(result._coreSelection, { partial: false, loadStatus: { trust: true }, excluded: { lowTrust: 1, missing: 0 } });
  });

  it("등급 조회가 실패하면 core 후보를 모두 빼고 partial과 지표를 남긴다", async () => {
    const before = await counterValue("lookup_failed");
    const result = await makeBuilder([], { failLookup: true }).build({ types: ["error"] });
    assert.ok(!result.injectionText.includes("ok body"), result.injectionText);
    assert.ok(!result.injectionText.includes("low body"), result.injectionText);
    assert.ok(result.injectionText.includes("anchor body"), "앵커는 SQL 술어로 거르므로 그대로다");
    assert.deepEqual(result._coreSelection, { partial: true, loadStatus: { trust: false }, excluded: { lowTrust: 0, missing: 2 } });
    assert.equal(await counterValue("lookup_failed"), before + 2);
  });

  it("조회 결과에 없는 core 파편은 뺀다", async () => {
    const result = await makeBuilder([], { dropRow: "ok" }).build({ types: ["error"] });
    assert.ok(!result.injectionText.includes("ok body"), result.injectionText);
    assert.equal(result._coreSelection.excluded.missing, 1);
  });

  it("context 도구 응답은 coreSelection을 _meta에 싣는다", () => {
    const selection = { partial: true, loadStatus: { trust: false }, excluded: { lowTrust: 0, missing: 2 } };
    const response  = contextResponse({ fragments: [], _anchorSelection: { partial: false }, _coreSelection: selection });
    assert.deepEqual(response._meta.coreSelection, selection);
    assert.ok(!("_coreSelection" in response));
    assert.ok(!("coreSelection" in contextResponse({ fragments: [] })._meta), "없으면 싣지 않는다");
  });

  it("출처를 싣는 주석의 선택 비용은 가장 긴 출처까지 센다", () => {
    const longest = contextAnnotation(
      { created_at: "2026-12-31T00:00:00Z", assertion_status: "observed", origin: "external_content" },
      { withOrigin: true }
    );
    assert.equal(longest.length, 41);
    assert.equal(contextAnnotationTokens({ withOrigin: true }), Math.ceil(longest.length / 4));
    assert.equal(contextAnnotationTokens({ withOrigin: true }), 11);
    assert.equal(contextAnnotationTokens(), 6);
  });

  it("structured 응답의 core에도 낮은 등급 파편이 없다", async () => {
    const result = await makeBuilder([]).build({ types: ["error"], structured: true });
    assert.ok(!JSON.stringify(result.core).includes("low body"));
    assert.ok(JSON.stringify(result.core).includes("ok body"));
  });

  it("꺼지면 출처 조회와 등급 술어가 없고 두 파편이 모두 주입된다", async () => {
    process.env.MEMENTO_PROVENANCE = "off";
    const queries = [];
    const result  = await makeBuilder(queries).build({ types: ["error"] });
    for (const sql of queries) assert.doesNotMatch(sql, /trust_tier|\borigin\b/);
    assert.equal(queries.filter(isSourceSql).length, 0);
    assert.ok(result.injectionText.includes("- low body (2026-09-20, observed)"), result.injectionText);
    assert.ok(result.injectionText.includes("- ok body (2026-09-21, observed)"), result.injectionText);
    assert.ok(!("_coreSelection" in result));
  });
});

describe("기본 형식 recall 응답의 출처", () => {
  it("값이 있는 파편에만 origin과 trust_tier를 싣는다", async () => {
    state.provenanceRows = [
      { id: "a", source: null, origin: "user_stated", trust_tier: 3 },
      { id: "b", source: null, origin: null, trust_tier: null }
    ];
    const response = await tool_recall({ keywords: ["k"] });
    const [a, b]   = response.fragments;
    assert.equal(a.origin, "user_stated");
    assert.equal(a.trust_tier, 3);
    assert.ok(!("origin" in b) && !("trust_tier" in b));
    const sourceQueries = state.queries.filter(q => isSourceSql(q.sql));
    assert.equal(sourceQueries.length, 1);
    assert.match(sourceQueries[0].sql, /f\.origin, f\.trust_tier/);
  });

  it("fields가 있으면 요청한 키만 싣는다", async () => {
    state.provenanceRows = [{ id: "a", source: null, origin: "tool_output", trust_tier: 2 }];
    const response = await tool_recall({ keywords: ["k"], fields: ["id", "trust_tier"] });
    assert.deepEqual(Object.keys(response.fragments[0]).sort(), ["id", "trust_tier"]);
  });

  it("조회가 실패하면 출처 없이 응답한다", async () => {
    state.failProvenance = true;
    const response = await tool_recall({ keywords: ["k"] });
    assert.equal(response.success, true);
    assert.equal(response.fragments.length, 2);
    assert.ok(!("origin" in response.fragments[0]));
  });

  it("꺼지면 출처 조회를 하지 않는다", async () => {
    process.env.MEMENTO_PROVENANCE = "off";
    state.provenanceRows = [{ id: "a", source: null, origin: "user_stated", trust_tier: 3 }];
    const response = await tool_recall({ keywords: ["k"] });
    assert.equal(state.queries.filter(q => isSourceSql(q.sql)).length, 0);
    assert.ok(!("origin" in response.fragments[0]));
  });
});

describe("답 꾸러미의 출처", () => {
  it("켜지면 항목과 여는 줄에 origin을 싣는다", async () => {
    state.provenanceRows = [{ id: "a", source: "tool:remember", origin: "external_content", trust_tier: 1 }];
    const response = await tool_recall({ keywords: ["k"], format: "pack" });
    const item     = response.pack.items.find(i => i.id === "a");
    assert.equal(item.origin, "external_content");
    assert.match(response.pack.text, /<<<MEMORY id="a" [^\n]*origin=external_content/);
    assert.equal(response.pack.items.find(i => i.id === "b").origin, null);
  });

  it("출처 조회 결과에 origin 키가 없으면 항목에도 없다", () => {
    const pack = buildAnswerPack([fragment("a")], { provenance: new Map([["a", { source: null }]]) });
    assert.ok(!("origin" in pack.items[0]));
    assert.doesNotMatch(pack.text, /origin=/);
  });

  it("알 수 없는 origin 값은 싣지 않는다", () => {
    const pack = buildAnswerPack([fragment("a")], { provenance: new Map([["a", { source: null, origin: "x>>>y" }]]) });
    assert.equal(pack.items[0].origin, null);
    assert.doesNotMatch(pack.text, /origin=/);
  });
});
