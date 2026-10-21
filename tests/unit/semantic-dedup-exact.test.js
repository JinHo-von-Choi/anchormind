/**
 * semantic_dedup 묶음 단위 정확 계산 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 *
 * DB 질의 함수만 대체하고 실제 SemanticDedup 흐름(묶음 적재 → 정확 top-3 → 게이트 → 병합)을 거친다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert                              from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

/** topic → [{ workspace, key_id, rows: [{id, content, created_at, is_anchor, embedding}] }] */
let data       = {};
let merges     = [];
let failMerge  = new Set();
let groupLoads = [];

function vec(...xs) {
  return `[${xs.join(",")}]`;
}

const db = {
  queryWithAgentVector: async (_agent, sql, params) => {
    if (/GROUP BY topic/.test(sql)) {
      return { rows: Object.keys(data).map(topic => ({ topic, cnt: data[topic].reduce((n, g) => n + g.rows.length, 0) })) };
    }
    if (/GROUP BY workspace, key_id/.test(sql)) {
      return { rows: (data[params[0]] ?? []).map(g => ({ workspace: g.workspace, key_id: g.key_id })) };
    }
    if (/embedding::text AS embedding/.test(sql)) {
      groupLoads.push(params[0]);
      const g = (data[params[0]] ?? []).find(x => x.workspace === params[1] && x.key_id === (params[2] ?? null));
      return { rows: (g?.rows ?? []).map(r => ({ ...r })) };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  },
  getPrimaryPool : () => ({}),
  withTransaction: async (_pool, fn) => {
    let pair = null;
    const client = {
      query: async (sql, params) => {
        if (/FOR NO KEY UPDATE/.test(sql)) {
          pair = params[0];
          if (failMerge.has(pair.join("|"))) throw new Error("statement timeout");
          return { rowCount: 2, rows: pair.map(id => ({ id, access_count: 1 })) };
        }
        if (/RETURNING id, keywords/.test(sql)) return { rows: [{ id: params[0], keywords: [], topic: "t", type: "fact", key_id: null }] };
        return { rows: [], rowCount: 0 };
      }
    };
    const result = await fn(client);
    if (result) merges.push({ keepId: pair[0], oldId: pair[1] });
    return result;
  }
};

mock.module("../../lib/tools/db.js", { exports: db });
mock.module("../../lib/memory/FragmentIndex.js", { exports: { deindexRows: async () => {}, getFragmentIndex: () => ({}) } });

const { runSemanticDedup, compareRecency } = await import("../../lib/memory/consolidate/SemanticDedup.js");
const { topNeighbors, toUnitVector }       = await import("../../lib/memory/consolidate/exactNeighbors.js");

const noYield = { yieldEvery: async () => {} };

function row(id, createdAt, embedding, { content = "같은 본문", isAnchor = false } = {}) {
  return { id, content, created_at: new Date(createdAt).toISOString(), is_anchor: isAnchor, embedding };
}

beforeEach(() => {
  data = {}; merges = []; failMerge = new Set(); groupLoads = [];
});

describe("exactNeighbors", () => {
  it("toUnitVector는 텍스트 벡터를 단위 길이로 바꾸고 0 벡터와 잘못된 값은 null이다", () => {
    const v = toUnitVector("[3,4]");
    assert.ok(Math.abs(v[0] - 0.6) < 1e-6 && Math.abs(v[1] - 0.8) < 1e-6);
    assert.equal(toUnitVector("[0,0]"), null);
    assert.equal(toUnitVector("not a vector"), null);
  });

  it("행마다 무차별 계산과 같은 top-k를 낸다", async () => {
    const raw = Array.from({ length: 40 }, (_, i) => [Math.sin(i), Math.cos(i * 1.7), Math.sin(i * 0.3 + 1)]);
    const vectors = raw.map(v => toUnitVector(v));
    const got = await topNeighbors(vectors, 3, noYield);
    for (let i = 0; i < vectors.length; i++) {
      const brute = vectors
        .map((v, j) => ({ index: j, cosine: j === i ? -Infinity : v.reduce((s, x, d) => s + x * vectors[i][d], 0) }))
        .filter(x => x.index !== i)
        .sort((a, b) => b.cosine - a.cosine || a.index - b.index)
        .slice(0, 3)
        .map(x => x.index);
      assert.deepEqual(got[i].map(x => x.index), brute, `row ${i}`);
    }
  });

  it("동률은 인덱스가 작은 이웃이 앞선다", async () => {
    const vectors = [toUnitVector([1, 0]), toUnitVector([1, 0]), toUnitVector([1, 0]), toUnitVector([1, 0])];
    const got = await topNeighbors(vectors, 2, noYield);
    assert.deepEqual(got[3].map(x => x.index), [0, 1]);
    assert.deepEqual(got[0].map(x => x.index), [1, 2]);
  });

  it("행마다 한 번 양보한다", async () => {
    let yields = 0;
    await topNeighbors([toUnitVector([1, 0]), toUnitVector([0, 1]), toUnitVector([1, 1])], 1, { yieldEvery: async () => { yields++; } });
    assert.equal(yields, 3);
  });
});

describe("compareRecency", () => {
  it("created_at이 늦은 쪽, 같으면 id가 큰 쪽이 앞선다", () => {
    assert.ok(compareRecency({ createdAt: 2, id: "a" }, { createdAt: 1, id: "z" }) > 0);
    assert.ok(compareRecency({ createdAt: 1, id: "b" }, { createdAt: 1, id: "a" }) > 0);
    assert.equal(compareRecency({ createdAt: 1, id: "a" }, { createdAt: 1, id: "a" }), 0);
  });
});

describe("runSemanticDedup", () => {
  it("같은 묶음의 0.92 이상 쌍을 병합하고 최신 파편을 남긴다", async () => {
    data.t = [{ workspace: "w", key_id: null, rows: [
      row("old", "2026-01-01", vec(1, 0, 0)),
      row("new", "2026-02-01", vec(1, 0.01, 0)),
      row("far", "2026-03-01", vec(0, 1, 0))
    ] }];
    const merged = await runSemanticDedup();
    assert.equal(merged, 1);
    assert.deepEqual(merges, [{ keepId: "new", oldId: "old" }]);
  });

  it("같은 시각이면 id가 큰 쪽이 남는다", async () => {
    data.t = [{ workspace: null, key_id: null, rows: [
      row("b", "2026-01-01", vec(1, 0)),
      row("a", "2026-01-01", vec(1, 0.001))
    ] }];
    await runSemanticDedup();
    assert.deepEqual(merges, [{ keepId: "b", oldId: "a" }]);
  });

  it("다른 workspace·key 묶음끼리는 비교하지 않는다", async () => {
    data.t = [
      { workspace: "w1", key_id: null, rows: [row("x", "2026-01-01", vec(1, 0)), row("far1", "2026-01-02", vec(0, 1))] },
      { workspace: "w2", key_id: null, rows: [row("y", "2026-01-03", vec(1, 0)), row("far2", "2026-01-04", vec(0, 1))] }
    ];
    assert.equal(await runSemanticDedup(), 0);
    assert.deepEqual(merges, []);
  });

  it("앵커 파편은 병합하지 않는다", async () => {
    data.t = [{ workspace: null, key_id: null, rows: [
      row("anchor", "2026-01-01", vec(1, 0), { isAnchor: true }),
      row("new", "2026-02-01", vec(1, 0))
    ] }];
    assert.equal(await runSemanticDedup(), 0);
  });

  it("게이트가 막은 쌍은 병합하지 않는다", async () => {
    data.t = [{ workspace: null, key_id: null, rows: [
      row("old", "2026-01-01", vec(1, 0), { content: "포트 15000 서버 배포 2026-01-01" }),
      row("new", "2026-02-01", vec(1, 0), { content: "서버 배포 완료" })
    ] }];
    assert.equal(await runSemanticDedup(), 0);
    assert.deepEqual(merges, []);
  });

  it("병합이 롤백되면 다음 후보로 넘어간다", async () => {
    data.t = [{ workspace: null, key_id: null, rows: [
      row("a", "2026-01-01", vec(1, 0, 0)),
      row("b", "2026-01-02", vec(1, 0.001, 0)),
      row("c", "2026-01-03", vec(1, 0.002, 0))
    ] }];
    failMerge.add("c|b");
    await runSemanticDedup();
    assert.deepEqual(merges[0], { keepId: "c", oldId: "a" });
  });

  it("시간 예산을 넘기면 남은 topic은 읽지 않는다", async () => {
    data.t1 = [{ workspace: null, key_id: null, rows: [row("a", "2026-01-01", vec(1, 0)), row("b", "2026-01-02", vec(0, 1))] }];
    data.t2 = [{ workspace: null, key_id: null, rows: [row("c", "2026-01-01", vec(1, 0)), row("d", "2026-01-02", vec(1, 0))] }];
    let t = 0;
    await runSemanticDedup({ now: () => { const v = t; t += 15 * 60 * 1000; return v; } });
    assert.deepEqual(groupLoads, ["t1"]);
  });
});
