/**
 * recall format:"pack" 응답과 대체 체인 조회 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 저장소 계층(MemoryManager, DB 풀)만 대체하고 실제 tool_recall을 거친다. format을 주지 않으면
 * 응답 shape가 그대로이고, pack이면 fragments 대신 pack을 싣는다. 출처와 대체 체인 조회는 recall과
 * 같은 agent, 키, workspace 술어를 쓰며, 조회가 실패하면 체인 없이 partial을 표시한다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert                             from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";
/** 출처 열을 싣는 동작은 provenance-read.test.js가 본다. 여기서는 꾸러미 v0 형태만 본다. */
process.env.MEMENTO_PROVENANCE      ??= "off";

const state = { result: null, queries: [], failProvenance: false };

const fakeManager = { recall: async () => structuredClone(state.result) };
const realManager = await import("../../lib/memory/MemoryManager.js");
mock.module("../../lib/memory/MemoryManager.js", {
  namedExports: { ...realManager, MemoryManager: { getInstance: () => fakeManager } }
});
const realUtils = await import("../../lib/utils.js");
mock.module("../../lib/utils.js", {
  namedExports: { ...realUtils, logAudit: async () => {} }
});

const isProvenanceSql = sql => /superseded_by/.test(sql) || /\bf\.source\b/.test(sql);
const stubPool = {
  query: async (sql, params) => {
    state.queries.push({ sql, params });
    if (isProvenanceSql(sql) && state.failProvenance) throw new Error("synthetic provenance failure");
    if (/superseded_by/.test(sql)) {
      return { rows: [
        { item_id: "old", other_id: "new", direction: "superseded_by" },
        { item_id: "new", other_id: "old", direction: "supersedes" }
      ] };
    }
    if (/\bf\.source\b/.test(sql)) {
      return { rows: [{ id: "new", source: "session:abc-123" }, { id: "old", source: "tool:remember" }] };
    }
    return { rows: [] };
  }
};
const realDb = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", {
  namedExports: { ...realDb, getPrimaryPool: () => stubPool }
});

const { tool_recall }         = await import("../../lib/tools/memory.js");
const { loadPackProvenance }  = await import("../../lib/memory/read/AnswerPackLoader.js");
const { countTokens }         = await import("../../lib/memory/write/FragmentFactory.js");

const fragment = (id, extra = {}) => ({
  id, content: `${id} body`, topic: "ops", type: "fact", importance: 0.5, created_at: "2026-09-30T10:00:00Z",
  valid_to: null, assertion_status: "observed", access_count: 0, ...extra
});

beforeEach(() => {
  state.queries        = [];
  state.failProvenance = false;
  state.result         = {
    fragments  : [fragment("new"), fragment("old", { valid_to: "2026-10-01T00:00:00Z" })],
    totalTokens: 12,
    searchPath : "stub"
  };
});

describe("recall format", () => {
  it("format이 없으면 기존 응답 shape이고 출처 조회를 하지 않는다", async () => {
    const response = await tool_recall({ keywords: ["k"] });

    assert.equal(response.success, true);
    assert.ok(Array.isArray(response.fragments));
    assert.equal(response.fragments.length, 2);
    assert.ok(!("format" in response));
    assert.ok(!("pack" in response));
    assert.equal(state.queries.filter(q => isProvenanceSql(q.sql)).length, 0);
  });

  it("format:pack은 fragments 대신 pack을 싣고 메타와 개수는 유지한다", async () => {
    const response = await tool_recall({ keywords: ["k"], format: "pack" });

    assert.equal(response.success, true);
    assert.equal(response.format, "pack");
    assert.ok(!("fragments" in response));
    assert.equal(response.count, 2);
    assert.equal(response.totalTokens, 12);
    assert.ok(response._meta && "searchEventId" in response._meta);
    assert.equal(response.pack.version, "v0");
    assert.equal(response.pack.partial, false);

    const byId = new Map(response.pack.items.map(item => [item.id, item]));
    assert.equal(byId.get("new").status, "valid");
    assert.equal(byId.get("old").status, "superseded");
    assert.deepEqual(byId.get("old").superseded_by, ["new"]);
    assert.deepEqual(byId.get("new").supersedes, ["old"]);
    assert.equal(byId.get("new").source, "session");
    assert.doesNotMatch(response.pack.text, /abc-123/);
  });

  it("pack.estimatedTokens는 직렬화한 꾸러미를 countTokens로 센 값이고 정책 문단은 text에만 있다", async () => {
    const response = await tool_recall({ keywords: ["k"], format: "pack" });
    const { estimatedTokens, ...rest } = response.pack;

    assert.equal(estimatedTokens, countTokens(JSON.stringify(rest, null, 2)));
    assert.ok(!("policy" in response.pack));
    assert.equal(typeof response.pack.policy_id, "string");
  });

  it("stale 경고와 검증 경고를 항목에 싣고 연결과 스티칭 맥락은 싣지 않는다", async () => {
    state.result.fragments[0].metadata            = { stale: true, warning: "검증 후 40일 지남" };
    state.result.fragments[0].validation_warnings = ["sensitive.email"];
    const response = await tool_recall({ keywords: ["k"], format: "pack" });
    const item     = response.pack.items.find(i => i.id === "new");

    assert.equal(item.stale_warning, "검증 후 40일 지남");
    assert.deepEqual(item.validation_warnings, ["sensitive.email"]);
    for (const key of ["linked", "stitched_context", "nearby_context", "content"]) assert.ok(!(key in item), key);
  });

  it("caseMode 결과에는 pack을 적용하지 않는다", async () => {
    state.result = { caseMode: true, cases: [{ case_id: "c" }], caseCount: 1, searchPath: "case", fragments: [] };
    const response = await tool_recall({ keywords: ["k"], caseMode: true, format: "pack" });

    assert.equal(response.caseMode, true);
    assert.deepEqual(response.cases, [{ case_id: "c" }]);
    assert.ok(!("pack" in response));
  });

  it("출처와 대체 체인 조회가 실패하면 체인 없이 partial을 표시한다", async () => {
    state.failProvenance = true;
    const response = await tool_recall({ keywords: ["k"], format: "pack" });

    assert.equal(response.success, true);
    assert.equal(response.pack.partial, true);
    assert.equal(response.pack.items.length, 2);
    for (const item of response.pack.items) {
      assert.deepEqual(item.superseded_by, []);
      assert.deepEqual(item.supersedes, []);
      assert.equal(item.source, null);
    }
  });
});

