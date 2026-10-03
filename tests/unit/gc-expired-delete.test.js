/**
 * FragmentGC.deleteExpired 청크 반복 시험(대역 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 주기당 삭제 상한까지 청크 단위로 지우는지, 스위치가 off이면 한 번에 50건을 지우는지, 청크 실패를 어떻게
 * 다루는지, 남은 후보 수를 게이지에 기록하는지 대역 DB로 확인한다. 실제 SQL의 동작은
 * tests/db-concurrency/gc-throughput.test.js가 일회용 DB에서 확인한다.
 */

import { describe, it, mock, beforeEach, afterEach, after } from "node:test";
import assert                                               from "node:assert/strict";

const calls  = [];
const script = { backlog: 0, failOn: null, indexed: [] };

const realDb = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", {
  namedExports: {
    ...realDb,
    queryWithAgentVector: async (_agent, sql, params, opts) => {
      if (opts?.lock?.operation === "gc_delete") {
        const limit = opts.lock.params.at(-1);
        calls.push({ limit, lockTimeoutMs: opts.lock.lockTimeoutMs, params: opts.lock.params });
        if (script.failOn === calls.length) throw new Error("lock timeout");
        return { rows: Array.from({ length: limit }, (_, i) => ({ id: `r${calls.length}-${i}` })), rowCount: limit };
      }
      if (/AS n\s+FROM \(SELECT 1 FROM/.test(sql)) return { rows: [{ n: script.backlog }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
  }
});

const realIndex = await import("../../lib/memory/FragmentIndex.js");
mock.module("../../lib/memory/FragmentIndex.js", {
  namedExports: { ...realIndex, deindexRows: async (rows) => { script.indexed.push(rows.length); } }
});

const { FragmentGC, gcLimits }  = await import("../../lib/memory/consolidate/FragmentGC.js");
const { gcBacklog }             = await import("../../lib/memory/consolidate/gc-metrics.js");
const { teardownTestResources } = await import("../_lifecycle.js");

const KEYS = ["MEMENTO_GC_THROUGHPUT", "MEMENTO_GC_MAX_DELETE_PER_CYCLE", "MEMENTO_GC_TIME_BUDGET_MS"];
const saved = {};

after(async () => { await teardownTestResources(); });

beforeEach(() => {
  calls.length = 0;
  script.backlog = 0; script.failOn = null; script.indexed.length = 0;
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});

afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe("만료 삭제 청크 반복", () => {
  it("주기당 삭제 상한까지 100건 청크로 지우고 청크마다 잠금 대기 상한을 건다", async () => {
    process.env.MEMENTO_GC_MAX_DELETE_PER_CYCLE = "250";
    const deleted = await new FragmentGC().deleteExpired();
    assert.equal(deleted, 250);
    assert.deepEqual(calls.map(c => c.limit), [100, 100, 50]);
    assert.ok(calls.every(c => c.lockTimeoutMs > 0));
    assert.deepEqual(script.indexed, [100, 100, 50]);
  });

  it("후보가 소진되면 상한 전에 멈춘다", async () => {
    process.env.MEMENTO_GC_MAX_DELETE_PER_CYCLE = "1000";
    const gc   = new FragmentGC();
    const orig = gc._deleteExpiredChunk.bind(gc);
    let   left = 130;
    gc._deleteExpiredChunk = async (params, limit, timeout) => {
      const take = Math.min(limit, left);
      left -= take;
      await orig(params, take, timeout);
      return take;
    };
    assert.equal(await gc.deleteExpired(), 130);
    assert.deepEqual(calls.map(c => c.limit), [100, 30]);
  });

  it("기본 한도는 4000건과 60초다", () => {
    const limits = gcLimits();
    assert.equal(limits.cap, 4000);
    assert.equal(limits.chunk, 100);
    assert.equal(limits.budgetMs, 60000);
  });

  it("MEMENTO_GC_THROUGHPUT=off이면 50건을 한 문장으로 지우고 잠금 대기 상한을 더하지 않는다", async () => {
    process.env.MEMENTO_GC_THROUGHPUT = "off";
    const deleted = await new FragmentGC().deleteExpired();
    assert.equal(deleted, 50);
    assert.deepEqual(calls.map(c => c.limit), [50]);
    assert.equal(calls[0].lockTimeoutMs, undefined);
  });

  it("중간 청크가 실패하면 그때까지 지운 수를 돌려주고 멈춘다", async () => {
    process.env.MEMENTO_GC_MAX_DELETE_PER_CYCLE = "1000";
    script.failOn = 3;
    assert.equal(await new FragmentGC().deleteExpired(), 200);
    assert.equal(calls.length, 3);
  });

  it("첫 청크가 실패하면 오류를 그대로 던진다", async () => {
    script.failOn = 1;
    await assert.rejects(() => new FragmentGC().deleteExpired(), /lock timeout/);
  });

  it("남은 후보 수를 memento_gc_backlog에 기록한다", async () => {
    process.env.MEMENTO_GC_MAX_DELETE_PER_CYCLE = "100";
    script.backlog = 321;
    await new FragmentGC().deleteExpired();
    const metric = await gcBacklog.get();
    assert.equal(metric.values[0].value, 321);
    assert.equal(metric.name, "memento_gc_backlog");
  });
});
