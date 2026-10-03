/**
 * batch_remember async 경로의 관문 지표 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * async 모드는 선검증과 작업자 실행에서 같은 입력이 관문을 두 번 거친다. 통과와 경고는
 * 작업자 실행에서 한 번만, 선검증에서 거부된 항목은 선검증에서 한 번만 센다.
 */

import { describe, it, mock, after } from "node:test";
import assert                         from "node:assert/strict";

import { BatchRememberProcessor }      from "../../lib/memory/write/BatchRememberProcessor.js";
import { FragmentFactory }             from "../../lib/memory/write/FragmentFactory.js";
import { WriteGate }                   from "../../lib/memory/write/WriteGate.js";
import { writeGateTotal }              from "../../lib/memory/write/write-gate-metrics.js";
import { redisClient, disconnectRedis } from "../../lib/redis.js";

after(async () => { await disconnectRedis().catch(() => {}); });

/** entry, outcome별 현재 값 */
async function counts(entry) {
  const { values } = await writeGateTotal.get();
  const out = {};
  for (const v of values) if (v.labels.entry === entry) out[v.labels.outcome] = v.value;
  return out;
}

function delta(before, after) {
  const out = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[k] ?? 0) - (before[k] ?? 0);
    if (d !== 0) out[k] = d;
  }
  return out;
}

/** 다중 행 INSERT에 id를 돌려주는 일괄 저장 풀 */
function makePool() {
  return {
    connect: async () => ({
      query: async (sql, params) => {
        if (typeof sql !== "string" || !sql.includes("INSERT INTO")) return { rows: [] };
        const rows = [];
        for (let i = 0; i < params.length; i += 24) rows.push({ id: params[i] });
        return { rows };
      },
      release() {}
    })
  };
}

describe("batch_remember async 관문 지표", () => {
  it("선검증과 작업자 실행을 거쳐도 항목마다 한 번만 센다", async () => {
    const decisionRule = { check: (f) => (f.type === "decision" ? [{ rule: "decisionHasRationale", severity: "medium" }] : []) };
    const proc = new BatchRememberProcessor({
      store    : {},
      index    : { index: async () => {} },
      factory  : new FragmentFactory(),
      writeGate: () => new WriteGate({ policyRules: decisionRule, policyGatingEnabled: true })
    });
    proc.setPool(makePool());

    const origStatus = redisClient.status;
    const origLpush  = redisClient.lpush;
    const pushed     = [];
    redisClient.status = "ready";
    redisClient.lpush  = mock.fn(async (key, value) => { pushed.push(JSON.parse(value)); return pushed.length; });

    const before = await counts("batch_remember");
    try {
      const queued = await proc.process({
        async    : true,
        fragments: [
          { content: "Redis 포트는 6380으로 운영한다",       type: "fact",     topic: "ops" },
          { content: "Redis 캐시 레이어를 도입하기로 했다", type: "decision", topic: "ops" },
          { content: "짧음",                                type: "fact",     topic: "ops" }
        ]
      });
      assert.equal(queued.async, true);
      assert.equal(queued.accepted, 2);
      assert.deepEqual(delta(before, await counts("batch_remember")), {}, "선검증은 통과와 경고를 세지 않는다");
    } finally {
      redisClient.status = origStatus;
      redisClient.lpush  = origLpush;
    }

    /** 작업자는 큐 작업의 params로 같은 process()를 동기 경로로 부른다. */
    const job = pushed[0].params;
    await proc.process(job);
    assert.deepEqual(delta(before, await counts("batch_remember")), { pass: 1, warn: 1 });
  });

  it("선검증에서 hard gate로 거부된 항목은 선검증에서 한 번 센다", async () => {
    const proc = new BatchRememberProcessor({
      store    : {},
      index    : { index: async () => {} },
      factory  : new FragmentFactory(),
      writeGate: () => new WriteGate({
        policyRules        : { check: () => [{ rule: "decisionHasRationale", severity: "medium" }] },
        policyGatingEnabled: true,
        getHardGate        : async () => true
      })
    });
    proc.setPool({ connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) });

    const origStatus = redisClient.status;
    redisClient.status = "ready";
    const before = await counts("batch_remember");
    try {
      const queued = await proc.process({
        async    : true,
        _keyId   : "key-1",
        fragments: [{ content: "Redis 캐시 레이어를 도입하기로 했다", type: "decision", topic: "ops" }]
      });
      assert.equal(queued.accepted, 0);
    } finally {
      redisClient.status = origStatus;
    }
    assert.deepEqual(delta(before, await counts("batch_remember")), { reject: 1 });
  });
});
