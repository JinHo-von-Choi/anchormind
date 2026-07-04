/**
 * search-metrics.test.js (node:test 이주)
 * SearchMetrics 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-11
 * 수정일: 2026-04-19 (Jest → node:test 이주)
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { SearchMetrics } from "../../lib/memory/signals/SearchMetrics.js";

describe("SearchMetrics", () => {
    describe("computePercentiles", () => {
        const metrics = new SearchMetrics(null);

        it("샘플이 없으면 null percentiles를 반환한다", () => {
            const stats = metrics.computePercentiles([]);
            assert.strictEqual(stats.p50, null);
            assert.strictEqual(stats.p90, null);
            assert.strictEqual(stats.p99, null);
            assert.strictEqual(stats.count, 0);
        });

        it("단일 샘플이면 모든 percentile이 같다", () => {
            const stats = metrics.computePercentiles([42]);
            assert.strictEqual(stats.p50, 42);
            assert.strictEqual(stats.p90, 42);
            assert.strictEqual(stats.p99, 42);
        });

        it("100개 배열에서 P90은 index 90(값 91)이다", () => {
            const samples = Array.from({ length: 100 }, (_, i) => i + 1);
            const stats   = metrics.computePercentiles(samples);
            assert.strictEqual(stats.p90, 91);
        });

        it("count는 입력 배열 길이를 반환한다", () => {
            const stats = metrics.computePercentiles([1, 2, 3]);
            assert.strictEqual(stats.count, 3);
        });
    });

    describe("record (in-memory fallback)", () => {
        it("record 후 getStats에 샘플이 반영된다", async () => {
            const m = new SearchMetrics(null);
            await m.record("L1", 50);
            await m.record("L1", 100);
            const stats = await m.getStats();
            assert.strictEqual(stats.L1.count, 2);
            assert.ok(stats.L1.p50 > 0, `expected p50 > 0, got ${stats.L1.p50}`);
        });

        it("SAMPLE_LIMIT(100) 초과 시 오래된 샘플을 버린다", async () => {
            const m = new SearchMetrics(null);
            for (let i = 0; i < 110; i++) await m.record("L2", i);
            const stats = await m.getStats();
            assert.strictEqual(stats.L2.count, 100);
        });
    });
});
