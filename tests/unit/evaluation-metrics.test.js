/**
 * evaluation-metrics.test.js (node:test 이주)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-19 (Jest → node:test 이주)
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { computePrecisionAt } from "../../lib/memory/signals/EvaluationMetrics.js";

describe("computePrecisionAt", () => {
    it("relevant 3개 / 전체 5개 = 0.6", () => {
        const result = computePrecisionAt([
            { relevant: true  },
            { relevant: false },
            { relevant: true  },
            { relevant: false },
            { relevant: true  }
        ], 5);
        assert.ok(Math.abs(result - 0.6) < 0.005, `expected ~0.6, got ${result}`);
    });

    it("전체가 k보다 적으면 실제 수로 나눈다", () => {
        const result = computePrecisionAt([
            { relevant: true },
            { relevant: true }
        ], 5);
        assert.ok(Math.abs(result - 1.0) < 0.005, `expected ~1.0, got ${result}`);
    });

    it("빈 배열이면 null 반환", () => {
        assert.strictEqual(computePrecisionAt([], 5), null);
    });

    it("relevant 0개면 0.0", () => {
        const result = computePrecisionAt([
            { relevant: false },
            { relevant: false }
        ], 5);
        assert.strictEqual(result, 0.0);
    });
});
