/**
 * search-event-recorder.test.js (node:test 이주)
 * SearchEventRecorder 단위 테스트
 *
 * 순수 함수(classifyQueryType, extractFilterKeys, buildSearchEvent)만 검증.
 * recordSearchEvent(DB 연결 필요)는 테스트하지 않는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-03-25
 * 수정일: 2026-04-19 (Jest → node:test 이주)
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
    classifyQueryType,
    extractFilterKeys,
    buildSearchEvent
} from "../../lib/memory/signals/SearchEventRecorder.js";

describe("classifyQueryType", () => {
    it("빈 객체는 keywords를 반환한다", () => {
        assert.strictEqual(classifyQueryType({}), "keywords");
    });

    it("null/undefined 입력은 keywords를 반환한다", () => {
        assert.strictEqual(classifyQueryType(null), "keywords");
        assert.strictEqual(classifyQueryType(undefined), "keywords");
    });

    it("text만 있으면 text를 반환한다", () => {
        assert.strictEqual(classifyQueryType({ text: "hello" }), "text");
    });

    it("keywords만 있으면 keywords를 반환한다", () => {
        assert.strictEqual(classifyQueryType({ keywords: ["foo", "bar"] }), "keywords");
    });

    it("topic만 있으면 topic을 반환한다", () => {
        assert.strictEqual(classifyQueryType({ topic: "architecture" }), "topic");
    });

    it("text + keywords는 mixed를 반환한다", () => {
        assert.strictEqual(classifyQueryType({ text: "hello", keywords: ["a"] }), "mixed");
    });

    it("text + topic은 mixed를 반환한다", () => {
        assert.strictEqual(classifyQueryType({ text: "hello", topic: "arch" }), "mixed");
    });

    it("keywords + topic은 mixed를 반환한다", () => {
        assert.strictEqual(classifyQueryType({ keywords: ["a"], topic: "arch" }), "mixed");
    });

    it("세 필드 모두 있으면 mixed를 반환한다", () => {
        assert.strictEqual(classifyQueryType({ text: "t", keywords: ["k"], topic: "tp" }), "mixed");
    });

    it("빈 문자열 text는 없는 것으로 처리된다", () => {
        assert.strictEqual(classifyQueryType({ text: "" }), "keywords");
    });

    it("빈 배열 keywords는 없는 것으로 처리된다", () => {
        assert.strictEqual(classifyQueryType({ keywords: [] }), "keywords");
    });
});

describe("extractFilterKeys", () => {
    it("빈 객체는 빈 배열을 반환한다", () => {
        assert.deepStrictEqual(extractFilterKeys({}), []);
    });

    it("null/undefined 입력은 빈 배열을 반환한다", () => {
        assert.deepStrictEqual(extractFilterKeys(null), []);
        assert.deepStrictEqual(extractFilterKeys(undefined), []);
    });

    it("topic이 있으면 'topic'을 포함한다", () => {
        assert.ok(extractFilterKeys({ topic: "arch" }).includes("topic"));
    });

    it("type이 있으면 'type'을 포함한다", () => {
        assert.ok(extractFilterKeys({ type: "fact" }).includes("type"));
    });

    it("isAnchor가 있으면 'is_anchor'를 포함한다", () => {
        assert.ok(extractFilterKeys({ isAnchor: true  }).includes("is_anchor"));
        assert.ok(extractFilterKeys({ isAnchor: false }).includes("is_anchor"));
    });

    it("includeSuperseded가 있으면 'includeSuperseded'를 포함한다", () => {
        assert.ok(extractFilterKeys({ includeSuperseded: true }).includes("includeSuperseded"));
    });

    it("minImportance가 있으면 'minImportance'를 포함한다", () => {
        assert.ok(extractFilterKeys({ minImportance: 0.5 }).includes("minImportance"));
    });

    it("keyId가 있으면 'key_id'를 포함한다", () => {
        assert.ok(extractFilterKeys({ keyId: 42 }).includes("key_id"));
    });

    it("keyId가 null이면 'key_id'를 포함하지 않는다", () => {
        assert.ok(!extractFilterKeys({ keyId: null }).includes("key_id"));
    });

    it("여러 필드가 있으면 모두 포함한다", () => {
        const keys = extractFilterKeys({ topic: "x", type: "fact", isAnchor: true, keyId: 1 });
        assert.ok(keys.includes("topic"));
        assert.ok(keys.includes("type"));
        assert.ok(keys.includes("is_anchor"));
        assert.ok(keys.includes("key_id"));
    });

    it("undefined 필드는 포함하지 않는다", () => {
        assert.ok(!extractFilterKeys({ topic: undefined }).includes("topic"));
    });
});

describe("buildSearchEvent", () => {
    it("searchPath에서 L1/L2/L3 카운트를 파싱한다", () => {
        const event = buildSearchEvent(
            { keywords: ["a"] },
            [{ id: 1 }, { id: 2 }],
            { searchPath: "L1:5 → HotCache:3 → L2:10 → L3:8 → RRF" }
        );
        assert.strictEqual(event.l1_count, 5);
        assert.strictEqual(event.l2_count, 10);
        assert.strictEqual(event.l3_count, 8);
    });

    it("RRF 포함 경로에서 used_rrf가 true이다", () => {
        const event = buildSearchEvent({}, [], { searchPath: "L1:3 → L2:7 → RRF" });
        assert.strictEqual(event.used_rrf, true);
    });

    it("RRF 미포함 경로에서 used_rrf가 false이다", () => {
        const event = buildSearchEvent({}, [], { searchPath: "L1:3 → HotCache:2" });
        assert.strictEqual(event.used_rrf, false);
    });

    it("searchPath 없으면 모든 카운트가 0이다", () => {
        const event = buildSearchEvent({}, [], {});
        assert.strictEqual(event.l1_count, 0);
        assert.strictEqual(event.l2_count, 0);
        assert.strictEqual(event.l3_count, 0);
        assert.strictEqual(event.used_rrf, false);
    });

    it("result 배열 길이가 result_count에 반영된다", () => {
        const event = buildSearchEvent({}, [{ id: 1 }, { id: 2 }, { id: 3 }], {});
        assert.strictEqual(event.result_count, 3);
    });

    it("빈 result는 result_count가 0이다", () => {
        const event = buildSearchEvent({}, [], {});
        assert.strictEqual(event.result_count, 0);
    });

    it("meta.sessionId, keyId, latencyMs, l1IsFallback이 올바르게 매핑된다", () => {
        const event = buildSearchEvent(
            {},
            [],
            { sessionId: "sess-1", keyId: 7, latencyMs: 42, l1IsFallback: true }
        );
        assert.strictEqual(event.session_id, "sess-1");
        assert.strictEqual(event.key_id, 7);
        assert.strictEqual(event.latency_ms, 42);
        assert.strictEqual(event.l1_is_fallback, true);
    });

    it("meta가 없으면 선택 필드들이 null/false 기본값을 갖는다", () => {
        const event = buildSearchEvent({}, []);
        assert.strictEqual(event.session_id, null);
        assert.strictEqual(event.key_id, null);
        assert.strictEqual(event.latency_ms, null);
        assert.strictEqual(event.l1_is_fallback, false);
    });

    it("query_type과 filter_keys가 순수 함수 결과와 일치한다", () => {
        const query = { text: "hello", topic: "arch", isAnchor: true };
        const event = buildSearchEvent(query, [], {});
        assert.strictEqual(event.query_type, "mixed");
        assert.ok(event.filter_keys.includes("topic"));
        assert.ok(event.filter_keys.includes("is_anchor"));
    });

    it("L1 전용 폴백 경로도 올바르게 파싱된다", () => {
        const event = buildSearchEvent(
            { keywords: ["k"] },
            [{ id: 1 }],
            { searchPath: "L1:15 (fallback)", l1IsFallback: true }
        );
        assert.strictEqual(event.l1_count, 15);
        assert.strictEqual(event.l2_count, 0);
        assert.strictEqual(event.l3_count, 0);
        assert.strictEqual(event.l1_is_fallback, true);
    });
});
