/**
 * ContradictionDetector 재귀 깊이 제한 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-28
 */

import { test, describe }      from "node:test";
import assert                   from "node:assert/strict";
import { ContradictionDetector, MAX_CONTRADICTION_DEPTH } from "../../lib/memory/link/ContradictionDetector.js";

/** store 스텁 — 테스트에서 사용하지 않는 메서드는 빈 객체 */
const stubStore = {};

describe("ContradictionDetector._acquirePairCheck (재귀 깊이 제한)", () => {
    test("MAX_CONTRADICTION_DEPTH 상수는 3", () => {
        assert.strictEqual(MAX_CONTRADICTION_DEPTH, 3);
    });

    test("동일 쌍을 MAX_CONTRADICTION_DEPTH(3)회까지 허용", () => {
        const detector = new ContradictionDetector(stubStore);

        assert.strictEqual(detector._acquirePairCheck("aaa", "bbb"), true,  "1회차 허용");
        assert.strictEqual(detector._acquirePairCheck("aaa", "bbb"), true,  "2회차 허용");
        assert.strictEqual(detector._acquirePairCheck("aaa", "bbb"), true,  "3회차 허용");
    });

    test("4회차부터 스킵 (false 반환)", () => {
        const detector = new ContradictionDetector(stubStore);

        for (let i = 0; i < MAX_CONTRADICTION_DEPTH; i++) {
            detector._acquirePairCheck("aaa", "bbb");
        }

        assert.strictEqual(detector._acquirePairCheck("aaa", "bbb"), false, "4회차 거부");
        assert.strictEqual(detector._acquirePairCheck("aaa", "bbb"), false, "5회차도 거부");
    });

    test("ID 순서가 바뀌어도 동일 쌍으로 인식", () => {
        const detector = new ContradictionDetector(stubStore);

        detector._acquirePairCheck("zzz", "aaa");  // 내부적으로 aaa_zzz
        detector._acquirePairCheck("aaa", "zzz");  // 동일 쌍
        detector._acquirePairCheck("zzz", "aaa");  // 3회

        assert.strictEqual(detector._acquirePairCheck("aaa", "zzz"), false, "순서 무관 4회차 거부");
    });

    test("서로 다른 쌍은 독립적으로 카운트", () => {
        const detector = new ContradictionDetector(stubStore);

        for (let i = 0; i < MAX_CONTRADICTION_DEPTH; i++) {
            detector._acquirePairCheck("aaa", "bbb");
        }
        assert.strictEqual(detector._acquirePairCheck("aaa", "bbb"), false, "aaa_bbb 소진");

        assert.strictEqual(detector._acquirePairCheck("aaa", "ccc"), true,  "aaa_ccc 첫 번째 허용");
        assert.strictEqual(detector._acquirePairCheck("bbb", "ccc"), true,  "bbb_ccc 첫 번째 허용");
    });

    test("resetCheckedPairs() 호출 후 카운트 초기화", () => {
        const detector = new ContradictionDetector(stubStore);

        for (let i = 0; i < MAX_CONTRADICTION_DEPTH; i++) {
            detector._acquirePairCheck("aaa", "bbb");
        }
        assert.strictEqual(detector._acquirePairCheck("aaa", "bbb"), false, "리셋 전 거부");

        detector.resetCheckedPairs();

        assert.strictEqual(detector._acquirePairCheck("aaa", "bbb"), true, "리셋 후 다시 허용");
    });

    test("resetCheckedPairs()는 모든 쌍을 초기화", () => {
        const detector = new ContradictionDetector(stubStore);

        for (let i = 0; i < MAX_CONTRADICTION_DEPTH; i++) {
            detector._acquirePairCheck("aaa", "bbb");
            detector._acquirePairCheck("ccc", "ddd");
        }

        detector.resetCheckedPairs();

        assert.strictEqual(detector._acquirePairCheck("aaa", "bbb"), true, "aaa_bbb 리셋됨");
        assert.strictEqual(detector._acquirePairCheck("ccc", "ddd"), true, "ccc_ddd 리셋됨");
    });
});
