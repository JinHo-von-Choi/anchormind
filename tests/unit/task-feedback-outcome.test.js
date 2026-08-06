/**
 * task_feedback outcome 계측 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-08-06
 *
 * normalizeTaskEffectiveness 순수 규칙과 _saveTaskFeedback의 8컬럼 INSERT 파라미터를 검증한다.
 */

import { describe, it, mock } from "node:test";
import assert                 from "node:assert/strict";

const capturedQueries = [];

mock.module("../../lib/memory/embedding/MorphemeIndex.js", {
    namedExports: {
        MorphemeIndex: class {
            async tokenize()                { return []; }
            async getOrRegisterEmbeddings() { return []; }
        },
    },
});

mock.module("../../lib/tools/db.js", {
    namedExports: {
        getPrimaryPool: () => ({
            query: async (sql, params) => {
                capturedQueries.push({ sql, params });
                return { rows: [] };
            },
        }),
    },
});

const { ReflectProcessor, normalizeTaskEffectiveness } =
    await import("../../lib/memory/processors/ReflectProcessor.js");

describe("normalizeTaskEffectiveness", () => {
    it("undefined 입력은 전부 기본값으로 떨어진다", () => {
        const r = normalizeTaskEffectiveness(undefined);
        assert.strictEqual(r.outcome,        null);
        assert.strictEqual(r.evaluator,      null);
        assert.strictEqual(r.evidence,       null);
        assert.deepStrictEqual(r.unmetRequirements, []);
        assert.strictEqual(r.overallSuccess, false);
    });

    it("허용값 outcome은 그대로 유지되고 evaluator 기본값 agent가 부여된다", () => {
        const r = normalizeTaskEffectiveness({ outcome: "partial" });
        assert.strictEqual(r.outcome,   "partial");
        assert.strictEqual(r.evaluator, "agent");
    });

    it("허용 목록 밖 outcome은 추정하지 않고 null이며 evaluator도 부여되지 않는다", () => {
        const r = normalizeTaskEffectiveness({ outcome: "success", evaluator: "human" });
        assert.strictEqual(r.outcome,   null);
        assert.strictEqual(r.evaluator, null);
    });

    it("허용 목록 밖 evaluator는 agent로 대체된다", () => {
        const r = normalizeTaskEffectiveness({ outcome: "completed", evaluator: "robot" });
        assert.strictEqual(r.evaluator, "agent");
    });

    it("evaluator 허용값은 보존된다", () => {
        const r = normalizeTaskEffectiveness({ outcome: "blocked", evaluator: "automatic" });
        assert.strictEqual(r.evaluator, "automatic");
    });

    it("evidence는 trim 후 1000자로 절단된다", () => {
        const r = normalizeTaskEffectiveness({ evidence: `  ${"가".repeat(1200)}  ` });
        assert.strictEqual(r.evidence.length, 1000);
        assert.strictEqual(r.evidence[0],     "가");
    });

    it("공백뿐인 evidence는 null", () => {
        assert.strictEqual(normalizeTaskEffectiveness({ evidence: "   " }).evidence, null);
    });

    it("unmet_requirements는 20개·각 200자로 제한된다", () => {
        const items = Array.from({ length: 30 }, () => "x".repeat(250));
        const r     = normalizeTaskEffectiveness({ unmet_requirements: items });
        assert.strictEqual(r.unmetRequirements.length,    20);
        assert.strictEqual(r.unmetRequirements[0].length, 200);
    });

    it("비문자열·공백 항목은 unmet_requirements에서 제거된다", () => {
        const r = normalizeTaskEffectiveness({ unmet_requirements: ["유효 항목", "", "   ", 42, null] });
        assert.deepStrictEqual(r.unmetRequirements, ["유효 항목"]);
    });

    it("overall_success가 boolean이면 outcome과 무관하게 그대로 사용된다", () => {
        assert.strictEqual(normalizeTaskEffectiveness({ overall_success: false, outcome: "completed" }).overallSuccess, false);
        assert.strictEqual(normalizeTaskEffectiveness({ overall_success: true,  outcome: "blocked"   }).overallSuccess, true);
    });

    it("overall_success 미지정 시 outcome==='completed'만 true", () => {
        assert.strictEqual(normalizeTaskEffectiveness({ outcome: "completed" }).overallSuccess, true);
        assert.strictEqual(normalizeTaskEffectiveness({ outcome: "partial"   }).overallSuccess, false);
    });

    it("둘 다 없으면 false (기존 || false 동작 보존)", () => {
        assert.strictEqual(normalizeTaskEffectiveness({ tool_highlights: ["recall"] }).overallSuccess, false);
    });
});

describe("_saveTaskFeedback INSERT", () => {
    it("8개 파라미터를 정규화된 값으로 전달한다", async () => {
        capturedQueries.length = 0;

        const processor = Object.create(ReflectProcessor.prototype);
        await processor._saveTaskFeedback("session-abc", {
            outcome           : "partial",
            evaluator         : "human",
            evidence          : "  테스트 3건 실패  ",
            unmet_requirements: ["페일오버 검증 미완료"],
            tool_highlights   : ["recall"],
            tool_pain_points  : ["db_query"],
        });

        assert.strictEqual(capturedQueries.length, 1);
        const { sql, params } = capturedQueries[0];

        assert.ok(sql.includes("outcome"));
        assert.ok(sql.includes("evaluator"));
        assert.ok(sql.includes("evidence"));
        assert.ok(sql.includes("unmet_requirements"));
        assert.ok(sql.includes("$8"));

        assert.strictEqual(params.length, 8);
        assert.deepStrictEqual(params, [
            "session-abc",
            false,
            ["recall"],
            ["db_query"],
            "partial",
            "human",
            "테스트 3건 실패",
            ["페일오버 검증 미완료"],
        ]);
    });

    it("outcome 미보고 시 outcome/evaluator/evidence는 NULL로 전달된다", async () => {
        capturedQueries.length = 0;

        const processor = Object.create(ReflectProcessor.prototype);
        await processor._saveTaskFeedback("session-def", { overall_success: true });

        const { params } = capturedQueries[0];
        assert.strictEqual(params[1], true);
        assert.strictEqual(params[4], null);
        assert.strictEqual(params[5], null);
        assert.strictEqual(params[6], null);
        assert.deepStrictEqual(params[7], []);
    });
});
