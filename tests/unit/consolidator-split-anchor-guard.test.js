/**
 * Unit tests: 자식 합집합이 원문 수치 앵커를 잃으면 원본을 대체하지 않는다.
 *
 * 자식이 minItems를 넘겨도 명제가 통째로 누락될 수 있으므로,
 * 이 경우 insert도 tombstone도 하지 않고 원본을 그대로 둔다.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

let llmReturn = [];
const geminiModuleUrl              = new URL("../../lib/gemini.js", import.meta.url).href;
const dbModuleUrl                  = new URL("../../lib/tools/db.js", import.meta.url).href;
const configModuleUrl              = new URL("../../lib/config.js", import.meta.url).href;
const embeddingModuleUrl           = new URL("../../lib/tools/embedding.js", import.meta.url).href;
const loggerModuleUrl              = new URL("../../lib/logger.js", import.meta.url).href;
const splitMetricsModuleUrl        = new URL("../../lib/memory/consolidate/split-metrics.js", import.meta.url).href;
const properNounsModuleUrl         = new URL("../../lib/memory/consolidate/proper-nouns.js", import.meta.url).href;
const memoryConfigModuleUrl        = new URL("../../config/memory.js", import.meta.url).href;

mock.module(geminiModuleUrl, {
  namedExports: {
    isGeminiCLIAvailable: async () => true,
    geminiCLIJson       : async () => llmReturn
  }
});

mock.module(dbModuleUrl, {
  namedExports: {
    getPrimaryPool      : () => null,
    queryWithAgentVector: async () => ({ rows: [], rowCount: 0 })
  }
});

mock.module(configModuleUrl, {
  namedExports: {
    resolveSplitChainConfig: () => null,
    LLM_PRIMARY            : "gemini-cli",
    LLM_FALLBACKS          : [],
    buildSearchPath        : () => "agent_memory, public"
  }
});

mock.module(embeddingModuleUrl, {
  namedExports: {
    computeContentHash: (text) => `hash-${String(text).length}`,
    cosineSimilarity  : () => 0
  }
});

mock.module(loggerModuleUrl, {
  namedExports: {
    logInfo        : () => {},
    logWarn        : () => {},
    logError       : () => {},
    logDebug       : () => {},
    REDACT_PATTERNS: [],
    redactString   : (v) => v
  }
});

const skipReasons = [];
mock.module(splitMetricsModuleUrl, {
  namedExports: {
    recordSplitSkip  : (reason) => { skipReasons.push(reason); },
    splitSkippedTotal: { inc: () => {} }
  }
});

/** 주체 앵커 게이트 무력화 — 이 테스트의 관심사가 아니며 형태소 분석기 로드도 피한다. */
mock.module(properNounsModuleUrl, {
  namedExports: { extractSubjectAnchors: async () => [] }
});

mock.module(memoryConfigModuleUrl, {
  namedExports: {
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

/** 수치 앵커 2026 / 07 / 15 / 75 / 85 / 14 를 담은 원문 */
const PARENT_CONTENT =
  "A사는 2026-07-15 서면을 제출하여 대리인 지위를 취득했고 담당 부서는 접수 사실을 통지했다. " +
  "내부 검토 결과 인용 가능성은 75~85%로 평가되었으며 평가 근거가 함께 정리되었다. " +
  "증거 목록은 총 14건으로 확정되었고 추가 제출 계획은 없다고 기록되었다. " +
  "후속 절차와 담당자는 별도 문서에 정리되어 공유되었다.";

function makeStubs() {
  const inserted = [];
  let tombstoned = false;
  let backoffMarked = false;

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
            id: "parent-1", content: PARENT_CONTENT, topic: "legal",
            type: "fact", importance: 0.9, agent_id: "default", key_id: null
          }],
          rowCount: 1
        };
      }
      if (/split_attempt_failed_at = NOW\(\)/.test(sql)) backoffMarked = true;
      if (/UPDATE .*fragments/.test(sql) && /valid_to/.test(sql)) tombstoned = true;
      return { rowCount: 1, rows: [] };
    }
  };
  return { store, pool, inserted, tombstone: () => tombstoned, backoff: () => backoffMarked };
}

describe("split 앵커 커버리지 가드", () => {
  it("자식이 원문 앵커를 잃으면 insert도 tombstone도 하지 않는다", async () => {
    skipReasons.length = 0;
    /** "14건"에 해당하는 명제가 빠졌다. 나머지 앵커는 보존된다. */
    llmReturn = [
      "A사는 2026-07-15 서면을 제출하여 대리인 지위를 취득했다",
      "내부 검토 결과 인용 가능성은 75~85%로 평가되었다"
    ];
    const { store, pool, inserted, tombstone } = makeStubs();
    const count = await new ConsolidatorGC(store).splitLongFragments({ pool });

    assert.equal(inserted.length, 0, "앵커 유실 시 자식을 저장하지 않는다");
    assert.equal(tombstone(), false, "원본은 valid_to NULL을 유지한다");
    assert.equal(count, 0);
    assert.ok(skipReasons.includes("anchor_loss"), `기록된 reason: ${skipReasons.join(",")}`);
  });

  it("앵커 유실 시 재시도 backoff를 기록한다", async () => {
    skipReasons.length = 0;
    llmReturn = [
      "A사는 2026-07-15 서면을 제출하여 대리인 지위를 취득했다",
      "내부 검토 결과 인용 가능성은 75~85%로 평가되었다"
    ];
    const { store, pool, backoff } = makeStubs();
    await new ConsolidatorGC(store).splitLongFragments({ pool });

    assert.equal(backoff(), true, "다음 사이클 즉시 재시도를 막아야 한다");
  });

  it("모든 앵커가 보존되면 정상 분할한다", async () => {
    skipReasons.length = 0;
    llmReturn = [
      "A사는 2026-07-15 서면을 제출하여 대리인 지위를 취득했다",
      "내부 검토 결과 인용 가능성은 75~85%로 평가되었다",
      "증거 목록은 총 14건으로 확정되었다"
    ];
    const { store, pool, inserted, tombstone } = makeStubs();
    const count = await new ConsolidatorGC(store).splitLongFragments({ pool });

    assert.equal(inserted.length, 3);
    assert.equal(tombstone(), true, "앵커가 보존되면 원본을 대체한다");
    assert.equal(count, 1);
    assert.equal(skipReasons.length, 0);
  });
});
