import { after, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";
import { computeContentHash } from "../../lib/tools/embedding.js";

const calls = [];
let rows = [];
mock.module("../../lib/tools/db.js", {
  namedExports: {
    queryWithAgentVector: mock.fn(async (agentId, sql, params) => {
      calls.push({ agentId, sql, params });
      return { rows };
    })
  }
});

const { RecallBenchmark } = await import("../../lib/memory/signals/RecallBenchmark.js");

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

describe("benchmark --no-seed 기존 스코프 매핑", () => {
  const goldset = [
    { id: "g1", store: "첫 번째 기준 기억" },
    { id: "g2", store: "두 번째 기준 기억" }
  ];

  it("동일 agent/workspace/key의 현재 content hash를 정확히 대응한다", async () => {
    rows = goldset.map((entry, index) => ({ id: `f${index + 1}`, content_hash: computeContentHash(entry.store) }));
    calls.length = 0;
    const benchmark = new RecallBenchmark({}, { agentId: "bench-agent", workspace: "bench-space", keyId: "bench-key" });
    const mapped = await benchmark.resolveExisting(goldset);
    assert.deepEqual([...mapped], [["g1", "f1"], ["g2", "f2"]]);
    assert.equal(calls[0].agentId, "bench-agent");
    assert.match(calls[0].sql, /agent_id = \$2/);
    assert.match(calls[0].sql, /workspace IS NOT DISTINCT FROM \$3/);
    assert.match(calls[0].sql, /key_id IS NOT DISTINCT FROM \$4/);
    assert.deepEqual(calls[0].params.slice(1), ["bench-agent", "bench-space", "bench-key"]);
  });

  it("하나라도 누락되거나 중복이면 평가 전에 실패한다", async () => {
    rows = [{ id: "f1", content_hash: computeContentHash(goldset[0].store) }];
    await assert.rejects(
      () => new RecallBenchmark({}, { keyId: null }).resolveExisting(goldset),
      /g2\(누락\)/
    );
    rows = [
      { id: "f1", content_hash: computeContentHash(goldset[0].store) },
      { id: "f1-copy", content_hash: computeContentHash(goldset[0].store) },
      { id: "f2", content_hash: computeContentHash(goldset[1].store) }
    ];
    await assert.rejects(
      () => new RecallBenchmark({}, { keyId: null }).resolveExisting(goldset),
      /g1\(중복 2건\)/
    );
  });
});
