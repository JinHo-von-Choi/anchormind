/**
 * 분할 커밋 단계 실패 기록 시험
 *
 * 롤백 삭제와 링크 생성이 실패해도 분할 판정은 그대로 두고, 실패를 step 지표와
 * 부모·자식 id를 담은 경고로 남긴다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, mock } from "node:test";
import assert                 from "node:assert/strict";

const warnings = [];

mock.module("../../lib/gemini.js", {
  exports: {
    isGeminiCLIAvailable: async () => true,
    geminiCLIJson       : async () => [
      "Redis는 포트 6379로 동작하는 메모리 기반 저장소다",
      "PostgreSQL은 포트 5432에서 연결을 받는 관계형 데이터베이스다"
    ]
  }
});
mock.module("../../lib/logger.js", {
  exports: {
    logInfo        : () => {},
    logWarn        : (msg) => warnings.push(msg),
    logError       : () => {},
    logDebug       : () => {},
    REDACT_PATTERNS: [],
    redactString   : (v) => v
  }
});
mock.module("../../lib/memory/consolidate/proper-nouns.js", {
  exports: { extractSubjectAnchors: async () => [] }
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
const { register }       = await import("../../lib/metrics.js");

async function stepFailures(step) {
  const values = (await register.getSingleMetric("memento_consolidate_split_step_failed_total").get()).values;
  return values.find(v => v.labels.step === step)?.value ?? 0;
}

function makePool() {
  const state = { tombstoned: false };
  const pool  = {
    query: async (sql) => {
      if (/SELECT id, content/.test(sql)) {
        return { rows: [{ id: "parent-1", content: "z".repeat(400), topic: "infra", type: "fact", importance: 0.9, agent_id: "default", key_id: null }], rowCount: 1 };
      }
      if (/SET valid_to/.test(sql)) state.tombstoned = true;
      return { rowCount: 1, rows: [] };
    }
  };
  return { pool, state };
}

describe("분할 커밋 단계 실패", () => {
  it("삽입 부족 롤백에서 삭제가 실패하면 rollback_delete로 남기고 부모를 닫지 않는다", async () => {
    let n = 0;
    const store = {
      insert    : async (f) => (n++ === 0 ? f.id : null),
      delete    : async () => { throw new Error("delete failed"); },
      createLink: async () => {}
    };
    const { pool, state } = makePool();
    const before          = await stepFailures("rollback_delete");
    await new ConsolidatorGC(store).splitLongFragments({ pool });
    assert.equal(await stepFailures("rollback_delete"), before + 1);
    assert.equal(state.tombstoned, false);
    assert.ok(warnings.some(w => /split rollback_delete failed: parent=parent-1 child=/.test(w)));
  });

  it("링크 생성이 실패하면 link_related, link_part_of로 남기고 분할은 끝낸다", async () => {
    const store = {
      insert    : async (f) => f.id,
      delete    : async () => true,
      createLink: async () => { throw new Error("link failed"); }
    };
    const { pool, state } = makePool();
    const related         = await stepFailures("link_related");
    const partOf          = await stepFailures("link_part_of");
    await new ConsolidatorGC(store).splitLongFragments({ pool });
    assert.equal(await stepFailures("link_related"), related + 1);
    assert.equal(await stepFailures("link_part_of"), partOf + 2);
    assert.equal(state.tombstoned, true);
  });
});
