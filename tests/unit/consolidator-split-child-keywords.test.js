/**
 * Unit tests: split 자식 파편이 본문 기반 keywords와 함께 저장되는지 검증한다.
 *
 * 빈 keywords로 저장되면 keywords 배열 교집합(&&)을 쓰는 검색 경로에서
 * 영구히 조회되지 않으므로, 정상 저장 경로(FragmentFactory)와 동일한
 * 추출 규칙이 적용되어야 한다.
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
    getPrimaryPool      : () => null,
    queryWithAgentVector: async () => ({ rows: [], rowCount: 0 })
  }
});

mock.module("../../lib/config.js", {
  namedExports: {
    resolveSplitChainConfig: () => null,
    LLM_PRIMARY            : "gemini-cli",
    LLM_FALLBACKS          : [],
    /** FragmentWriter가 요구 — 이 테스트는 DB 경로를 타지 않으므로 값은 무의미 */
    buildSearchPath        : () => "agent_memory, public"
  }
});

/** FragmentFactory → FragmentWriter → embedding.js 경로가 실제 config를 요구하므로 최소 대체 */
mock.module("../../lib/tools/embedding.js", {
  namedExports: {
    computeContentHash: (text) => `hash-${String(text).length}`,
    cosineSimilarity  : () => 0
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

/** 주체 앵커 게이트 무력화 — 이 테스트의 관심사가 아니며 형태소 분석기 로드도 피한다. */
mock.module("../../lib/memory/consolidate/proper-nouns.js", {
  namedExports: { extractSubjectAnchors: async () => [] }
});

mock.module("../../config/memory.js", {
  exports: {
    MEMORY_CONFIG: {
      fragmentSplit: {
        lengthThreshold    : 300,
        batchSize          : 10,
        minItems           : 2,
        maxItems           : 8,
        timeoutMs          : 30_000,
        excludeMetaTopics  : [],
        failureBackoffHours: 24
      }
    }
  }
});

const { ConsolidatorGC } = await import("../../lib/memory/consolidate/ConsolidatorGC.js");

function makeStubs() {
  const inserted = [];
  const store = {
    insert    : async (f) => { inserted.push(f); return f.id; },
    delete    : async () => true,
    createLink: async () => {}
  };
  const pool = {
    query: async (sql) => {
      if (/SELECT id, content/.test(sql)) {
        return {
          rows: [{
            id: "parent-1", content: "z".repeat(400), topic: "infra",
            type: "fact", importance: 0.9, agent_id: "default", key_id: null
          }],
          rowCount: 1
        };
      }
      return { rowCount: 1, rows: [] };
    }
  };
  return { store, pool, inserted };
}

describe("split 자식 keywords 생성", () => {
  it("자식마다 본문에서 추출한 keywords를 채워 저장한다", async () => {
    llmReturn = [
      "nginx 업스트림 커넥션 풀이 고갈되어 502 응답률이 상승했다",
      "worker_connections 값을 8192로 올린 뒤 복구가 완료되었다"
    ];
    const { store, pool, inserted } = makeStubs();
    await new ConsolidatorGC(store).splitLongFragments({ pool });

    assert.equal(inserted.length, 2);
    for (const child of inserted) {
      assert.ok(Array.isArray(child.keywords), "keywords는 배열이어야 한다");
      assert.ok(child.keywords.length > 0, `빈 keywords로 저장됨: ${child.content}`);
    }
  });

  it("추출된 keywords가 자식 본문의 고유 토큰을 반영한다", async () => {
    llmReturn = [
      "nginx 업스트림 커넥션 풀이 고갈되어 502 응답률이 상승했다",
      "worker_connections 값을 8192로 올린 뒤 복구가 완료되었다"
    ];
    const { store, pool, inserted } = makeStubs();
    await new ConsolidatorGC(store).splitLongFragments({ pool });

    const first  = inserted[0].keywords.join(" ");
    const second = inserted[1].keywords.join(" ");
    assert.ok(first.includes("nginx"), `첫 자식 keywords에 nginx 없음: ${first}`);
    assert.ok(second.includes("worker_connections"), `둘째 자식 keywords에 식별자 없음: ${second}`);
    assert.notDeepEqual(inserted[0].keywords, inserted[1].keywords, "자식마다 본문 기준으로 달라야 한다");
  });
});
