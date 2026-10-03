/**
 * remember 응답의 작업 기억 힌트 병합 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 저장소 힌트(_meta.hints)가 있는 응답에 피드백 표집 힌트가 붙어도 저장소 힌트가 남는지 본다.
 */

import { test, describe, mock } from "node:test";
import assert                   from "node:assert/strict";

/** 감사 이벤트 기록은 이 시험의 대상이 아니다. DB에 연결하지 않도록 끈다 */
process.env.MEMENTO_AUDIT_DB = "off";

const manager = {
  remember: async () => ({
    id: "frag-1", keywords: ["a"], ttl_tier: "session", scope: "session", conflicts: [],
    working_memory: "postgres-fallback",
    _meta: { hints: [{ signal: "working_memory_fallback", suggestion: "대체 경로", trigger: "context" }] }
  })
};

mock.module("../../lib/memory/MemoryManager.js", {
  namedExports : { MemoryManager: { getInstance: () => manager } },
  defaultExport: { getInstance: () => manager }
});

const sampled = { current: null };
mock.module("../../lib/memory/signals/FeedbackSampler.js", {
  namedExports: {
    maybeFeedbackHint: async () => sampled.current,
    shouldSample     : () => false,
    buildFeedbackHint: () => null
  }
});

const memory = await import("../../lib/tools/memory.js");

describe("remember 응답 힌트", () => {
  test("표집 힌트가 없으면 저장소 힌트만 그대로 돌려준다", async () => {
    sampled.current = null;
    const res = await memory.tool_remember({ content: "내용", topic: "test", type: "fact", scope: "session" });
    assert.equal(res.working_memory, "postgres-fallback");
    assert.deepEqual(res._meta.hints.map(h => h.signal), ["working_memory_fallback"]);
  });

  test("표집 힌트가 붙어도 저장소 힌트를 덮어쓰지 않는다", async () => {
    sampled.current = { signal: "feedback_sampled", suggestion: "평가", trigger: "tool_feedback" };
    const res = await memory.tool_remember({ content: "내용", topic: "test", type: "fact", scope: "session" });
    assert.deepEqual(res._meta.hints.map(h => h.signal), ["working_memory_fallback", "feedback_sampled"]);
    assert.ok(res._meta.serverTime);
  });
});
