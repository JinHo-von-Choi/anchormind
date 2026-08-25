/**
 * Unit tests: 자식이 부모의 주어 앵커를 잃으면 해당 자식을 폐기한다.
 *
 * 남은 자식이 minItems 미만이면 low_yield 경로로 떨어져 원본을 그대로 보존한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-08-06
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

let llmReturn = [];
const geminiModuleUrl       = new URL("../../lib/gemini.js", import.meta.url).href;
const dbModuleUrl           = new URL("../../lib/tools/db.js", import.meta.url).href;
const configModuleUrl       = new URL("../../lib/config.js", import.meta.url).href;
const embeddingModuleUrl    = new URL("../../lib/tools/embedding.js", import.meta.url).href;
const loggerModuleUrl       = new URL("../../lib/logger.js", import.meta.url).href;
const splitMetricsModuleUrl = new URL("../../lib/memory/consolidate/split-metrics.js", import.meta.url).href;
const properNounsModuleUrl  = new URL("../../lib/memory/consolidate/proper-nouns.js", import.meta.url).href;
const memoryConfigModuleUrl = new URL("../../config/memory.js", import.meta.url).href;

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
  namedExports: { computeContentHash: (text) => `hash-${String(text).length}` }
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

/** 형태소 분석기(WASM) 로드를 피하고 앵커 집합을 결정적으로 고정한다. */
let subjectAnchors = [];
mock.module(properNounsModuleUrl, {
  namedExports: { extractSubjectAnchors: async () => subjectAnchors }
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
        failureBackoffHours: 24,
        subjectAnchorMax   : 12
      }
    }
  }
});

const { ConsolidatorGC } = await import("../../lib/memory/consolidate/ConsolidatorGC.js");

/** 주체는 A사 하나, 수치 앵커와 양상 표지가 없는 단정문 원문 */
const PARENT_CONTENT =
  "A사는 서면을 제출하여 대리인 지위를 취득했고 담당 부서는 접수 사실을 통지했다. " +
  "A사의 내부 검토 결과 인용률은 양호하게 평가되었으며 평가 근거가 함께 정리되었다. " +
  "A사가 제출한 증거 목록은 확정되었고 추가 제출 계획은 없다고 기록되었다. " +
  "후속 절차와 담당자는 별도 문서에 정리되어 공유되었다.";

function makeStubs() {
  const inserted = [];
  let tombstoned = false;

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
      if (/UPDATE .*fragments/.test(sql) && /valid_to/.test(sql)) tombstoned = true;
      return { rowCount: 1, rows: [] };
    }
  };
  return { store, pool, inserted, tombstone: () => tombstoned };
}

describe("split 주체 앵커 가드", () => {
  it("앵커를 담지 못한 자식만 폐기하고 subject_loss를 기록한다", async () => {
    skipReasons.length = 0;
    subjectAnchors     = ["A사"];
    llmReturn = [
      "A사는 서면을 제출하여 대리인 지위를 취득했다",
      "A사의 내부 검토 결과 인용률은 양호하게 평가되었다",
      "증거 목록은 확정된 것으로 기록되었다"                     // 주체 유실
    ];
    const { store, pool, inserted, tombstone } = makeStubs();
    const count = await new ConsolidatorGC(store).splitLongFragments({ pool });

    assert.equal(inserted.length, 2, "앵커를 가진 자식만 저장된다");
    assert.ok(inserted.every(c => c.content.includes("A사")));
    assert.equal(tombstone(), true);
    assert.equal(count, 1);
    assert.ok(skipReasons.includes("subject_loss"), `기록된 reason: ${skipReasons.join(",")}`);
  });

  it("잔여 자식이 minItems 미만이면 원본을 보존한다", async () => {
    skipReasons.length = 0;
    subjectAnchors     = ["A사"];
    llmReturn = [
      "A사는 서면을 제출하여 대리인 지위를 취득했다",
      "내부 검토 결과 인용률은 양호하게 평가되었다",              // 주체 유실
      "증거 목록은 확정된 것으로 기록되었다"                     // 주체 유실
    ];
    const { store, pool, inserted, tombstone } = makeStubs();
    const count = await new ConsolidatorGC(store).splitLongFragments({ pool });

    assert.equal(inserted.length, 0, "Phase-1 게이트가 insert 전에 중단시킨다");
    assert.equal(tombstone(), false, "원본은 valid_to NULL을 유지한다");
    assert.equal(count, 0);
    assert.ok(skipReasons.includes("subject_loss"));
    assert.ok(skipReasons.includes("low_yield"), `기록된 reason: ${skipReasons.join(",")}`);
  });

  it("앵커가 비면 주체 검사를 건너뛴다", async () => {
    skipReasons.length = 0;
    subjectAnchors     = [];
    llmReturn = [
      "내부 검토 결과 인용률은 양호하게 평가되었다",
      "증거 목록은 확정된 것으로 기록되었다",
      "담당 부서는 접수 사실을 신청인에게 통지했다"
    ];
    const { store, pool, inserted } = makeStubs();
    await new ConsolidatorGC(store).splitLongFragments({ pool });

    assert.equal(inserted.length, 3);
    assert.equal(skipReasons.includes("subject_loss"), false);
  });

  it("부모에 없던 양상을 도입한 자식은 modality_drift로 폐기한다", async () => {
    skipReasons.length = 0;
    subjectAnchors     = ["A사"];
    llmReturn = [
      "A사는 서면을 제출하여 대리인 지위를 취득했다",
      "A사의 내부 검토 결과 인용률은 양호하게 평가되었다",
      "A사는 증거 목록을 추가로 제출할 예정이다"          // 양상 도입
    ];
    const { store, pool, inserted } = makeStubs();
    await new ConsolidatorGC(store).splitLongFragments({ pool });

    assert.equal(inserted.length, 2);
    assert.ok(inserted.every(c => !/예정이다/.test(c.content)));
    assert.ok(skipReasons.includes("modality_drift"), `기록된 reason: ${skipReasons.join(",")}`);
  });
});
