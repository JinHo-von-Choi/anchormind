/**
 * 이슈 #21: Codex Desktop deferred/lazy tool discovery 대응 회귀 테스트
 *
 * Task 1: initialize instructions에 deferred 가이드 포함
 * Task 2: 코어 도구 title/annotations + tools/list 순서
 * Task 3: get_skill_guide codex 섹션 + 기존 섹션 회귀
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("issue #21: deferred tool discovery 가이드 — Task 1", () => {
  test("initialize instructions에 deferred 재검색 가이드가 포함된다", async () => {
    const { handleInitialize } = await import("../../lib/jsonrpc.js");
    const result = await handleInitialize({
      protocolVersion : "2025-11-25",
      capabilities    : {},
      clientInfo      : { name: "test-client", version: "1.0" }
    });
    const _instructions = result?.serverInfo ? null : result?.instructions;
    // handleInitialize가 { capabilities, serverInfo, instructions, ... } 구조를 반환
    const instr = result?.instructions ?? "";
    assert.match(
      instr,
      /deferred|recall이 안 보이/i,
      "instructions에 deferred tool discovery 가이드가 포함되어야 한다"
    );
  });
});

describe("issue #21: title/annotations 메타데이터 — Task 2", () => {
  test("recall에 title/annotations 메타데이터가 있다", async () => {
    const { recallDefinition } = await import("../../lib/tools/memory-schemas.js");
    assert.ok(recallDefinition.title, "recall에 title 필드가 있어야 한다");
    assert.equal(
      recallDefinition.annotations?.readOnlyHint,
      true,
      "recall.annotations.readOnlyHint가 true여야 한다"
    );
  });

  test("context에 title/annotations 메타데이터가 있다", async () => {
    const { contextDefinition } = await import("../../lib/tools/memory-schemas.js");
    assert.ok(contextDefinition.title, "context에 title 필드가 있어야 한다");
    assert.equal(
      contextDefinition.annotations?.readOnlyHint,
      true,
      "context.annotations.readOnlyHint가 true여야 한다"
    );
  });

  test("remember에 title이 있다", async () => {
    const { rememberDefinition } = await import("../../lib/tools/memory-schemas.js");
    assert.ok(rememberDefinition.title, "remember에 title 필드가 있어야 한다");
  });

  test("tools/list에서 recall이 batch_remember보다 먼저 온다", async () => {
    const { getToolsDefinition } = await import("../../lib/tools/index.js");
    const names = getToolsDefinition(null).map(d => d.name);
    assert.ok(
      names.indexOf("recall") < names.indexOf("batch_remember"),
      `recall(${names.indexOf("recall")})이 batch_remember(${names.indexOf("batch_remember")})보다 먼저 와야 한다`
    );
  });

  test("tools/list에서 context가 batch_remember보다 먼저 온다", async () => {
    const { getToolsDefinition } = await import("../../lib/tools/index.js");
    const names = getToolsDefinition(null).map(d => d.name);
    assert.ok(
      names.indexOf("context") < names.indexOf("batch_remember"),
      `context(${names.indexOf("context")})이 batch_remember(${names.indexOf("batch_remember")})보다 먼저 와야 한다`
    );
  });
});

describe("issue #21: get_skill_guide codex 섹션 — Task 3", () => {
  test("get_skill_guide(section=codex)가 deferred 가이드를 반환한다", async () => {
    const { tool_getSkillGuide } = await import("../../lib/tools/memory.js");
    const r = await tool_getSkillGuide({ section: "codex" });
    assert.equal(r.success, true, `codex 섹션 반환 실패: ${r.error}`);
    // section이 지정됐으면 r.section이 "codex"여야 한다 (전체 가이드 fallback 아님)
    assert.equal(r.section, "codex", "section 필드가 'codex'여야 한다 (전체 fallback 아님)");
    assert.match(
      r.content,
      /deferred|recall/i,
      "codex 섹션에 deferred/recall 가이드가 포함되어야 한다"
    );
  });

  test("기존 섹션(multiplatform, tools) 회귀 없음", async () => {
    const { tool_getSkillGuide } = await import("../../lib/tools/memory.js");
    for (const s of ["multiplatform", "tools"]) {
      const r = await tool_getSkillGuide({ section: s });
      assert.equal(r.success, true, `${s} 섹션 반환 실패: ${r.error}`);
      assert.ok(r.content.length > 0, `${s} 섹션 내용이 비어있으면 안 된다`);
    }
  });

  test("기존 섹션(cbr, triggers, antipatterns) 회귀 없음", async () => {
    const { tool_getSkillGuide } = await import("../../lib/tools/memory.js");
    for (const s of ["cbr", "triggers", "antipatterns"]) {
      const r = await tool_getSkillGuide({ section: s });
      assert.equal(r.success, true, `${s} 섹션 반환 실패: ${r.error}`);
      assert.ok(r.content.length > 0, `${s} 섹션 내용이 비어있으면 안 된다`);
    }
  });

  test("recall description이 openapi 제약을 유지한다 (_meta, searchEventId, 3줄 이상)", async () => {
    const { recallDefinition } = await import("../../lib/tools/memory-schemas.js");
    const desc  = recallDefinition.description;
    const lines = desc.split("\n").filter(l => l.trim().length > 0);
    assert.ok(lines.length >= 3, `recall description이 최소 3줄이어야 한다 (현재 ${lines.length}줄)`);
    assert.ok(desc.includes("_meta"), "recall description에 _meta가 포함되어야 한다");
    assert.ok(desc.includes("searchEventId"), "recall description에 searchEventId가 포함되어야 한다");
  });
});
