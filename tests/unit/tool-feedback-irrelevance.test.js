/**
 * tool_feedback irrelevance_reason 계측 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-08-06
 *
 * relevant=false인 경우에만 허용값이 저장되고, 그 외에는 NULL로 떨어지는지 검증한다.
 */

import { describe, it, mock } from "node:test";
import assert                 from "node:assert/strict";

const capturedQueries = [];

const mockPool = {
    query: async (sql, params) => {
        capturedQueries.push({ sql, params });
        return { rows: [{ id: 1 }] };
    },
};

mock.module("../../lib/tools/db.js", {
    namedExports: {
        getPrimaryPool      : () => mockPool,
        getBatchPool        : () => null,
        shutdownPool        : async () => {},
        getPoolStats        : () => ({}),
        withTransaction     : async (fn) => fn(mockPool),
        queryWithAgentVector: async (agentId, sql, params) => {
            capturedQueries.push({ sql, params });
            return { rows: [] };
        },
    },
});

const { MemoryRecaller, normalizeIrrelevanceReason } =
    await import("../../lib/memory/processors/MemoryRecaller.js");

/** toolFeedback을 호출하고 INSERT 쿼리 1건을 반환한다. */
async function runToolFeedback(params) {
    capturedQueries.length = 0;
    const recaller = Object.create(MemoryRecaller.prototype);
    await recaller.toolFeedback(params);
    return capturedQueries.find(q => q.sql.includes("INSERT INTO agent_memory.tool_feedback"));
}

describe("normalizeIrrelevanceReason", () => {
    it("relevant=true면 값이 실려도 null", () => {
        assert.strictEqual(
            normalizeIrrelevanceReason({ relevant: true, irrelevance_reason: "search_miss" }),
            null
        );
    });

    it("relevant 미지정이면 null", () => {
        assert.strictEqual(normalizeIrrelevanceReason({ irrelevance_reason: "not_stored" }), null);
    });

    it("relevant=false + 비허용값은 null", () => {
        assert.strictEqual(
            normalizeIrrelevanceReason({ relevant: false, irrelevance_reason: "bad_luck" }),
            null
        );
    });

    it("relevant=false + 원인 누락은 null", () => {
        assert.strictEqual(normalizeIrrelevanceReason({ relevant: false }), null);
    });

    it("relevant=false + 허용 5종은 그대로 반환", () => {
        for (const reason of ["not_stored", "search_miss", "scope_leak", "topic_mismatch", "other"]) {
            assert.strictEqual(
                normalizeIrrelevanceReason({ relevant: false, irrelevance_reason: reason }),
                reason
            );
        }
    });
});

describe("toolFeedback INSERT", () => {
    it("relevant=true면 irrelevance_reason 파라미터가 null", async () => {
        const q = await runToolFeedback({
            tool_name         : "recall",
            relevant          : true,
            sufficient        : true,
            irrelevance_reason: "search_miss",
        });

        assert.ok(q.sql.includes("irrelevance_reason"));
        assert.strictEqual(q.params.length, 9);
        assert.strictEqual(q.params[8], null);
    });

    it("비허용값은 null로 떨어진다", async () => {
        const q = await runToolFeedback({
            tool_name         : "recall",
            relevant          : false,
            sufficient        : false,
            irrelevance_reason: "무관함",
        });

        assert.strictEqual(q.params[8], null);
    });

    it("relevant=false + not_stored는 저장된다", async () => {
        const q = await runToolFeedback({
            tool_name         : "recall",
            relevant          : false,
            sufficient        : false,
            irrelevance_reason: "not_stored",
        });

        assert.strictEqual(q.params[8], "not_stored");
        assert.ok(q.sql.includes("$9"));
    });
});
