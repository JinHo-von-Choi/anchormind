/**
 * decay-ema.test.js (node:test 이주)
 * EMA activation / computeDynamicHalfLife 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-11
 * 수정일: 2026-04-19 (Jest → node:test 이주, 파일명 decay-ema.test.js로 분리)
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
    updateEmaActivation,
    computeEmaRankBoost,
    computeDynamicHalfLife,
    HALF_LIFE_DAYS
} from "../../lib/memory/consolidate/decay.js";

describe("EMA activation", () => {
    it("초기 접근 시 양수 활성화 값을 반환한다", () => {
        const now    = new Date();
        const result = updateEmaActivation(null, null, now);
        assert.ok(result > 0, `expected > 0, got ${result}`);
    });

    it("최근 접근은 원거리 접근보다 높은 활성화를 준다", () => {
        const now          = new Date();
        const recentAccess = updateEmaActivation(0, new Date(now.getTime() - 1000),           now);
        const oldAccess    = updateEmaActivation(0, new Date(now.getTime() - 86400_000 * 30),  now);
        assert.ok(recentAccess > oldAccess, `expected ${recentAccess} > ${oldAccess}`);
    });

    it("deltaMs=0 이어도 NaN/Infinity 없음", () => {
        const now    = new Date();
        const result = updateEmaActivation(0.5, now, now);
        assert.ok(Number.isFinite(result), `expected finite, got ${result}`);
    });

    it("computeEmaRankBoost는 [0, 0.3] 범위를 벗어나지 않는다", () => {
        const boost = computeEmaRankBoost(999);
        assert.ok(boost >= 0,   `expected >= 0, got ${boost}`);
        assert.ok(boost <= 0.3, `expected <= 0.3, got ${boost}`);
    });
});

describe("computeDynamicHalfLife", () => {
    it("ema=0이면 base half-life와 같다", () => {
        const result = computeDynamicHalfLife("fact", 0);
        assert.ok(Math.abs(result - HALF_LIFE_DAYS.fact) < 0.5, `expected ~${HALF_LIFE_DAYS.fact}, got ${result}`);
    });

    it("ema가 높을수록 반감기가 길어진다", () => {
        const low  = computeDynamicHalfLife("fact", 0.1);
        const high = computeDynamicHalfLife("fact", 2.0);
        assert.ok(high > low, `expected high(${high}) > low(${low})`);
    });

    it("최대 2배를 초과하지 않는다", () => {
        const result = computeDynamicHalfLife("fact", 999);
        assert.ok(result <= HALF_LIFE_DAYS.fact * 2, `expected <= ${HALF_LIFE_DAYS.fact * 2}, got ${result}`);
    });

    it("ema=null/undefined 방어", () => {
        assert.doesNotThrow(() => computeDynamicHalfLife("fact", null));
        const result = computeDynamicHalfLife("fact", undefined);
        assert.ok(result > 0, `expected > 0, got ${result}`);
    });
});
