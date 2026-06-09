/**
 * Unit tests: splitLongFragments aborts (no child, no tombstone) when the gate
 * yields fewer than minItems clean children — closing the orphan+duplicate hole.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

let llmReturn = [];
mock.module("../../lib/gemini.js", {
  namedExports: {
    isGeminiCLIAvailable: async () => true,
    geminiCLIJson       : async () => llmReturn
  }
});

mock.module("../../lib/tools/db.js", {
  exports: {
    getPrimaryPool       : () => null,
    queryWithAgentVector : async () => ({ rows: [], rowCount: 0 })
  }
});

mock.module("../../lib/config.js", {
  namedExports: { resolveSplitChainConfig: () => null, LLM_PRIMARY: "gemini-cli", LLM_FALLBACKS: [] }
});

mock.module("../../lib/logger.js", {
  exports: {
    logInfo        : () => {},
    logWarn        : () => {},
    logError       : () => {},
    logDebug       : () => {},
    REDACT_PATTERNS: [],
    redactString   : (v) => v
  }
});

mock.module("../../lib/memory/consolidate/split-metrics.js", {
  namedExports: {
    recordSplitSkip  : () => {},
    splitSkippedTotal: { inc: () => {} }
  }
});

mock.module("../../config/memory.js", {
  exports: {
    MEMORY_CONFIG: {
      fragmentSplit: {
        lengthThreshold  : 300,
        batchSize        : 10,
        minItems         : 2,
        maxItems         : 8,
        timeoutMs        : 30_000,
        excludeMetaTopics: [],
        failureBackoffHours: 24
      }
    }
  }
});

const { ConsolidatorGC } = await import("../../lib/memory/ConsolidatorGC.js");

function makeStubs() {
  const inserted = [];
  const deleted  = [];
  let   tombstoned = false;
  const store = {
    insert    : async (f) => { inserted.push(f); return f.id; },
    delete    : async (id) => { deleted.push(id); return true; },
    createLink: async () => {}
  };
  const pool = {
    query: async (sql) => {
      if (/SELECT id, content/.test(sql)) {
        return { rows: [{ id: "parent-1", content: "z".repeat(400), topic: "infra", type: "fact", importance: 0.9, agent_id: "default", key_id: null }], rowCount: 1 };
      }
      if (/UPDATE .*fragments/.test(sql) && /valid_to/.test(sql)) { tombstoned = true; }
      return { rowCount: 1, rows: [] };
    }
  };
  return { store, pool, inserted, deleted, tombstone: () => tombstoned };
}

describe("splitLongFragments partial-yield safety", () => {
  it("all children rejected ⇒ no insert, original NOT tombstoned", async () => {
    llmReturn = ["짧다", "이 값은 그대로다", "그것은 메타다"]; // all fail gate
    const { store, pool, inserted, tombstone } = makeStubs();
    const count = await new ConsolidatorGC(store).splitLongFragments({ pool });
    assert.equal(inserted.length, 0);
    assert.equal(tombstone(), false, "original must keep valid_to NULL");
    assert.equal(count, 0);
  });

  it("only 1 child passes (< minItems=2) ⇒ no insert, original NOT tombstoned", async () => {
    llmReturn = [
      "Redis는 포트 6379로 동작하는 메모리 기반 저장소다", // pass
      "짧다",                                               // fail
      "이 값은 환경 변수로 주입되어 컨테이너에 전달된다"      // fail (pronoun)
    ];
    const { store, pool, inserted, tombstone } = makeStubs();
    await new ConsolidatorGC(store).splitLongFragments({ pool });
    assert.equal(inserted.length, 0, "Phase-1 gate aborts before any insert");
    assert.equal(tombstone(), false, "original survives intact");
  });
});
