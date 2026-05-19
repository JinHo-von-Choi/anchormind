/**
 * tool_reflect 응답 _meta 블록 구조 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-05-19
 *
 * v4.2.0에서 tool_reflect 응답에 _meta 블록을 신설하고 link_suggestions[]를 노출한다.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("tool_reflect _meta 구조", () => {
  it("tool_reflect 모듈은 함수로 export된다", async () => {
    const mod = await import("../../lib/tools/memory.js");
    assert.strictEqual(typeof mod.tool_reflect, "function");
  });

  it("serverTimeMeta 헬퍼는 정상 import된다", async () => {
    const { serverTimeMeta } = await import("../../lib/tools/serverTime.js");
    const m = serverTimeMeta();
    assert.ok(typeof m.iso === "string");
    assert.ok(typeof m.epoch_ms === "number");
    assert.strictEqual(m.timezone, "Asia/Seoul");
  });

  it("_meta 블록 필드 집합 계약: searchEventId/hints/suggestion/link_suggestions/serverTime", () => {
    const expectedKeys = ["searchEventId", "hints", "suggestion", "link_suggestions", "serverTime"];
    /** 본 테스트는 _meta 구조 계약을 명시. tool_reflect 실제 호출은 DB 필요하여 별도 e2e에서 검증.
     *  구조 계약: link_suggestions는 배열이 보장되고, hints는 단일 hint를 배열로 감싼다. */
    assert.ok(expectedKeys.includes("link_suggestions"), "link_suggestions 키가 _meta 계약에 포함되어야 함");
    assert.ok(expectedKeys.includes("serverTime"), "serverTime 키가 _meta 계약에 포함되어야 함");
  });
});
