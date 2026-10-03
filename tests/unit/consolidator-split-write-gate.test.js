/**
 * 통합 분할 자식의 의미 쓰기 관문 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * LLM이 쓴 분할 자식은 부모의 키와 workspace로 의미 쓰기 관문을 거쳐 마스킹과 길이 상한을 받는다.
 * 20자 품질 판정과 분할 결과 형태(자식 수, 출처, 키워드)는 그대로다.
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

mock.module("../../lib/memory/FragmentIndex.js", {
  namedExports: { deindexRows: async () => {} }
});

mock.module("../../lib/tools/db.js", {
  exports: {
    getPrimaryPool      : () => null,
    queryWithAgentVector: async () => ({ rows: [], rowCount: 0 })
  }
});

mock.module("../../lib/config.js", {
  namedExports: {
    /** 분할 자식이 거치는 의미 쓰기 관문과 서버 관문 의존성(ApiKeyStore)이 읽는 값 */
    writeGateEnabled       : () => true,
    provenanceEnabled      : () => true,
    reviewQueueEnabled     : () => true,
    sensitiveScanMode      : () => "mask",
    sensitiveScanEffectiveMode: () => "mask",
    /** ConsolidatorGC가 배경 쓰기 실패를 세는 lock-retry가 읽는 값 */
    envInt                 : (_name, fallback) => fallback,
    DEFAULT_DB_LOCK_RETRY_MAX: 3,
    MAX_DB_LOCK_RETRY_MAX  : 10,
    workspaceGateEnforced  : () => false,
    DEFAULT_DAILY_LIMIT    : 1000,
    DEFAULT_FRAGMENT_LIMIT : 5000,
    DEFAULT_PERMISSIONS    : ["read", "write"],
    resolveSplitChainConfig: () => null,
    ALLOW_LEGACY_UNBOUND_AGENT_SCOPE: false,
    reservedAgentIdsMode: () => "warn",
    LLM_PRIMARY            : "gemini-cli",
    LLM_FALLBACKS          : [],
    /** FragmentWriter가 요구한다. 이 테스트는 DB 경로를 타지 않으므로 값은 무의미 */
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

const skips = [];
mock.module("../../lib/memory/consolidate/split-metrics.js", {
  namedExports: {
    recordSplitStepFailure: () => {},
    recordSplitSkip       : (reason) => { skips.push(reason); },
    splitSkippedTotal     : { inc: () => {} }
  }
});

/** 주체 앵커 게이트 무력화: 이 테스트의 관심사가 아니며 형태소 분석기 로드도 피한다. */
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
const { WriteGate, WriteInputError } = await import("../../lib/memory/write/WriteGate.js");

/** 넘어온 요청을 기록하는 관문 */
class RecordingGate extends WriteGate {
  constructor(requests, deps) {
    super(deps);
    this.requests = requests;
  }
  async check(request) {
    this.requests.push(request);
    return super.check(request);
  }
}

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
            type: "fact", importance: 0.9, agent_id: "default", key_id: "key-7", workspace: "ws-1"
          }],
          rowCount: 1
        };
      }
      return { rowCount: 1, rows: [] };
    }
  };
  return { store, pool, inserted };
}

describe("통합 분할 자식의 의미 쓰기 관문", () => {
  it("비밀 형태 문자열을 마스킹하고 키워드도 마스킹된 본문에서 뽑는다", async () => {
    llmReturn = [
      "장애 보고는 담당자 ops-team@example.com 메일로 접수했다",
      "worker_connections 값을 8192로 올린 뒤 복구가 완료되었다"
    ];
    const { store, pool, inserted } = makeStubs();
    await new ConsolidatorGC(store, { writeGate: () => new WriteGate() }).splitLongFragments({ pool });

    assert.equal(inserted.length, 2);
    assert.ok(inserted[0].content.includes("[REDACTED_EMAIL]"), inserted[0].content);
    assert.ok(!inserted[0].content.includes("ops-team@example.com"));
    assert.ok(!inserted[0].keywords.some(k => k.includes("example")), inserted[0].keywords.join(","));
    assert.equal(inserted[0].source, "split:parent-1");
  });

  it("저장 상한을 넘는 자식은 잘라 기록한다", async () => {
    llmReturn = [
      `긴 자식 본문 ${"가".repeat(400)}`,
      "worker_connections 값을 8192로 올린 뒤 복구가 완료되었다"
    ];
    const { store, pool, inserted } = makeStubs();
    await new ConsolidatorGC(store, { writeGate: () => new WriteGate() }).splitLongFragments({ pool });

    assert.equal(inserted.length, 2);
    assert.equal(inserted[0].content.length, 303);
    assert.ok(inserted[0].content.endsWith("..."));
  });

  it("부모의 키와 workspace로 판정하고 자식은 부모 workspace에 둔다", async () => {
    llmReturn = [
      "nginx 업스트림 커넥션 풀이 고갈되어 502 응답률이 상승했다",
      "worker_connections 값을 8192로 올린 뒤 복구가 완료되었다"
    ];
    const requests = [];
    const { store, pool, inserted } = makeStubs();
    await new ConsolidatorGC(store, { writeGate: () => new RecordingGate(requests) }).splitLongFragments({ pool });

    assert.deepEqual(requests.map(r => [r.entry, r.ctx.keyId]), [["consolidate_split", "key-7"], ["consolidate_split", "key-7"]]);
    assert.deepEqual(inserted.map(f => [f.key_id, f.workspace]), [["key-7", "ws-1"], ["key-7", "ws-1"]]);
  });

  it("20자 미만 자식은 관문 전에 거르고 관문이 거부한 자식은 건너뛴다", async () => {
    llmReturn = [
      "짧은 자식",
      "nginx 업스트림 커넥션 풀이 고갈되어 502 응답률이 상승했다",
      "worker_connections 값을 8192로 올린 뒤 복구가 완료되었다",
      "관문이 거부하도록 만든 세 번째 자식 본문이다"
    ];
    skips.length = 0;
    const requests = [];
    const gate     = new RecordingGate(requests, {
      steps: { normalize: (state) => {
        if (state.fields.content.startsWith("관문이")) throw new WriteInputError("rejected for test");
        return state;
      } }
    });
    const { store, pool, inserted } = makeStubs();
    await new ConsolidatorGC(store, { writeGate: () => gate }).splitLongFragments({ pool });

    assert.equal(requests.length, 3, "20자 미만 자식은 관문에 오지 않는다");
    assert.equal(inserted.length, 2);
    assert.ok(skips.includes("write_gate"));
  });
});
