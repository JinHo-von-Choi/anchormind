/**
 * TopicResolver 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-08-06
 *
 * topic 오기로 recall이 0건이 됐을 때의 근접 topic 제안 계약을 검증한다.
 * 형태소 벡터는 mock으로 주입하여 코사인 유사도를 결정론적으로 통제한다.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/** topic → 형태소 평균 벡터. 미등록 topic은 null(벡터 확보 실패)로 취급한다. */
let vectorTable = {};

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool      : () => null,
    getBatchPool        : () => null,
    shutdownPool        : async () => {},
    getPoolStats        : () => ({}),
    queryWithAgentVector: async () => ({ rows: [] }),
    withTransaction     : async (fn) => fn({ query: async () => ({ rows: [] }) })
  }
});

mock.module("../../lib/memory/embedding/MorphemeIndex.js", {
  namedExports: {
    MorphemeIndex: class {
      async textToMorphemeVector(text) {
        return vectorTable[text] ?? null;
      }
    }
  }
});

const { suggestTopics } = await import("../../lib/memory/read/TopicResolver.js");

/**
 * 집계 결과를 고정 반환하는 pool 스텁.
 *
 * @param {Array|Error} rowsOrError
 * @returns {{ pool: Object, calls: Array }}
 */
function stubPool(rowsOrError) {
  const calls = [];
  const pool  = {
    query(sql, params) {
      calls.push({ sql, params });
      if (rowsOrError instanceof Error) return Promise.reject(rowsOrError);
      return Promise.resolve({ rows: rowsOrError });
    }
  };
  return { pool, calls };
}

beforeEach(() => {
  vectorTable = {
    "anchormind-mcp"    : [1, 0],
    "anchormind-mcp-v3" : [1, 0],
    "anchormind-recall" : [0.8, 0.6],
    "grafana-alert"     : [0, 1]
  };
});

describe("suggestTopics", () => {

  it("유사도 0.5 미만 후보를 제외하고 유사도 내림차순으로 반환한다", async () => {
    const { pool } = stubPool([
      { topic: "grafana-alert",     count: 50 },
      { topic: "anchormind-recall", count: 12 },
      { topic: "anchormind-mcp-v3", count: 3 }
    ]);

    const result = await suggestTopics({ pool }, { keyId: null }, "anchormind-mcp");

    assert.deepEqual(result.map(r => r.topic), ["anchormind-mcp-v3", "anchormind-recall"]);
    assert.equal(result[0].count, 3);
    assert.ok(result[0].similarity > result[1].similarity);
  });

  it("limit 개수까지만 반환한다", async () => {
    vectorTable["anchormind-etc"] = [0.9, 0.4];
    const { pool } = stubPool([
      { topic: "anchormind-mcp-v3", count: 9 },
      { topic: "anchormind-recall", count: 8 },
      { topic: "anchormind-etc",    count: 7 }
    ]);

    const result = await suggestTopics({ pool }, {}, "anchormind-mcp", { limit: 2 });

    assert.equal(result.length, 2);
  });

  it("집계 쿼리에서 입력 topic 자신을 제외한다", async () => {
    const { pool, calls } = stubPool([{ topic: "anchormind-mcp-v3", count: 4 }]);

    await suggestTopics({ pool }, {}, "  anchormind-mcp  ");

    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /topic <> \$1/);
    assert.match(calls[0].sql, /valid_to IS NULL/);
    assert.match(calls[0].sql, /GROUP BY topic/);
    assert.equal(calls[0].params[0], "anchormind-mcp");
  });

  it("키 스코프 절을 집계 쿼리에 적용한다", async () => {
    const { pool, calls } = stubPool([{ topic: "anchormind-mcp-v3", count: 4 }]);

    await suggestTopics(
      { pool },
      { keyId: "key-1", groupKeyIds: ["key-1", "key-2"] },
      "anchormind-mcp"
    );

    assert.match(calls[0].sql, /key_id IS NOT DISTINCT FROM \$2/);
    assert.match(calls[0].sql, /key_id = ANY\(\$3::text\[\]\)/);
    assert.deepEqual(calls[0].params, ["anchormind-mcp", "key-1", ["key-1", "key-2"]]);
  });

  it("입력 topic의 형태소 벡터를 얻지 못하면 어휘 폴백으로 후보를 고른다", async () => {
    vectorTable = {};
    const { pool } = stubPool([
      { topic: "anchormind-mcp-v3", count: 9 },
      { topic: "grafana-alert",     count: 40 },
      { topic: "mcp-server",        count: 5 }
    ]);

    const result = await suggestTopics({ pool }, {}, "anchormind-mcp");

    assert.deepEqual(result.map(r => r.topic), ["anchormind-mcp-v3", "mcp-server"]);
    assert.equal(result[0].similarity, null);
  });

  it("후보 topic의 벡터가 없으면 어휘 겹침으로 구제해 코사인 후보 뒤에 잇는다", async () => {
    delete vectorTable["anchormind-recall"];
    const { pool } = stubPool([
      { topic: "anchormind-recall", count: 30 },
      { topic: "anchormind-mcp-v3", count: 2 }
    ]);

    const result = await suggestTopics({ pool }, {}, "anchormind-mcp");

    assert.deepEqual(result.map(r => r.topic), ["anchormind-mcp-v3", "anchormind-recall"]);
    assert.equal(result[1].similarity, null);
  });

  it("코사인 임계 미달이라도 어휘 토큰이 겹치면 구제한다", async () => {
    vectorTable["wiki-loremaster"] = [1, 0];
    vectorTable["hermes-wiki"]     = [0.4, 0.92];
    const { pool } = stubPool([
      { topic: "hermes-wiki",   count: 120 },
      { topic: "grafana-alert", count: 40 }
    ]);

    const result = await suggestTopics({ pool }, {}, "wiki-loremaster");

    assert.deepEqual(result.map(r => r.topic), ["hermes-wiki"]);
    assert.equal(result[0].similarity, null);
  });

  it("어휘 구제 후보는 겹침 비율 우선, 동률이면 파편 수 순으로 정렬한다", async () => {
    vectorTable = {};
    const { pool } = stubPool([
      { topic: "bench-lme-memento-e47b", count: 941 },
      { topic: "memento-mcp",            count: 240 },
      { topic: "grafana-alert",          count: 40 }
    ]);

    const result = await suggestTopics({ pool }, {}, "memento-mpc");

    assert.deepEqual(result.map(r => r.topic), ["memento-mcp", "bench-lme-memento-e47b"]);
  });

  it("집계 쿼리 예외는 삼키고 빈 배열을 반환한다", async () => {
    const { pool } = stubPool(new Error("relation does not exist"));

    assert.deepEqual(await suggestTopics({ pool }, {}, "anchormind-mcp"), []);
  });

  it("pool을 확보하지 못하면 빈 배열을 반환한다", async () => {
    assert.deepEqual(await suggestTopics({}, {}, "anchormind-mcp"), []);
  });

  it("빈 topic 입력은 쿼리 없이 빈 배열을 반환한다", async () => {
    const { pool, calls } = stubPool([{ topic: "anchormind-mcp-v3", count: 4 }]);

    assert.deepEqual(await suggestTopics({ pool }, {}, "   "), []);
    assert.deepEqual(await suggestTopics({ pool }, {}, undefined), []);
    assert.equal(calls.length, 0);
  });

  it("집계 결과가 없으면 빈 배열을 반환한다", async () => {
    const { pool } = stubPool([]);

    assert.deepEqual(await suggestTopics({ pool }, {}, "anchormind-mcp"), []);
  });

});
