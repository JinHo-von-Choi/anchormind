/**
 * contradiction_pending 힌트 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-07-14
 *
 * buildRecallHint 우선순위(no_results > contradiction_pending > stale_results)와
 * hasPendingContradictions의 EXISTS 조회·실패 강등을 검증한다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let queryCalls  = [];
let queryResult = { rows: [{ pending: false }] };
let poolBroken  = false;

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => poolBroken ? null : ({
      query(sql, params) {
        queryCalls.push({ sql, params });
        return Promise.resolve(queryResult);
      }
    }),
    getBatchPool        : () => null,
    shutdownPool        : async () => {},
    getPoolStats        : () => ({}),
    queryWithAgentVector: async () => ({ rows: [] }),
    withTransaction     : async (fn) => fn({ query: async () => ({ rows: [] }) })
  }
});

const { buildRecallHint, hasPendingContradictions } = await import("../../lib/tools/memory.js");

function frag(id, ageDays = 1) {
  return { id, age_days: ageDays };
}

beforeEach(() => {
  queryCalls  = [];
  queryResult = { rows: [{ pending: false }] };
  poolBroken  = false;
});

describe("buildRecallHint 우선순위", () => {
  it("빈 결과는 flag와 무관하게 no_results", () => {
    const hint = buildRecallHint([], {}, { contradictionPending: true });
    assert.equal(hint.signal, "no_results");
    assert.equal(hint.trigger, "recall");
    assert.match(hint.suggestion, /전역\(workspace 없음\).*workspace를 지정/);
  });

  it("빈 결과 + topic 후보는 no_results보다 topic_mismatch가 우선한다", () => {
    const hint = buildRecallHint(
      [],
      { topic: "anchormind-mcp" },
      { contradictionPending: true },
      [{ topic: "anchormind-mcp-v3", count: 12 }, { topic: "anchormind-recall", count: 4 }]
    );
    assert.equal(hint.signal, "topic_mismatch");
    assert.equal(hint.trigger, "recall");
    assert.match(hint.suggestion, /topic 'anchormind-mcp'/);
    assert.match(hint.suggestion, /anchormind-mcp-v3\(12건\), anchormind-recall\(4건\)/);
    assert.match(hint.suggestion, /topic=anchormind-mcp-v3으로 재검색/);
    assert.match(hint.suggestion, /전역\(workspace 없음\).*workspace를 지정/);
  });

  it("topic 후보가 비어 있으면 기존 no_results를 유지한다", () => {
    const hint = buildRecallHint([], { topic: "anchormind-mcp" }, {}, []);
    assert.equal(hint.signal, "no_results");
  });

  it("명시 workspace, key default, master 전체 조회의 빈 결과는 기존 저장 안내", () => {
    for (const args of [
      { workspace: "ws-a" },
      { _defaultWorkspace: "ws-default" },
      { allWorkspaces: true, _isMaster: true }
    ]) {
      const hint = buildRecallHint([], args);
      assert.equal(hint.signal, "no_results");
      assert.equal(hint.trigger, "remember");
    }
  });

  it("결과가 있으면 topic 후보가 있어도 topic_mismatch를 내지 않는다", () => {
    const hint = buildRecallHint(
      [frag("f1", 90)],
      { topic: "anchormind-mcp" },
      {},
      [{ topic: "anchormind-mcp-v3", count: 12 }]
    );
    assert.equal(hint.signal, "stale_results");
  });

  it("contradictionPending이 stale_results보다 우선한다", () => {
    const hint = buildRecallHint([frag("f1", 90)], {}, { contradictionPending: true });
    assert.equal(hint.signal, "contradiction_pending");
    assert.equal(hint.trigger, "amend");
  });

  it("flag 없으면 기존 stale_results 유지", () => {
    const hint = buildRecallHint([frag("f1", 90)], {});
    assert.equal(hint.signal, "stale_results");
  });

  it("flag 없고 신선한 소수 결과면 힌트 없음", () => {
    const hint = buildRecallHint([frag("f1", 1)], {});
    assert.equal(hint, null);
  });
});

describe("hasPendingContradictions", () => {
  it("빈 id 배열은 쿼리 없이 false", async () => {
    assert.equal(await hasPendingContradictions([]), false);
    assert.equal(queryCalls.length, 0);
  });

  it("contradicts EXISTS 쿼리를 id 배열 바인딩으로 실행한다", async () => {
    queryResult = { rows: [{ pending: true }] };
    const result = await hasPendingContradictions(["f1", "f2"]);
    assert.equal(result, true);
    assert.equal(queryCalls.length, 1);
    assert.match(queryCalls[0].sql, /relation_type = 'contradicts'/);
    assert.match(queryCalls[0].sql, /valid_to IS NULL/);
    assert.deepEqual(queryCalls[0].params, [["f1", "f2"], "default"]);
  });

  it("pool 부재 시 false로 강등 (힌트는 advisory)", async () => {
    poolBroken = true;
    assert.equal(await hasPendingContradictions(["f1"]), false);
  });
});
