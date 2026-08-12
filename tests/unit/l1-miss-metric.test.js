/**
 * l1-miss-metric.test.js (node:test 이주)
 * L1 miss 메트릭 분류 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-31
 * 수정일: 2026-08-12 (명시 조건 miss 시 폴백 금지 계약 반영)
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { FragmentSearch } from "../../lib/memory/read/FragmentSearch.js";

/**
 * FragmentSearch._searchL1()의 isFallback 결과만 추출한다.
 * Redis/DB 의존성을 모킹하여 순수하게 폴백 분류 로직만 테스트한다.
 */
async function getL1FallbackFlag(query, redisHasResults = false) {
    const search = new FragmentSearch();

    search.index.searchByKeywords = async () => redisHasResults ? ["frag-1"] : [];
    search.index.searchByTopic    = async () => redisHasResults ? ["frag-1"] : [];
    search.index.searchByType     = async () => redisHasResults ? ["frag-1"] : [];
    search.index.getRecent        = async () => ["frag-recent-1", "frag-recent-2"];

    const result = await search._searchL1(query, null);
    return result.isFallback;
}

describe("L1 miss 메트릭 — text-only 쿼리", () => {
    it("text만 있는 쿼리는 isFallback: false여야 한다", async () => {
        const isFallback = await getL1FallbackFlag({ text: "어제 한 결정이 뭐였지?" });
        assert.strictEqual(isFallback, false);
    });

    it("text + tokenBudget 조합도 isFallback: false여야 한다", async () => {
        const isFallback = await getL1FallbackFlag({ text: "배포 절차", tokenBudget: 2000 });
        assert.strictEqual(isFallback, false);
    });

    it("text-only 쿼리는 빈 ids를 반환해야 한다 (L2/L3에 위임)", async () => {
        const search = new FragmentSearch();
        search.index.searchByKeywords = async () => [];
        search.index.searchByTopic    = async () => [];
        search.index.searchByType     = async () => [];
        search.index.getRecent        = async () => ["frag-recent"];

        const result = await search._searchL1({ text: "어제 한 결정" }, null);
        assert.strictEqual(result.ids.length, 0);
        assert.strictEqual(result.isFallback, false);
    });
});

describe("L1 miss 메트릭 — keywords 쿼리", () => {
    it("keywords가 있지만 Redis 결과가 없으면 폴백 없이 isFallback: false여야 한다", async () => {
        /** 명시 조건이 있는 쿼리는 L1이 getRecent로 후보를 지어내지 않는다.
         *  L2/L3 SQL 검색이 담당하며, 폴백 메트릭은 조건 전무 조회 전용이다. */
        const isFallback = await getL1FallbackFlag({ keywords: ["배포", "절차"] }, false);
        assert.strictEqual(isFallback, false);
    });

    it("keywords가 있고 Redis 결과가 있으면 isFallback: false여야 한다", async () => {
        const isFallback = await getL1FallbackFlag({ keywords: ["배포", "절차"] }, true);
        assert.strictEqual(isFallback, false);
    });

    it("topic만 있지만 Redis 결과가 없으면 공집합·isFallback: false여야 한다", async () => {
        /** topic은 정확일치 하드 필터라 0건이면 교집합이 공집합이다. */
        const isFallback = await getL1FallbackFlag({ topic: "architecture" }, false);
        assert.strictEqual(isFallback, false);
    });

    it("type만 있지만 Redis 결과가 없으면 공집합·isFallback: false여야 한다", async () => {
        const isFallback = await getL1FallbackFlag({ type: "decision" }, false);
        assert.strictEqual(isFallback, false);
    });
});

describe("L1 miss 메트릭 — 경계 케이스", () => {
    it("text + keywords 복합 쿼리에서 Redis hit이면 isFallback: false이다", async () => {
        const isFallback = await getL1FallbackFlag({ text: "배포 절차", keywords: ["배포"] }, true);
        assert.strictEqual(isFallback, false);
    });

    it("text + keywords 복합 쿼리에서 Redis miss여도 폴백하지 않는다", async () => {
        const isFallback = await getL1FallbackFlag({ text: "배포 절차", keywords: ["배포"] }, false);
        assert.strictEqual(isFallback, false);
    });

    it("빈 keywords 배열은 text-only와 동일하게 처리한다", async () => {
        const isFallback = await getL1FallbackFlag({ text: "배포 절차", keywords: [] }, false);
        assert.strictEqual(isFallback, false);
    });
});
