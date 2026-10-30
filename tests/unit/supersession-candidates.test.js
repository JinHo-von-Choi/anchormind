/**
 * 대체 관계 후보 탐지 시험(LLM, DB는 대역)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 *
 * 워터마크 이후 새 파편마다 이웃을 조회해 유사도 구간 안의 쌍만 모으고, 유사도가 높은 쌍부터
 * 판정 상한만큼 LLM에 묻는지, 워터마크가 처리한 파편까지만 전진하는지 본다.
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert                             from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const judged     = [];
let   newFrags   = [];
let   neighbors  = {};
let   failOn     = null;
let   sinceParams = [];

mock.module("../../lib/gemini.js", {
  namedExports: {
    geminiCLIJson       : async (prompt) => { judged.push(prompt); return { supersedes: false, reasoning: "r" }; },
    isGeminiCLIAvailable: async () => true
  }
});
const realDb = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", {
  namedExports: {
    ...realDb,
    queryWithAgentVector: async (_agent, sql, params) => {
      if (/watermark_at/.test(sql)) {
        sinceParams.push(params.slice(0, -1));
        return { rows: newFrags };
      }
      /** 이웃은 묶음마다 한 질의로 묻는다. params[0]이 묶음의 파편 id 목록이다. */
      if (params[0].includes(failOn)) throw new Error("statement timeout");
      return { rows: params[0].flatMap(id => (neighbors[id] ?? []).map(n => ({ src_id: id, ...n }))) };
    }
  }
});

const { ContradictionDetector, SUPERSESSION_JUDGE_LIMIT } = await import("../../lib/memory/link/ContradictionDetector.js");

function frag(id, at) {
  return { id, content: `c-${id}`, topic: "t", type: "fact", key_id: null, workspace: null, embedding: "[1]",
           stated_at: at, created_at: new Date(at), watermark_at: `${at}.000000Z` };
}

function near(id, similarity) {
  return { id, content: `c-${id}`, stated_at: "2026-01-01T00:00:00", workspace: null, similarity: String(similarity) };
}

beforeEach(() => {
  judged.length = 0; newFrags = []; neighbors = {}; failOn = null; sinceParams = [];
});

describe("detectSupersessions", () => {
  it("유사도 0.7~0.85 구간의 이웃만 후보로 판정한다", async () => {
    newFrags  = [frag("n1", "2026-03-01T00:00:00")];
    neighbors = { n1: [near("dup", 0.95), near("mid", 0.8), near("far", 0.5)] };
    await new ContradictionDetector({ createLink: async () => {} }).detectSupersessions();
    assert.equal(judged.length, 1);
    assert.match(judged[0], /c-mid/);
  });

  it("같은 쌍은 한 번만 판정하고 판정 쌍 수는 상한을 넘지 않는다", async () => {
    newFrags  = Array.from({ length: 15 }, (_, i) => frag(`n${String(i).padStart(2, "0")}`, `2026-03-02T00:00:${String(i).padStart(2, "0")}`));
    for (const f of newFrags) neighbors[f.id] = [near(`old-${f.id}`, 0.71 + Number(f.id.slice(1)) / 100)];
    neighbors.n00.push(near("n01", 0.84));
    neighbors.n01.push(near("n00", 0.84));
    await new ContradictionDetector({ createLink: async () => {} }).detectSupersessions();
    assert.equal(judged.length, SUPERSESSION_JUDGE_LIMIT);
    const pairN00N01 = judged.filter(p => /c-n00/.test(p) && /c-n01/.test(p));
    assert.equal(pairN00N01.length, 1);
  });

  it("이웃 조회가 실패한 묶음부터 다음 주기에 다시 본다", async () => {
    newFrags = [frag("m1", "2026-03-03T00:00:00"), frag("m2", "2026-03-03T00:00:01"), frag("m3", "2026-03-03T00:00:02")];
    failOn   = "m2";
    const d  = new ContradictionDetector({ createLink: async () => {} });
    await d.detectSupersessions();
    newFrags = [];
    await d.detectSupersessions();
    /** 세 파편이 한 묶음이라 묶음 전체를 다시 본다. 워터마크가 전진하지 않는다. */
    assert.deepEqual(sinceParams[1], sinceParams[0]);
  });
});
