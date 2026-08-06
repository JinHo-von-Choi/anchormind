/**
 * FeedbackSampler 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-08-06
 *
 * 확률 판정, 힌트 형태, 세션당 상한·쿨다운, Redis 미가용 fail-open을 검증한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

const {
    shouldSample,
    buildFeedbackHint,
    maybeFeedbackHint,
} = await import("../../lib/memory/signals/FeedbackSampler.js");

const RATES = { remember: 0.10, amend: 0.25, forget: 0.25 };

/**
 * INCR/EXPIRE/SET NX EX만 지원하는 최소 Redis 스텁.
 * setResults가 주어지면 SET NX 응답을 순서대로 소비한다.
 */
function createRedisStub({ setResults = null } = {}) {
    const store = new Map();
    const calls = { set: [], incr: [], expire: [] };
    let   setIdx = 0;

    return {
        calls,
        store,
        async set(key, value, ...args) {
            calls.set.push({ key, value, args });
            if (setResults) return setResults[setIdx++] ?? null;
            if (args.includes("NX") && store.has(key)) return null;
            store.set(key, value);
            return "OK";
        },
        async incr(key) {
            calls.incr.push(key);
            const next = (store.get(key) ?? 0) + 1;
            store.set(key, next);
            return next;
        },
        async expire(key, ttl) {
            calls.expire.push({ key, ttl });
            return 1;
        },
    };
}

describe("shouldSample", () => {
    it("rng가 rate 미만이면 true", () => {
        assert.strictEqual(shouldSample("amend", { rates: RATES, rng: () => 0 }), true);
    });

    it("rng가 rate 이상이면 false", () => {
        assert.strictEqual(shouldSample("amend", { rates: RATES, rng: () => 0.99 }), false);
        assert.strictEqual(shouldSample("amend", { rates: RATES, rng: () => 0.25 }), false);
    });

    it("rates에 없는 도구는 rng와 무관하게 false", () => {
        assert.strictEqual(shouldSample("recall",  { rates: RATES, rng: () => 0 }), false);
        assert.strictEqual(shouldSample("unknown", { rates: RATES, rng: () => 0 }), false);
    });

    it("rates 미지정이면 false", () => {
        assert.strictEqual(shouldSample("remember", { rng: () => 0 }), false);
    });
});

describe("buildFeedbackHint", () => {
    it("tool_feedback 트리거와 sampled 인자를 담는다", () => {
        const hint = buildFeedbackHint("remember");
        assert.strictEqual(hint.signal,              "feedback_sampled");
        assert.strictEqual(hint.trigger,             "tool_feedback");
        assert.strictEqual(hint.args.tool_name,      "remember");
        assert.strictEqual(hint.args.trigger_type,   "sampled");
        assert.ok(hint.suggestion.includes("remember"));
        assert.ok(hint.suggestion.includes("tool_feedback"));
    });
});

describe("maybeFeedbackHint", () => {
    it("표집되지 않으면 null", async () => {
        const hint = await maybeFeedbackHint("remember", "s1", { rng: () => 0.99, redis: createRedisStub() });
        assert.strictEqual(hint, null);
    });

    it("rates 미등록 도구는 null", async () => {
        const hint = await maybeFeedbackHint("recall", "s1", { rng: () => 0, redis: createRedisStub() });
        assert.strictEqual(hint, null);
    });

    it("쿨다운 미획득 시 null", async () => {
        const redis = createRedisStub({ setResults: [null] });
        const hint  = await maybeFeedbackHint("amend", "s1", { rng: () => 0, redis });
        assert.strictEqual(hint, null);
        assert.strictEqual(redis.calls.incr.length, 0);
    });

    it("쿨다운 키는 SET NX EX로 설정된다", async () => {
        const redis = createRedisStub();
        await maybeFeedbackHint("amend", "s-cd", { rng: () => 0, redis });

        const call = redis.calls.set[0];
        assert.strictEqual(call.key, "frag:fbhint:cd:s-cd");
        assert.ok(call.args.includes("NX"));
        assert.ok(call.args.includes("EX"));
    });

    it("첫 힌트에서만 카운터 TTL 86400을 건다", async () => {
        const redis = createRedisStub();
        await maybeFeedbackHint("amend", "s-ttl", { rng: () => 0, redis });

        assert.deepStrictEqual(redis.calls.expire, [{ key: "frag:fbhint:count:s-ttl", ttl: 86400 }]);
    });

    it("세션당 상한(2)을 넘으면 null", async () => {
        const redis     = createRedisStub({ setResults: ["OK", "OK", "OK"] });
        const sessionId = "s-cap";

        const first  = await maybeFeedbackHint("amend", sessionId, { rng: () => 0, redis });
        const second = await maybeFeedbackHint("amend", sessionId, { rng: () => 0, redis });
        const third  = await maybeFeedbackHint("amend", sessionId, { rng: () => 0, redis });

        assert.ok(first);
        assert.ok(second);
        assert.strictEqual(third, null);
    });

    it("Redis 미가용(null)이면 상한·쿨다운 없이 fail-open", async () => {
        const first  = await maybeFeedbackHint("forget", "s-open", { rng: () => 0, redis: null });
        const second = await maybeFeedbackHint("forget", "s-open", { rng: () => 0, redis: null });
        const third  = await maybeFeedbackHint("forget", "s-open", { rng: () => 0, redis: null });

        assert.ok(first);
        assert.ok(second);
        assert.ok(third);
        assert.strictEqual(third.args.tool_name, "forget");
    });

    it("sessionId가 없으면 카운터 없이 힌트를 반환한다", async () => {
        const redis = createRedisStub();
        const hint  = await maybeFeedbackHint("forget", null, { rng: () => 0, redis });

        assert.ok(hint);
        assert.strictEqual(redis.calls.set.length, 0);
    });

    it("Redis가 예외를 던져도 fail-open", async () => {
        const redis = {
            set   : async () => { throw new Error("redis down"); },
            incr  : async () => { throw new Error("redis down"); },
            expire: async () => { throw new Error("redis down"); },
        };
        const hint = await maybeFeedbackHint("remember", "s-err", { rng: () => 0, redis });
        assert.ok(hint);
    });
});
