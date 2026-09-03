import { after, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { MEMORY_CONFIG } from "../../config/memory.js";
import { validateMemoryConfig } from "../../config/validate-memory-config.js";
import { MemoryConsolidator } from "../../lib/memory/consolidate/MemoryConsolidator.js";
import { anchorAutoPromotionEnabled, setAnchorAutoPromotionEnabled } from "../../lib/metrics.js";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";

let configImportSequence = 0;

async function loadConfig(envValue) {
  const name = "MEMENTO_AUTO_PROMOTE_ANCHORS";
  const previous = process.env[name];
  try {
    if (envValue === undefined) delete process.env[name];
    else process.env[name] = envValue;
    const mod = await import(`../../config/memory.js?auto-promote-test=${configImportSequence++}`);
    return mod.MEMORY_CONFIG;
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

describe("MEMENTO_AUTO_PROMOTE_ANCHORS 설정", () => {
  it("미지정/true는 기존 활성 동작을 유지한다", async () => {
    assert.equal((await loadConfig(undefined)).consolidate.autoPromoteAnchors, true);
    assert.equal((await loadConfig("true")).consolidate.autoPromoteAnchors, true);
  });

  it("false는 자동 승격을 비활성화한다", async () => {
    assert.equal((await loadConfig("false")).consolidate.autoPromoteAnchors, false);
  });

  it("빈 문자열은 미설정으로 취급하고 잘못된 값은 기동 검증에서 거부한다", async () => {
    assert.equal((await loadConfig("")).consolidate.autoPromoteAnchors, true);
    assert.equal((await loadConfig("   ")).consolidate.autoPromoteAnchors, true);
    const invalid = await loadConfig("yes");
    assert.throws(
      () => validateMemoryConfig(invalid),
      /MEMORY_CONFIG validation failed:.*consolidate\.autoPromoteAnchors must be true or false.*yes/s
    );
  });

  it("MemoryConsolidator 생성 전에도 metric이 설정값을 정확히 노출한다", async () => {
    for (const [envValue, expected] of [[undefined, 1], ["", 1], ["false", 0]]) {
      const config = await loadConfig(envValue);
      setAnchorAutoPromotionEnabled(config.consolidate.autoPromoteAnchors);
      const metric = await anchorAutoPromotionEnabled.get();
      assert.equal(metric.values[0].value, expected);
    }
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
      const progressEvents = [];
      const defs = consolidator._enrichmentStages({}, results)
        .filter(stage => ["utility_score_update", "promote_anchors"].includes(stage.name));

      const stages = await consolidator._executeStages(defs, results, event => progressEvents.push(event));

      assert.equal(consolidator._promoteAnchors.mock.callCount(), 0);
      assert.equal(consolidator._updateUtilityScores.mock.callCount(), 1);
      assert.equal(results.utilityUpdated, 3);
      assert.equal(results.anchorsPromoted, 0);
      assert.equal(stages[1].name, "promote_anchors");
      assert.equal(stages[1].affected, 0);
      assert.equal(stages[1].status, "skipped");
      assert.equal(stages[1].reason, "disabled_by_config");
      assert.equal(typeof stages[1].durationMs, "number");
      assert.equal(progressEvents[1].skipped, 0, "기존 진행 이벤트 계약을 유지해야 한다");
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
    });
  });

  it("consolidate 설정 블록이 없더라도 기존 승격 동작을 유지한다", async () => {
    const original = MEMORY_CONFIG.consolidate;
    delete MEMORY_CONFIG.consolidate;
    try {
      const consolidator = new MemoryConsolidator();
      consolidator._promoteAnchors = mock.fn(async () => 2);
      const results = { anchorsPromoted: 0 };
      const def = consolidator._enrichmentStages({}, results)
        .find(stage => stage.name === "promote_anchors");

      const stages = await consolidator._executeStages([def], results, () => {});

      assert.equal(consolidator._promoteAnchors.mock.callCount(), 1);
      assert.equal(results.anchorsPromoted, 2);
      assert.equal(stages[0].status, "ok");
    } finally {
      MEMORY_CONFIG.consolidate = original;
    }
  });
});
