/**
 * 행동 기반 평가 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-11-10
 *
 * 골드셋 검사, 1순위 판정, 집계, 실행 흐름(방식별 적재, recall 인자, 회수)을 가짜 manager로 확인한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ActionBenchmark, validateActionGoldset, judgeTop, summarizeArm } from "../../lib/memory/signals/ActionBenchmark.js";
import { parseJsonl } from "../../lib/memory/signals/RecallEvalSet.js";

const entry = { id: "e1", arg: "deploy.host", query: "배포 호스트", template: "배포 호스트는 {v}다", updates: ["web-alpha", "web-bravo"] };

describe("행동 기반 평가", () => {
  it("저장소의 골드셋은 검사를 통과한다", () => {
    const goldset = parseJsonl(readFileSync("tests/fixtures/action-goldset.jsonl", "utf8"), "action");
    assert.deepEqual(validateActionGoldset(goldset), []);
    assert.ok(goldset.length >= 10);
  });

  it("한 값이 다른 값의 일부인 항목은 판정이 모호해 거부한다", () => {
    assert.match(validateActionGoldset([{ ...entry, updates: ["web-1", "web-10"] }])[0], /모호/);
  });

  it("1순위에 최신 값이 있으면 correct, 이전 값만 있으면 stale, 둘 다 없으면 miss다", () => {
    assert.equal(judgeTop("배포 호스트는 web-bravo다", entry.updates), "correct");
    assert.equal(judgeTop("배포 호스트는 web-alpha다", entry.updates), "stale");
    assert.equal(judgeTop("다른 내용", entry.updates), "miss");
    assert.equal(judgeTop(null, entry.updates), "miss");
  });

  it("집계는 정답률, 이전 값 비율, 평균 토큰과 지연 분위를 낸다", () => {
    const m = summarizeArm([
      { verdict: "correct", tokens: 10, count: 1, latencyMs: 5 },
      { verdict: "stale", tokens: 30, count: 2, latencyMs: 15 }
    ]);
    assert.equal(m.accuracy, 0.5);
    assert.equal(m.staleRate, 0.5);
    assert.equal(m.tokensMean, 20);
    assert.equal(m.latencyP95Ms, 15);
  });

  it("slot 방식은 slot으로 저장하고 찾으며, plain 방식은 text로 찾는다", async () => {
    const remembered = [];
    const recalled   = [];
    const manager = {
      remember     : async (p) => { remembered.push(p); return { id: `f${remembered.length}` }; },
      recall       : async (p) => { recalled.push(p); return { fragments: [{ content: remembered[remembered.length - 1].content }], totalTokens: 12 }; },
      deleteByAgent: async () => 0
    };
    const bench = new ActionBenchmark(manager);
    bench.harness.ensureHarnessKey = async () => {};
    bench.harness.settle = async () => ({});
    const report = await bench.run([entry]);
    assert.equal(report.arms.slot.correct, 1);
    assert.equal(report.arms.plain.correct, 1);
    assert.deepEqual(remembered.filter(p => p.slot === "deploy.host").length, 2);
    assert.equal(recalled[0].slot, "deploy.host");
    assert.equal(recalled[1].text, "배포 호스트");
    assert.ok(remembered.every(p => p._keyId === "action-benchmark-key" && p.workspace === "__action_benchmark__"));
  });
});
