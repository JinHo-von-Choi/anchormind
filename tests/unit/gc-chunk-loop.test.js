/**
 * GC 청크 반복의 순수 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 청크 반복이 시간 예산, 주기당 삭제 상한, 후보 소진, 청크 실패에서 멈추는지 가짜 시계와
 * 가짜 삭제 함수로 확인한다. DB는 쓰지 않는다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { runGcChunks } from "../../lib/memory/consolidate/gcChunks.js";

/** 호출마다 stepMs만큼 흐르는 시계 */
function steppingClock(stepMs) {
  let t = 0;
  return () => { const now = t; t += stepMs; return now; };
}

describe("runGcChunks", () => {
  it("시간 예산을 넘으면 상한에 닿기 전에 멈춘다", async () => {
    const sizes = [];
    const out   = await runGcChunks({
      cap: 10_000, chunk: 100, budgetMs: 350, now: steppingClock(100),
      deleteChunk: async (n) => { sizes.push(n); return n; }
    });
    assert.equal(out.stopped, "budget");
    assert.equal(out.deleted, sizes.length * 100);
    assert.ok(sizes.length >= 1 && sizes.length < 100, `청크 수 ${sizes.length}`);
  });

  it("시계가 멈춰 있어도 상한에서 멈춘다", async () => {
    const sizes = [];
    const out   = await runGcChunks({
      cap: 250, chunk: 100, budgetMs: 60_000, now: () => 0,
      deleteChunk: async (n) => { sizes.push(n); return n; }
    });
    assert.deepEqual(sizes, [100, 100, 50]);
    assert.equal(out.deleted, 250);
    assert.equal(out.stopped, "cap");
  });

  it("청크가 요청보다 적게 지우면 후보가 소진된 것으로 보고 멈춘다", async () => {
    const left = [100, 100, 37];
    const out  = await runGcChunks({
      cap: 4000, chunk: 100, budgetMs: 60_000, now: () => 0,
      deleteChunk: async () => left.shift() ?? 0
    });
    assert.equal(out.deleted, 237);
    assert.equal(out.stopped, "exhausted");
    assert.equal(left.length, 0);
  });

  it("후보가 처음부터 없으면 한 번만 시도한다", async () => {
    let calls = 0;
    const out = await runGcChunks({
      cap: 4000, chunk: 100, budgetMs: 60_000, now: () => 0,
      deleteChunk: async () => { calls += 1; return 0; }
    });
    assert.equal(calls, 1);
    assert.deepEqual({ deleted: out.deleted, stopped: out.stopped }, { deleted: 0, stopped: "exhausted" });
  });

  it("청크가 실패하면 그때까지 지운 수와 오류를 돌려주고 멈춘다", async () => {
    let calls = 0;
    const boom = new Error("lock timeout");
    const out  = await runGcChunks({
      cap: 4000, chunk: 100, budgetMs: 60_000, now: () => 0,
      deleteChunk: async (n) => { calls += 1; if (calls === 3) throw boom; return n; }
    });
    assert.equal(out.deleted, 200);
    assert.equal(out.stopped, "error");
    assert.equal(out.error, boom);
  });

  it("상한이 청크보다 작으면 상한 크기의 청크 하나를 지운다", async () => {
    const sizes = [];
    const out   = await runGcChunks({
      cap: 50, chunk: 100, budgetMs: 60_000, now: () => 0,
      deleteChunk: async (n) => { sizes.push(n); return n; }
    });
    assert.deepEqual(sizes, [50]);
    assert.equal(out.stopped, "cap");
  });
});
