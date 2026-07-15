/**
 * 리랭커 external 쿨다운 폴백 정책 (정적 기본값 가드 + 동작 검증)
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 */

import { describe, it, mock, afterEach } from "node:test";
import assert                            from "node:assert/strict";

describe("reranker external fallback policy", () => {
  it("config가 external 폴백 모드 기본값 skip을 노출한다", async () => {
    const cfg = await import("../../lib/config.js");
    assert.equal(cfg.RERANKER_EXTERNAL_FALLBACK, "skip");
    assert.equal(typeof cfg.RERANKER_EXTERNAL_COOLDOWN_MS, "number");
    assert.ok(cfg.RERANKER_EXTERNAL_COOLDOWN_MS > 0);
  });
});

/**
 * 동작 테스트: external 모드에서 fetch를 3연속 실패시키면
 * (a) candidates가 원순서 그대로 반환되고
 * (b) 쿨다운 진입 이후 요청은 fetch(external 호출)를 더 이상 호출하지 않는다.
 *
 * Reranker.js는 RERANKER_URL 설정 시에만 external 모드로 초기화되므로,
 * 이 스위트는 RERANKER_URL이 설정된 환경에서만 유효하다. 미설정 시 스킵한다.
 */
describe("reranker external cooldown behavior", () => {
  afterEach(() => { mock.restoreAll(); });

  it("3연속 실패 후 원순서 반환 + 쿨다운 중 external 미호출", async (t) => {
    const cfg = await import("../../lib/config.js");
    if (!cfg.RERANKER_URL || cfg.RERANKER_EXTERNAL_FALLBACK !== "skip") {
      t.skip("RERANKER_URL 미설정 또는 fallback!=skip — external 동작 테스트 스킵");
      return;
    }

    const { rerank } = await import("../../lib/memory/read/Reranker.js");

    /** 모든 external HTTP 호출을 실패로 강제 */
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("ECONNREFUSED");
    });

    const candidates = [
      { id: "a", content: "alpha", created_at: "2026-07-01" },
      { id: "b", content: "bravo", created_at: "2026-07-02" },
      { id: "c", content: "charlie", created_at: "2026-07-03" }
    ];

    /** 3회 연속 실패로 쿨다운 진입 */
    for (let i = 0; i < 3; i++) {
      const out = await rerank("q", candidates, 15);
      assert.deepEqual(out.map(c => c.id), ["a", "b", "c"], "실패 시 원순서 유지");
    }

    const callsAfterCooldownEntry = fetchMock.mock.callCount();

    /** 쿨다운 창 동안 추가 요청: external(fetch) 호출이 늘지 않아야 한다 */
    const out4 = await rerank("q", candidates, 15);
    assert.deepEqual(out4.map(c => c.id), ["a", "b", "c"], "쿨다운 중에도 원순서 반환");
    assert.equal(fetchMock.mock.callCount(), callsAfterCooldownEntry, "쿨다운 중 external 미호출");
  });
});
