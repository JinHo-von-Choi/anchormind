/**
 * LLM 호출 모듈의 외부 전송 문맥 시험(LLM, DB는 대역)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert                             from "node:assert/strict";

const llmCalls = [];
let   llmImpl  = async () => ({});
let   dbImpl   = async () => ({ rows: [] });

mock.module("../../lib/gemini.js", {
  namedExports: {
    geminiCLIJson       : async (prompt, options) => { llmCalls.push({ prompt, options }); return llmImpl(prompt, options); },
    isGeminiCLIAvailable: async () => true
  }
});
const realDb = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", {
  namedExports: {
    ...realDb,
    queryWithAgentVector: async (...args) => dbImpl(...args)
  }
});

const { MemoryEvaluator }       = await import("../../lib/memory/signals/MemoryEvaluator.js");
const { ContradictionDetector } = await import("../../lib/memory/link/ContradictionDetector.js");
const { generateQueries }       = await import("../../lib/memory/embedding/SyntheticQueryGenerator.js");
const { EgressSkippedError }    = await import("../../lib/llm/EgressPolicy.js");

describe("MemoryEvaluator 외부 전송 문맥", () => {
  beforeEach(() => { llmCalls.length = 0; });

  it("파편 행의 키와 workspace를 문맥으로 싣는다", async () => {
    dbImpl  = async (_agent, sql, params) => {
      assert.match(sql, /SELECT key_id, workspace FROM/);
      assert.deepEqual(params, ["f1"]);
      return { rows: [{ key_id: "k1", workspace: "team" }] };
    };
    llmImpl = async () => { throw new EgressSkippedError("evaluate", "local_only"); };
    await new MemoryEvaluator().evaluate({ fragmentId: "f1", agentId: "a", type: "fact", content: "c" });
    assert.equal(llmCalls.length, 1);
    assert.deepEqual(llmCalls[0].options.egress, { stage: "evaluate", keyId: "k1", workspace: "team" });
  });

  it("master 키 파편은 keyId null로 싣는다", async () => {
    dbImpl  = async () => ({ rows: [{ key_id: null, workspace: null }] });
    llmImpl = async () => { throw new EgressSkippedError("evaluate", "local_only"); };
    await new MemoryEvaluator().evaluate({ fragmentId: "f2", agentId: "a", type: "fact", content: "c" });
    assert.deepEqual(llmCalls[0].options.egress, { stage: "evaluate", keyId: null, workspace: null });
  });

  it("없어진 파편은 LLM을 부르지 않는다", async () => {
    dbImpl = async () => ({ rows: [] });
    await new MemoryEvaluator().evaluate({ fragmentId: "gone", agentId: "a", type: "fact", content: "c" });
    assert.equal(llmCalls.length, 0);
  });
});

describe("ContradictionDetector 외부 전송 문맥", () => {
  beforeEach(() => { llmCalls.length = 0; });

  it("대체 관계 판정은 쌍의 키와 두 workspace를 싣는다", async () => {
    dbImpl  = async () => ({ rows: [{
      id_a: "a", content_a: "x", created_a: "2026-01-01",
      id_b: "b", content_b: "y", created_b: "2026-01-02",
      key_id: "k9", workspace_a: "wa", workspace_b: "wb", similarity: 0.8
    }] });
    llmImpl = async () => ({ supersedes: false, reasoning: "r" });
    await new ContradictionDetector({ createLink: async () => {} }).detectSupersessions();
    assert.equal(llmCalls.length, 1);
    assert.deepEqual(llmCalls[0].options.egress, { stage: "contradiction", keyId: "k9", workspaces: ["wa", "wb"] });
  });

  it("정책으로 건너뛴 판정은 모순 아님으로 돌려준다", async () => {
    llmImpl = async () => { throw new EgressSkippedError("contradiction", "local_only"); };
    const verdict = await new ContradictionDetector({}).askGeminiContradiction("a", "b",
      { stage: "contradiction", keyId: "k1", workspaces: [] });
    assert.equal(verdict.contradicts, false);
    assert.deepEqual(llmCalls[0].options.egress, { stage: "contradiction", keyId: "k1", workspaces: [] });
  });
});

describe("SyntheticQueryGenerator 외부 전송 문맥", () => {
  it("호출자가 준 키와 workspace를 문맥으로 싣는다", async () => {
    const seen = [];
    await generateQueries("기억 본문 nginx 5432", {
      llm      : async (_p, options) => { seen.push(options); return { queries: [] }; },
      keyId    : "k3",
      workspace: "ops"
    });
    assert.deepEqual(seen[0].egress, { stage: "synthetic_query", keyId: "k3", workspace: "ops" });
  });
});
