/**
 * MemoryConsolidator stage 계측 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-31
 * 수정일: 2026-05-19
 *
 * consolidate()가 stages 배열을 반환하며 각 스테이지 항목의
 * 필수 속성(name, durationMs, affected, status)을 검증한다.
 * 실제 DB/Redis 연결 없이 순수 로직을 검증하기 위해 의존성을 모킹한다.
 */

import { describe, it, mock, before } from "node:test";
import assert                         from "node:assert/strict";

/** ── 의존성 모킹 ── */

const dbModuleUrl               = new URL("../../lib/tools/db.js", import.meta.url).href;
const redisModuleUrl            = new URL("../../lib/redis.js", import.meta.url).href;
const loggerModuleUrl           = new URL("../../lib/logger.js", import.meta.url).href;
const memoryConfigModuleUrl     = new URL("../../config/memory.js", import.meta.url).href;
const fragmentStoreModuleUrl    = new URL("../../lib/memory/write/FragmentStore.js", import.meta.url).href;
const fragmentIndexModuleUrl    = new URL("../../lib/memory/FragmentIndex.js", import.meta.url).href;
const embeddingWorkerModuleUrl = new URL("../../lib/memory/embedding/EmbeddingWorker.js", import.meta.url).href;
const contradictionModuleUrl    = new URL("../../lib/memory/link/ContradictionDetector.js", import.meta.url).href;
const consolidatorGCModuleUrl   = new URL("../../lib/memory/consolidate/ConsolidatorGC.js", import.meta.url).href;
const graphLinkerModuleUrl      = new URL("../../lib/memory/link/GraphLinker.js", import.meta.url).href;

mock.module(dbModuleUrl, {
    namedExports: {
        getPrimaryPool:       () => null,
        queryWithAgentVector: async () => ({ rows: [], rowCount: 0 }),
    },
});

mock.module(redisModuleUrl, {
    namedExports: {
        pushToQueue: async () => undefined,
        redisClient: null,
    },
});

mock.module(loggerModuleUrl, {
    namedExports: {
        logInfo:  () => {},
        logWarn:  () => {},
        logError: () => {},
        logDebug: () => {},
    },
});

mock.module(memoryConfigModuleUrl, {
    namedExports: {
        MEMORY_CONFIG: { gc: { utilityThreshold: 0.15 }, dedup: {} },
    },
});

/** FragmentStore 모킹 */
mock.module(fragmentStoreModuleUrl, {
    namedExports: {
        FragmentStore: class MockFragmentStore {
            decayImportance()       { return Promise.resolve(undefined); }
            deleteExpired()         { return Promise.resolve(0);         }
            transitionTTL()         { return Promise.resolve(undefined); }
            delete()                { return Promise.resolve(undefined); }
            createLink()            { return Promise.resolve(undefined); }
        },
    },
});

/** FragmentIndex 모킹 */
mock.module(fragmentIndexModuleUrl, {
    namedExports: {
        getFragmentIndex: () => ({
            pruneKeywordIndexes: async () => undefined,
        }),
    },
});

/** EmbeddingWorker 모킹 */
mock.module(embeddingWorkerModuleUrl, {
    namedExports: {
        EmbeddingWorker: class MockEmbeddingWorker {
            processOrphanFragments() { return Promise.resolve(0); }
        },
    },
});

/** ContradictionDetector 모킹 */
mock.module(contradictionModuleUrl, {
    namedExports: {
        ContradictionDetector: class MockContradictionDetector {
            resetCheckedPairs()             {}
            detectContradictions()          { return Promise.resolve({ found: 0, nliResolved: 0, nliSkipped: 0 }); }
            detectSupersessions()           { return Promise.resolve(0); }
            processPendingContradictions()  { return Promise.resolve(0); }
        },
    },
});

