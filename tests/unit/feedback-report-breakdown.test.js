/**
 * 피드백 리포트 집계 SQL 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-08-06
 *
 * ConsolidatorGC의 통계 수집 쿼리에 무관 판정 원인·outcome FILTER 절이
 * 실제로 포함되는지 검증한다.
 */

import { describe, it, mock } from "node:test";
import assert                 from "node:assert/strict";

mock.module("../../lib/tools/db.js", {
    namedExports: {
        getPrimaryPool      : () => ({ query: async () => ({ rows: [] }) }),
        getBatchPool        : () => null,
        shutdownPool        : async () => {},
        getPoolStats        : () => ({}),
        withTransaction     : async (fn) => fn({ query: async () => ({ rows: [] }) }),
        queryWithAgentVector: async () => ({ rows: [] }),
    },
});

const { ConsolidatorGC } = await import("../../lib/memory/consolidate/ConsolidatorGC.js");

/** 수집 메서드를 호출하고 실행된 SQL 문자열을 반환한다. */
async function captureSql(method) {
    let sql = null;
    const pool = {
        query: async (text) => {
            sql = text;
            return { rows: [] };
        },
    };
    const gc = Object.create(ConsolidatorGC.prototype);
    await gc[method](pool, "", []);
    return sql;
}

describe("_collectToolFeedbackStats SQL", () => {
    it("무관 판정 총수와 원인 5종 FILTER 절을 포함한다", async () => {
        const sql = await captureSql("_collectToolFeedbackStats");

        assert.match(sql, /FILTER \(WHERE relevant = false\)[\s\S]*AS irrelevant_count/);
        for (const reason of ["not_stored", "search_miss", "scope_leak", "topic_mismatch", "other"]) {
            assert.ok(
                sql.includes(`irrelevance_reason = '${reason}'`),
                `원인 ${reason} FILTER 절 누락`
            );
        }
    });

    it("원인 미보고(NULL) 카운트를 별도로 집계한다", async () => {
        const sql = await captureSql("_collectToolFeedbackStats");

        assert.ok(sql.includes("relevant = false AND irrelevance_reason IS NULL"));
        assert.ok(sql.includes("reason_unreported"));
    });

    it("기존 관련성·충분성·트리거유형 집계를 유지한다", async () => {
        const sql = await captureSql("_collectToolFeedbackStats");

        assert.ok(sql.includes("relevant_count"));
        assert.ok(sql.includes("sufficient_count"));
        assert.ok(sql.includes("sampled_count"));
        assert.ok(sql.includes("voluntary_count"));
    });
});

describe("_collectTaskStats SQL", () => {
    it("outcome 5종 FILTER 절을 포함한다", async () => {
        const sql = await captureSql("_collectTaskStats");

        for (const outcome of ["completed", "partial", "blocked", "abandoned", "unknown"]) {
            assert.ok(
                sql.includes(`outcome = '${outcome}'`),
                `outcome ${outcome} FILTER 절 누락`
            );
        }
    });

    it("미보고·human 평가·미충족 요구사항 카운트를 포함한다", async () => {
        const sql = await captureSql("_collectTaskStats");

        assert.ok(sql.includes("outcome IS NULL"));
        assert.ok(sql.includes("outcome_unreported"));
        assert.ok(sql.includes("evaluator = 'human'"));
        assert.ok(sql.includes("array_length(unmet_requirements, 1) > 0"));
    });

    it("기존 success_count 집계를 유지한다", async () => {
        const sql = await captureSql("_collectTaskStats");

        assert.ok(sql.includes("overall_success = true"));
        assert.ok(sql.includes("success_count"));
        assert.ok(sql.includes("total_sessions"));
    });
});
