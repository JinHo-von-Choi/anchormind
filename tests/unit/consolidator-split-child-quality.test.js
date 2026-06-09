/**
 * Unit tests: splitLongFragments gates children + clamps importance + uses split chain.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const llmCalls = [];
mock.module("../../lib/gemini.js", {
  namedExports: {
    isGeminiCLIAvailable: async () => true,
    geminiCLIJson       : async (_p, opts) => {
      llmCalls.push(opts);
      return [
        "Redis는 포트 6379로 동작하는 메모리 기반 저장소다",   // accept
        "Redis는 TTL 만료 정책으로 오래된 키를 자동 삭제한다", // accept (2번째 clean child)
        "짧다",                                                  // reject (<20)
        "이 값은 환경 변수로 주입되어 컨테이너에 전달된다",        // reject (pronoun)
        "TTL 만료 정책을 候補 지원하여 오래된 키를 제거한다"        // reject (CJK)
      ];
    }
  }
});

mock.module("../../lib/tools/db.js", {
  exports: {
    getPrimaryPool       : () => null,
    queryWithAgentVector : async () => ({ rows: [], rowCount: 0 })
  }
});

mock.module("../../lib/config.js", {
  namedExports: {
    resolveSplitChainConfig: () => [{ provider: "xai" }],
    LLM_PRIMARY            : "gemini-cli",
    LLM_FALLBACKS          : []
  }
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
  const links    = [];
  const store = {
    insert    : async (f) => { inserted.push(f); return f.id; },
    createLink: async (a, b, rel) => { links.push([a, b, rel]); }
  };
  const pool = {
    query: async (sql) => {
      if (/SELECT id, content/.test(sql)) {
        return { rows: [{
          id: "parent-1",
          content: "x".repeat(400),
          topic: "infra", type: "fact", importance: 0.9,
          agent_id: "default", key_id: null
        }], rowCount: 1 };
      }
      return { rowCount: 1, rows: [] };
    }
  };
  return { store, pool, inserted, links };
}

describe("splitLongFragments quality gate", () => {
  it("inserts only accepted children with clamped importance", async () => {
    llmCalls.length = 0;
    const { store, pool, inserted } = makeStubs();
    const c = new ConsolidatorGC(store);
    await c.splitLongFragments({ pool });

    assert.equal(inserted.length, 2, "only the two clean children survive the gate");
    assert.equal(inserted[0].content, "Redis는 포트 6379로 동작하는 메모리 기반 저장소다");
    assert.equal(inserted[0].importance, 0.63); // 0.9*0.7
  });

  it("passes the split chain through options.providers", async () => {
    llmCalls.length = 0;
    const { store, pool } = makeStubs();
    const c = new ConsolidatorGC(store);
    await c.splitLongFragments({ pool });
    assert.deepEqual(llmCalls[0].providers, [{ provider: "xai" }]);
  });

  it("tombstones the original with an importance floor of 0.2 (not 0.3x)", async () => {
    const { store } = makeStubs();
    let tombstoneSql = null;
    const pool = {
      query: async (sql, _params) => {
        if (/SELECT id, content/.test(sql)) {
          return { rows: [{ id: "parent-1", content: "y".repeat(400), topic: "infra", type: "fact", importance: 0.9, agent_id: "default", key_id: null }], rowCount: 1 };
        }
        if (/UPDATE .*fragments/.test(sql)) { tombstoneSql = sql; }
        return { rowCount: 1, rows: [] };
      }
    };
    const c = new ConsolidatorGC(store);
    await c.splitLongFragments({ pool });
    assert.match(tombstoneSql, /GREATEST\(0\.2,/);
    assert.match(tombstoneSql, /ttl_tier\s*=\s*'cold'/);
  });
});
