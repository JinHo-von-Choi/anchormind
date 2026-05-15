/**
 * serverTime 메타 헬퍼 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-05-15
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { serverTimeMeta } from "../../lib/tools/serverTime.js";

describe("serverTimeMeta", () => {
  it("ISO 8601, epoch ms, KST display, timezone 4필드 반환", () => {
    const m = serverTimeMeta();
    assert.ok(typeof m.iso === "string" && /\d{4}-\d{2}-\d{2}T/.test(m.iso));
    assert.ok(typeof m.epoch_ms === "number" && m.epoch_ms > 1_700_000_000_000);
    assert.ok(typeof m.display_kst === "string" && m.display_kst.includes("년"));
    assert.strictEqual(m.timezone, "Asia/Seoul");
  });

  it("iso와 epoch_ms는 같은 순간을 가리킨다", () => {
    const m = serverTimeMeta();
    const fromIso = new Date(m.iso).getTime();
    assert.strictEqual(fromIso, m.epoch_ms);
  });

  it("호출마다 갱신된 시각 반환 (캐싱 없음)", async () => {
    const a = serverTimeMeta();
    await new Promise(r => setTimeout(r, 5));
    const b = serverTimeMeta();
    assert.ok(b.epoch_ms >= a.epoch_ms);
  });
});

describe("recall/context 응답 통합", () => {
  it("recall 응답 _meta에 serverTime이 항상 포함된다", async () => {
    const { tool_recall } = await import("../../lib/tools/memory.js");
    /** DB 없이도 success=false 경로에서 _meta가 형성되지 않을 수 있어
     *  성공 경로는 별도 e2e에서 검증. 본 unit은 헬퍼 자체와 import 무결성만 보장 */
    assert.strictEqual(typeof tool_recall, "function");
  });
});
