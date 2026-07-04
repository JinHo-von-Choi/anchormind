/**
 * search-event-analyzer.test.js (node:test 이주)
 * SearchEventAnalyzer 단위 테스트
 *
 * 순수 함수(computeL1MissRate, computeFilterDistribution)만 검증.
 * getSearchObservability는 DB 연결이 필요하므로 제외.
 *
 * 작성자: 최진호
 * 작성일: 2026-03-25
 * 수정일: 2026-04-19 (Jest → node:test 이주)
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { computeL1MissRate, computeFilterDistribution } from "../../lib/memory/signals/SearchEventAnalyzer.js";

describe("computeL1MissRate", () => {
    it("빈 배열이면 null을 반환한다", () => {
        assert.strictEqual(computeL1MissRate([]), null);
    });

    it("null/undefined 입력이면 null을 반환한다", () => {
        assert.strictEqual(computeL1MissRate(null), null);
        assert.strictEqual(computeL1MissRate(undefined), null);
    });

    it("모든 행이 fallback이면 1을 반환한다", () => {
        const rows = [
            { l1_is_fallback: true },
            { l1_is_fallback: true },
            { l1_is_fallback: true }
        ];
        assert.strictEqual(computeL1MissRate(rows), 1.0);
    });

    it("모든 행이 fallback 아니면 0을 반환한다", () => {
        const rows = [
            { l1_is_fallback: false },
            { l1_is_fallback: false }
        ];
        assert.strictEqual(computeL1MissRate(rows), 0);
    });

    it("혼합 케이스: 2/4 fallback → 0.5 반환", () => {
        const rows = [
            { l1_is_fallback: true  },
            { l1_is_fallback: false },
            { l1_is_fallback: true  },
            { l1_is_fallback: false }
        ];
        assert.strictEqual(computeL1MissRate(rows), 0.5);
    });

    it("반환값이 4자리 소수점 이하로 정규화된다", () => {
        const rows = [
            { l1_is_fallback: true  },
            { l1_is_fallback: false },
            { l1_is_fallback: false }
        ];
        const rate = computeL1MissRate(rows);
        assert.strictEqual(rate, parseFloat((1 / 3).toFixed(4)));
    });

    it("l1_is_fallback이 true가 아닌 값(falsy)은 miss로 카운트하지 않는다", () => {
        const rows = [
            { l1_is_fallback: 1     },
            { l1_is_fallback: null  },
            { l1_is_fallback: false }
        ];
        assert.strictEqual(computeL1MissRate(rows), 0);
    });
});

describe("computeFilterDistribution", () => {
    it("빈 배열이면 빈 객체를 반환한다", () => {
        assert.deepStrictEqual(computeFilterDistribution([]), {});
    });

    it("null/undefined 입력이면 빈 객체를 반환한다", () => {
        assert.deepStrictEqual(computeFilterDistribution(null), {});
        assert.deepStrictEqual(computeFilterDistribution(undefined), {});
    });

    it("filter_keys가 null인 행은 무시한다", () => {
        const rows = [
            { filter_keys: null },
            { filter_keys: null }
        ];
        assert.deepStrictEqual(computeFilterDistribution(rows), {});
    });

    it("filter_keys가 빈 배열인 행은 무시한다", () => {
        const rows = [
            { filter_keys: [] },
            { filter_keys: [] }
        ];
        assert.deepStrictEqual(computeFilterDistribution(rows), {});
    });

    it("단일 키가 여러 행에 걸쳐 집계된다", () => {
        const rows = [
            { filter_keys: ["type"] },
            { filter_keys: ["type"] },
            { filter_keys: ["type"] }
        ];
        assert.deepStrictEqual(computeFilterDistribution(rows), { type: 3 });
    });

    it("여러 키가 각각 올바르게 집계된다", () => {
        const rows = [
            { filter_keys: ["type", "importance"] },
            { filter_keys: ["type"]               },
            { filter_keys: ["importance", "topic"] }
        ];
        const dist = computeFilterDistribution(rows);
        assert.strictEqual(dist.type, 2);
        assert.strictEqual(dist.importance, 2);
        assert.strictEqual(dist.topic, 1);
    });

    it("filter_keys 프로퍼티가 없는 행은 무시한다", () => {
        const rows = [
            { filter_keys: ["type"] },
            {                       },
            { filter_keys: ["type"] }
        ];
        assert.deepStrictEqual(computeFilterDistribution(rows), { type: 2 });
    });

    it("빈 문자열 키는 집계에서 제외된다", () => {
        const rows = [
            { filter_keys: ["", "type", ""] }
        ];
        assert.deepStrictEqual(computeFilterDistribution(rows), { type: 1 });
    });
});
