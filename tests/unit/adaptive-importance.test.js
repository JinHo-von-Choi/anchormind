/**
 * computeAdaptiveImportance 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-28
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { computeAdaptiveImportance } from "../../lib/memory/consolidate/decay.js";

describe("computeAdaptiveImportance", () => {

    test("기본값: importance 미지정 시 0.5, 접근 이력 없으면 최소값(0.05)으로 수렴", () => {
        const result = computeAdaptiveImportance({});
        assert.strictEqual(result, 0.05);
    });

    test("방금 접근한 파편은 base importance에 가까움", () => {
        const result = computeAdaptiveImportance({
            importance   : 0.8,
            access_count : 0,
            accessed_at  : new Date().toISOString(),
            type         : "fact"
        });
        assert.ok(result >= 0.75 && result <= 0.85, `expected ~0.8, got ${result}`);
    });

    test("높은 access_count는 importance를 상향시킴", () => {
        const now = new Date().toISOString();
        const low  = computeAdaptiveImportance({
            importance   : 0.5,
            access_count : 1,
            accessed_at  : now,
            type         : "fact"
        });
        const high = computeAdaptiveImportance({
            importance   : 0.5,
            access_count : 100,
            accessed_at  : now,
            type         : "fact"
        });
        assert.ok(high > low, `high(${high}) should be > low(${low})`);
    });

    test("오래된 파편은 importance가 감소함", () => {
        const recent = computeAdaptiveImportance({
            importance   : 0.7,
            access_count : 5,
            accessed_at  : new Date().toISOString(),
            type         : "fact"
        });
        const daysAgo = new Date(Date.now() - 120 * 86_400_000).toISOString();
        const old = computeAdaptiveImportance({
            importance   : 0.7,
            access_count : 5,
            accessed_at  : daysAgo,
            type         : "fact"
        });
        assert.ok(recent > old, `recent(${recent}) should be > old(${old})`);
    });

    test("타입별 반감기가 적용됨 (procedure=30d vs preference=120d)", () => {
        const halfLifeAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
        const proc = computeAdaptiveImportance({
            importance   : 0.8,
            access_count : 0,
            accessed_at  : halfLifeAgo,
            type         : "procedure"
        });
        const pref = computeAdaptiveImportance({
            importance   : 0.8,
            access_count : 0,
            accessed_at  : halfLifeAgo,
            type         : "preference"
        });
        /** procedure 반감기 30일 → 30일 후 ~0.4, preference 반감기 120일 → 30일 후 ~0.67 */
        assert.ok(pref > proc, `preference(${pref}) should decay less than procedure(${proc})`);
    });

    test("반감기 정확성: fact 타입, 60일 후 importance 절반", () => {
        const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000).toISOString();
        const result = computeAdaptiveImportance({
            importance   : 0.8,
            access_count : 0,
            accessed_at  : sixtyDaysAgo,
            type         : "fact"
        });
        /** access_count=0 → accessBoost = 1 + 0.1*ln(1) = 1.0, recency = 0.5 */
        assert.ok(Math.abs(result - 0.4) < 0.02, `expected ~0.4, got ${result}`);
    });

    test("최소값 0.05 이하로 내려가지 않음", () => {
        const result = computeAdaptiveImportance({
            importance   : 0.1,
            access_count : 0,
            accessed_at  : new Date(Date.now() - 3650 * 86_400_000).toISOString(),
            type         : "fact"
        });
        assert.ok(result >= 0.05, `result(${result}) should be >= 0.05`);
    });

    test("최대값 1.0 초과하지 않음", () => {
        const result = computeAdaptiveImportance({
            importance   : 1.0,
            access_count : 10000,
            accessed_at  : new Date().toISOString(),
            type         : "preference"
        });
        assert.ok(result <= 1.0, `result(${result}) should be <= 1.0`);
    });

    test("accessed_at 없으면 daysSinceAccess=9999로 최소값 수렴", () => {
        const result = computeAdaptiveImportance({
            importance   : 0.8,
            access_count : 10,
            type         : "decision"
        });
        assert.strictEqual(result, 0.05);
    });

    test("알 수 없는 type은 default 반감기(60일) 적용", () => {
        const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000).toISOString();
        const result = computeAdaptiveImportance({
            importance   : 0.8,
            access_count : 0,
            accessed_at  : sixtyDaysAgo,
            type         : "unknown_type_xyz"
        });
        assert.ok(Math.abs(result - 0.4) < 0.02, `expected ~0.4 (default hl), got ${result}`);
    });
});
