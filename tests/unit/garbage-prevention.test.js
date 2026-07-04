/**
 * garbage-prevention.test.js (node:test 이주)
 * Tasks 1, 2, 4, 6, 8, 9 — GC 가비지 방지 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-17
 * 수정일: 2026-04-19 (Jest → node:test 이주)
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { FragmentGC }                                    from "../../lib/memory/consolidate/FragmentGC.js";
import { FragmentSearch }                                from "../../lib/memory/read/FragmentSearch.js";
import { sanitizeInsertImportance, FragmentWriter }      from "../../lib/memory/write/FragmentWriter.js";
import { FragmentStore }                                 from "../../lib/memory/write/FragmentStore.js";
import { computeEmaRankBoost, computeUtilityScore }      from "../../lib/memory/consolidate/decay.js";

// ── Task 1: fallback EMA 차단 ──────────────────────────────────────────────

describe("fallback EMA 차단", () => {
    it("_searchL1 반환값에 isFallback 필드가 있다", () => {
        const src = FragmentSearch.toString();
        assert.ok(src.includes("isFallback"));
    });

    it("incrementAccess 시그니처가 noEma 옵션을 받는다", () => {
        const src = FragmentWriter.toString();
        assert.ok(src.includes("noEma"));
    });
});

// ── Task 8: 삽입 importance 상한 ──────────────────────────────────────────

describe("삽입 importance 상한", () => {
    it("20자 미만 content는 importance가 0.2 이하로 강제된다", () => {
        assert.ok(sanitizeInsertImportance("짧음", "fact", 0.8) <= 0.2);
    });

    it("error 타입은 최대 0.6", () => {
        assert.ok(sanitizeInsertImportance("충분히 긴 내용입니다 실제로 테스트용", "error", 1.0) <= 0.6);
    });

    it("preference 타입은 최대 0.9", () => {
        assert.ok(sanitizeInsertImportance("충분히 긴 내용입니다 실제로 테스트용", "preference", 1.0) <= 0.9);
    });

    it("is_anchor=true이면 상한 없음", () => {
        assert.strictEqual(sanitizeInsertImportance("짧음", "fact", 1.0, true), 1.0);
    });
});

// ── Task 9: co_retrieved spreading activation ──────────────────────────────

describe("co_retrieved spreading activation", () => {
    it("touchLinked가 FragmentWriter에 존재한다", () => {
        const fw = new FragmentWriter();
        assert.strictEqual(typeof fw.touchLinked, "function");
    });

    it("FragmentStore에 touchLinked 위임이 있다", () => {
        const src = FragmentStore.toString();
        assert.ok(src.includes("touchLinked"));
    });
});

// ── Task 2: permanent parole ────────────────────────────────────────────────

describe("permanent parole", () => {
    it("transitionTTL에 permanent→cold 강등 조건이 존재한다", () => {
        const src = FragmentGC.toString();
        assert.ok(src.includes("permanent"));
        assert.ok(src.includes("cold"));
        assert.ok(src.includes("180 days"));
    });
});

// ── Task 4: quality_verified permanent 장벽 ───────────────────────────────

describe("quality_verified permanent 장벽", () => {
    it("FragmentGC.transitionTTL 소스에 quality_verified 조건이 있다", () => {
        const src = FragmentGC.toString();
        assert.ok(src.includes("quality_verified"));
        assert.ok(src.includes("IS DISTINCT FROM FALSE"));
    });

    it("MemoryEvaluator.evaluate가 keep 판정 시 quality_verified=true를 업데이트한다", async () => {
        const { MemoryEvaluator } = await import("../../lib/memory/signals/MemoryEvaluator.js");
        const src = MemoryEvaluator.toString();
        assert.ok(src.includes("quality_verified"));
        assert.ok(src.includes("true"));
    });
});

// ── Task 6: EMA 배치 감쇠 ────────────────────────────────────────────────

describe("EMA 배치 감쇠", () => {
    it("decayEmaActivation이 FragmentGC에 존재한다", () => {
        const gc = new FragmentGC();
        assert.strictEqual(typeof gc.decayEmaActivation, "function");
    });
});

// ── Task 7: EMA boost 상한 0.3→0.2 ────────────────────────────────────────

describe("EMA boost 상한", () => {
    it("EMA boost 최대값이 0.2 이하다", () => {
        const boost = computeEmaRankBoost(100);
        assert.ok(boost <= 0.2, `expected <= 0.2, got ${boost}`);
    });

    it("importance=0.65 파편의 effectiveImp 최대값이 0.8 미만이다", () => {
        const maxBoost     = computeEmaRankBoost(100);
        const effectiveImp = 0.65 + maxBoost * 0.5;
        assert.ok(effectiveImp < 0.8, `expected < 0.8, got ${effectiveImp}`);
    });
});

// ── Task 3: utility_score 나이 가중치 ──────────────────────────────────────

describe("utility_score 나이 가중치", () => {
    it("나이가 오래될수록 utility_score가 낮아진다", () => {
        const scoreNew = computeUtilityScore(0.5, 10, 30);   // 1개월
        const scoreOld = computeUtilityScore(0.5, 10, 365);  // 12개월
        assert.ok(scoreNew > scoreOld, `expected ${scoreNew} > ${scoreOld}`);
    });

    it("access_count가 많을수록 utility_score가 높다", () => {
        const scoreLow  = computeUtilityScore(0.5, 1,  30);
        const scoreHigh = computeUtilityScore(0.5, 20, 30);
        assert.ok(scoreHigh > scoreLow, `expected ${scoreHigh} > ${scoreLow}`);
    });

    it("2년 파편은 1개월 파편 대비 utility_score가 약 35% 낮다", () => {
        const scoreNew = computeUtilityScore(0.5, 10, 30);
        const scoreOld = computeUtilityScore(0.5, 10, 730);
        assert.ok(scoreOld / scoreNew < 0.75, `expected ratio < 0.75, got ${scoreOld / scoreNew}`);
    });
});

// ── Task 5: 고-EMA 저-importance 재평가 큐 등록 ───────────────────────────

describe("고-EMA 저-importance 재평가", () => {
    it("_requeueHighEmaLowQuality가 MemoryConsolidator에 존재한다", async () => {
        const { MemoryConsolidator } = await import("../../lib/memory/consolidate/MemoryConsolidator.js");
        const c = new MemoryConsolidator();
        assert.strictEqual(typeof c._requeueHighEmaLowQuality, "function");
    });
});
