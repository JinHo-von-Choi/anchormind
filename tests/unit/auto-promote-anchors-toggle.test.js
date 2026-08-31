import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { MEMORY_CONFIG } from "../../config/memory.js";
import { MemoryConsolidator } from "../../lib/memory/consolidate/MemoryConsolidator.js";
import { anchorAutoPromotionEnabled } from "../../lib/metrics.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadToggle(envValue) {
  const env = { ...process.env, MEMENTO_METRICS_DEFAULT: "off" };
  delete env.MEMENTO_AUTO_PROMOTE_ANCHORS;
  if (envValue !== undefined) env.MEMENTO_AUTO_PROMOTE_ANCHORS = envValue;
  return execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import { MEMORY_CONFIG } from "${path.join(ROOT, "config", "memory.js")}";` +
      "console.log(MEMORY_CONFIG.consolidate.autoPromoteAnchors);"
  ], { env, encoding: "utf8" }).trim();
}

describe("MEMENTO_AUTO_PROMOTE_ANCHORS 설정", () => {
  it("미지정/true는 기존 활성 동작을 유지한다", () => {
    assert.equal(loadToggle(undefined), "true");
    assert.equal(loadToggle("true"), "true");
  });

  it("false는 자동 승격을 비활성화한다", () => {
    assert.equal(loadToggle("false"), "false");
  });

  it("잘못된 boolean은 조용히 반대값으로 처리하지 않는다", () => {
    assert.throws(() => loadToggle(""), /MEMENTO_AUTO_PROMOTE_ANCHORS must be.*true.*false/s);
    assert.throws(() => loadToggle("yes"), /MEMENTO_AUTO_PROMOTE_ANCHORS must be.*true.*false/s);
  });
});

describe("promote_anchors stage opt-out", () => {
  async function withToggle(value, fn) {
    const original = MEMORY_CONFIG.consolidate.autoPromoteAnchors;
    MEMORY_CONFIG.consolidate.autoPromoteAnchors = value;
    try { return await fn(); }
    finally { MEMORY_CONFIG.consolidate.autoPromoteAnchors = original; }
  }

  it("false이면 UPDATE 구현을 호출하지 않고 disabled_by_config로 건너뛴다", async () => {
    await withToggle(false, async () => {
      const consolidator = new MemoryConsolidator();
      consolidator._promoteAnchors = mock.fn(async () => 7);
      consolidator._updateUtilityScores = mock.fn(async () => 3);
      const results = { anchorsPromoted: 99, utilityUpdated: 0 };
      const defs = consolidator._enrichmentStages({}, results)
        .filter(stage => ["utility_score_update", "promote_anchors"].includes(stage.name));

      const stages = await consolidator._executeStages(defs, results, () => {});

      assert.equal(consolidator._promoteAnchors.mock.callCount(), 0);
      assert.equal(consolidator._updateUtilityScores.mock.callCount(), 1);
      assert.equal(results.utilityUpdated, 3);
      assert.equal(results.anchorsPromoted, 0);
      assert.deepEqual(stages[1], {
        name: "promote_anchors",
        durationMs: stages[1].durationMs,
        affected: 0,
        status: "skipped",
        reason: "disabled_by_config"
      });
      const metric = await anchorAutoPromotionEnabled.get();
      assert.equal(metric.values[0].value, 0);
    });
  });

  it("true이면 기존 승격 구현과 rowCount 반영을 유지한다", async () => {
    await withToggle(true, async () => {
      const consolidator = new MemoryConsolidator();
      consolidator._promoteAnchors = mock.fn(async () => 7);
      const results = { anchorsPromoted: 0 };
      const def = consolidator._enrichmentStages({}, results)
        .find(stage => stage.name === "promote_anchors");

      const stages = await consolidator._executeStages([def], results, () => {});

      assert.equal(consolidator._promoteAnchors.mock.callCount(), 1);
      assert.equal(results.anchorsPromoted, 7);
      assert.equal(stages[0].status, "ok");
      assert.equal(stages[0].affected, 7);
      const metric = await anchorAutoPromotionEnabled.get();
      assert.equal(metric.values[0].value, 1);
    });
  });
});
