import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * Phase 5-B 분해 이후 remember / _supersede 본문은
 * `lib/memory/processors/MemoryRememberer.js`로 이관됐다.
 * MemoryManager.prototype.remember는 얇은 위임, _supersede는 facade에 존재하지 않는다.
 * 따라서 본 스위트는 MemoryRememberer.prototype을 직접 검증한다.
 */
describe("remember supersedes parameter", () => {
  test("MemoryRememberer._persistNonAtomic이 supersedes 파라미터를 처리한다", async () => {
    const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");
    const src = MemoryRememberer.prototype._persistNonAtomic.toString();
    assert.ok(src.includes("supersedes"), "_persistNonAtomic에 supersedes 처리 로직 필수");
  });

  test("MemoryRememberer._supersede 헬퍼가 존재한다", async () => {
    const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");
    assert.strictEqual(
      typeof MemoryRememberer.prototype._supersede, "function",
      "_supersede 메서드 필수"
    );
  });

  test("_supersede가 ConflictResolver.supersede로 위임한다", async () => {
    const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");
    const src = MemoryRememberer.prototype._supersede.toString();
    assert.ok(
      src.includes("conflictResolver") && src.includes("supersede"),
      "_supersede는 conflictResolver.supersede 위임 필수"
    );
  });

  test("rememberDefinition inputSchema에 supersedes가 정의되어 있다", async () => {
    const { rememberDefinition } = await import("../../lib/tools/memory.js");
    const props = rememberDefinition.inputSchema.properties;
    assert.ok(props.supersedes, "supersedes 속성 필수");
    assert.strictEqual(props.supersedes.type, "array", "supersedes는 array 타입");
    assert.strictEqual(props.supersedes.items.type, "string", "items는 string 타입");
  });
});
