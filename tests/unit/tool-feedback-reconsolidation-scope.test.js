/**
 * tool_feedback 재통합 링크 조회의 키 범위 시험.
 * 실제 tool_toolFeedback을 호출하고 DB 풀, MemoryManager, 재통합 엔진만 대체한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, mock, beforeEach, after } from "node:test";
import assert                                    from "node:assert/strict";

const KEY_A   = "aaaaaaaa-0000-4000-8000-000000000001";
const GROUP   = [KEY_A, "cccccccc-0000-4000-8000-000000000003"];
const queries = [];
const reconsolidated = [];

const fakePool = {
  query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: /fragment_links/.test(sql) ? [{ id: 11 }, { id: 12 }] : [] };
  }
};

const realDb = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", {
  namedExports: { ...realDb, getPrimaryPool: () => fakePool }
});

const realEngine = await import("../../lib/memory/link/ReconsolidationEngine.js");
mock.module("../../lib/memory/link/ReconsolidationEngine.js", {
  namedExports: {
    ...realEngine,
    reconsolidate: async (id, action, opts) => { reconsolidated.push({ id, action, opts }); }
  }
});

const { MemoryManager }       = await import("../../lib/memory/MemoryManager.js");
const { tool_toolFeedback }   = await import("../../lib/tools/memory.js");

const savedFlag = process.env.ENABLE_RECONSOLIDATION;
process.env.ENABLE_RECONSOLIDATION = "true";
mock.method(MemoryManager, "getInstance", () => ({ toolFeedback: async () => ({ recorded: true }) }));

after(() => {
  if (savedFlag === undefined) delete process.env.ENABLE_RECONSOLIDATION;
  else process.env.ENABLE_RECONSOLIDATION = savedFlag;
});

beforeEach(() => { queries.length = 0; reconsolidated.length = 0; });

const linkQuery = () => queries.find(q => /fragment_links/.test(q.sql));
const flush     = () => new Promise(resolve => setTimeout(resolve, 20));

describe("tool_feedback 재통합 링크 조회", () => {
  it("키 호출은 링크 양 끝 파편에 키 범위 조건을 건다", async () => {
    await tool_toolFeedback({ tool_name: "recall", relevant: true, fragment_ids: ["f1", "f2"], _keyId: KEY_A, _groupKeyIds: GROUP });
    await flush();
    const q = linkQuery();
    assert.match(q.sql, /JOIN [\w.]*fragments f ON f\.id = l\.from_id/);
    assert.match(q.sql, /JOIN [\w.]*fragments t ON t\.id = l\.to_id/);
    assert.match(q.sql, /f\.key_id IS NOT DISTINCT FROM \$\d/);
    assert.match(q.sql, /t\.key_id IS NOT DISTINCT FROM \$\d/);
    assert.deepEqual(q.params[0], ["f1", "f2"]);
    assert.ok(q.params.some(p => Array.isArray(p) && p.length === GROUP.length && p[0] === KEY_A));
    assert.equal(reconsolidated.length, 2);
    assert.equal(reconsolidated[0].opts.keyId, KEY_A);
  });

  it("마스터(keyId 없음)는 키 범위 조건 없이 조회한다", async () => {
    await tool_toolFeedback({ tool_name: "recall", relevant: false, fragment_ids: ["f1"] });
    await flush();
    const q = linkQuery();
    assert.doesNotMatch(q.sql, /key_id/);
    assert.equal(q.params.length, 1);
    assert.equal(reconsolidated[0].action, "decay");
  });
});