/** ConsolidatorGC 모킹 */
mock.module(consolidatorGCModuleUrl, {
    namedExports: {
        ConsolidatorGC: class MockConsolidatorGC {
            generateFeedbackReport() { return Promise.resolve(false); }
            collectStaleFragments()  { return Promise.resolve([]);    }
            purgeStaleReflections()  { return Promise.resolve(0);     }
            splitLongFragments()     { return Promise.resolve(0);     }
            calibrateByFeedback()    { return Promise.resolve(0);     }
            compressOldFragments()   { return Promise.resolve(0);     }
            _gcSearchEvents()        { return Promise.resolve(0);     }
        },
    },
});

/** GraphLinker 모킹 */
mock.module(graphLinkerModuleUrl, {
    namedExports: {
        GraphLinker: class MockGraphLinker {
            retroLink() { return Promise.resolve({ linksCreated: 0 }); }
        },
    },
});

/** ── 테스트 ── */

describe("MemoryConsolidator stage 계측", () => {
    let MemoryConsolidator;

    before(async () => {
        const mod        = await import("../../lib/memory/consolidate/MemoryConsolidator.js");
        MemoryConsolidator = mod.MemoryConsolidator;
    });

    it("consolidate()가 stages 배열을 포함하는 객체를 반환한다", async () => {
        const consolidator = new MemoryConsolidator();
        const result       = await consolidator.consolidate();

        assert.ok("stages" in result,          "result에 stages 속성이 없다");
        assert.ok(Array.isArray(result.stages), "stages가 배열이 아니다");
        assert.ok(result.stages.length > 0,    "stages가 비어 있다");
    });

    it("각 스테이지 항목은 name, durationMs, affected, status 속성을 갖는다", async () => {
        const consolidator = new MemoryConsolidator();
        const { stages }   = await consolidator.consolidate();

        for (const stage of stages) {
            assert.ok("name" in stage,                              `stage에 name 없음: ${JSON.stringify(stage)}`);
            assert.strictEqual(typeof stage.name,       "string",  "name이 string이 아니다");
            assert.ok(stage.name.length > 0,                       "name이 빈 문자열이다");

            assert.ok("durationMs" in stage,                       `stage에 durationMs 없음`);
            assert.strictEqual(typeof stage.durationMs, "number",  "durationMs가 number가 아니다");

            assert.ok("affected" in stage,                         `stage에 affected 없음`);
            assert.strictEqual(typeof stage.affected,   "number",  "affected가 number가 아니다");

            assert.ok("status" in stage,                           `stage에 status 없음`);
            assert.ok(["ok", "error"].includes(stage.status),      `status 값이 unexpected: ${stage.status}`);
        }
    });

    it("durationMs는 0 이상의 정수여야 한다", async () => {
        const consolidator = new MemoryConsolidator();
        const { stages }   = await consolidator.consolidate();

        for (const stage of stages) {
            assert.ok(stage.durationMs >= 0,              `durationMs < 0: ${stage.durationMs}`);
            assert.ok(Number.isInteger(stage.durationMs), `durationMs가 정수가 아님: ${stage.durationMs}`);
        }
    });

    it("정상 실행 시 status가 'ok'인 스테이지가 하나 이상 존재한다", async () => {
        const consolidator = new MemoryConsolidator();
        const { stages }   = await consolidator.consolidate();

        const okStages = stages.filter(s => s.status === "ok");
        assert.ok(okStages.length > 0, "ok 상태 스테이지가 없다");
    });

    it("기존 results 필드들이 여전히 반환된다 (하위 호환 보장)", async () => {
        const consolidator = new MemoryConsolidator();
        const result       = await consolidator.consolidate();

        assert.ok("ttlTransitions"   in result, "ttlTransitions 없음");
        assert.ok("expiredDeleted"   in result, "expiredDeleted 없음");
        assert.ok("duplicatesMerged" in result, "duplicatesMerged 없음");
        assert.ok("importanceDecay"  in result, "importanceDecay 없음");
    });
});