describe("loadPackProvenance", () => {
  it("두 조회 모두 agent, 키, workspace 술어를 쓰고 삭제된 링크를 제외한다", async () => {
    const calls = [];
    const pool  = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
    await loadPackProvenance(["a", "b"], {
      agentId: "agent-1", keyId: "key-1", groupKeyIds: ["key-1", "key-2"], workspace: "ws-a"
    }, () => pool);

    assert.equal(calls.length, 2);
    for (const { sql, params } of calls) {
      assert.match(sql, /key_id = ANY\(\$\d+::text\[\]\)/);
      assert.match(sql, /workspace/);
      assert.ok(params.includes("agent-1"));
      assert.ok(params.some(p => Array.isArray(p) && p.includes("key-2")));
      assert.ok(params.includes("ws-a"));
    }
    const chain = calls.find(c => /superseded_by/.test(c.sql));
    assert.ok(chain);
    assert.match(chain.sql, /deleted_at IS NULL/);
    assert.match(chain.sql, /relation_type = 'superseded_by'/);
  });

  it("대체 관계를 방향별로 모으고 출처를 붙인다", async () => {
    const pool = {
      query: async sql => (/superseded_by/.test(sql)
        ? { rows: [
          { item_id: "a", other_id: "z", direction: "supersedes" },
          { item_id: "a", other_id: "y", direction: "supersedes" },
          { item_id: "b", other_id: "a", direction: "superseded_by" }
        ] }
        : { rows: [{ id: "a", source: "tool:remember" }] })
    };
    const provenance = await loadPackProvenance(["a", "b"], {}, () => pool);

    assert.deepEqual(provenance.get("a"), { source: "tool:remember", supersededBy: [], supersedes: ["y", "z"] });
    assert.deepEqual(provenance.get("b"), { source: null, supersededBy: ["a"], supersedes: [] });
  });

  it("체인은 상대 파편의 created_at 내림차순, 같으면 id 오름차순으로 다섯 개까지 싣는다", async () => {
    const row = (other, at) => ({ item_id: "a", other_id: other, other_created_at: at, direction: "superseded_by" });
    const pool = {
      query: async sql => (/superseded_by/.test(sql)
        ? { rows: [
          row("old-1", "2026-01-01T00:00:00Z"),
          row("new-b", "2026-09-01T00:00:00Z"),
          row("none", null),
          row("new-a", "2026-09-01T00:00:00Z"),
          row("mid", "2026-05-01T00:00:00Z"),
          row("newest", "2026-10-01T00:00:00Z"),
          row("old-2", "2025-12-01T00:00:00Z")
        ] }
        : { rows: [] })
    };
    const provenance = await loadPackProvenance(["a"], {}, () => pool);
    assert.deepEqual(provenance.get("a").supersededBy, ["newest", "new-a", "new-b", "mid", "old-1"]);
  });

  it("체인 조회 SQL이 상대 파편의 created_at 내림차순으로 정렬한다", async () => {
    const calls = [];
    const pool  = { query: async sql => { calls.push(sql); return { rows: [] }; } };
    await loadPackProvenance(["a"], {}, () => pool);
    const chain = calls.find(sql => /superseded_by/.test(sql));
    assert.match(chain, /ORDER BY item_id, direction, other_created_at DESC NULLS LAST, other_id/);
  });

  it("id가 없거나 풀이 없으면 조회하지 않는다", async () => {
    let called = false;
    const pool = { query: async () => { called = true; return { rows: [] }; } };
    assert.equal((await loadPackProvenance([], {}, () => pool)).size, 0);
    assert.equal((await loadPackProvenance(["a"], {}, () => null)).size, 0);
    assert.equal(called, false);
  });
});
