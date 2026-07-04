/**
 * FragmentFactory.validateContent 품질 게이트 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-28
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { FragmentFactory } from "../../lib/memory/write/FragmentFactory.js";

describe("FragmentFactory.validateContent", () => {

    test("초단문 거부: 길이 < 10 AND 단어 < 3", () => {
        const result = FragmentFactory.validateContent("ok", "fact", "general");
        assert.strictEqual(result.valid, false);
        assert.match(result.reason, /too short/i);
    });

    test("URL 전용 거부: 컨텍스트 없는 링크", () => {
        const result = FragmentFactory.validateContent(
            "https://example.com/some/path",
            "fact",
            "general"
        );
        assert.strictEqual(result.valid, false);
        assert.match(result.reason, /URL-only/i);
    });

    test("미분류 거부: type과 topic 모두 null", () => {
        const result = FragmentFactory.validateContent(
            "충분히 긴 내용의 파편 텍스트입니다",
            null,
            null
        );
        assert.strictEqual(result.valid, false);
        assert.match(result.reason, /type and topic are null/i);
    });

    test("유효한 파편 통과", () => {
        const result = FragmentFactory.validateContent(
            "Redis 포트를 6379에서 16379로 변경",
            "fact",
            "infra"
        );
        assert.deepStrictEqual(result, { valid: true });
    });
});

describe("FragmentFactory.create 품질 게이트 통합", () => {

    test("초단문 파편 create 시 Error throw", () => {
        const factory = new FragmentFactory();
        assert.throws(
            () => factory.create({ content: "ok", type: "fact", topic: "test" }),
            { message: /too short/i }
        );
    });

    test("유효한 파편 create 정상 생성", () => {
        const factory  = new FragmentFactory();
        const fragment = factory.create({
            content: "PostgreSQL 연결 풀 크기를 20으로 설정",
            type   : "fact",
            topic  : "database"
        });
        assert.ok(fragment.id.startsWith("frag-"));
        assert.ok(fragment.content.length > 0);
    });
});
