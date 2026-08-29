/**
 * Mode Preset 시스템 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/** ModeRegistry는 파일 시스템 기반이므로 직접 import (실제 JSON 사용) */
import {
  getPreset,
  listPresets,
  filterTools,
  getSkillGuideOverride
} from "../../lib/memory/ModeRegistry.js";

/** 테스트용 최소 도구 목록 */
const ALL_TOOLS = [
  { name: "remember" },
  { name: "batch_remember" },
  { name: "recall" },
  { name: "context" },
  { name: "amend" },
  { name: "forget" },
  { name: "link" },
  { name: "reflect" },
  { name: "memory_consolidate" },
  { name: "memory_stats" },
  { name: "reconstruct_history" },
  { name: "graph_explore" },
  { name: "fragment_history" },
  { name: "search_traces" },
  { name: "get_skill_guide" },
  { name: "tool_feedback" }
];

describe("ModeRegistry — preset 로드", () => {

  it("4개 preset이 등록되어야 한다", () => {
    const names = listPresets();
    assert.ok(names.includes("recall-only"),  "recall-only 없음");
    assert.ok(names.includes("write-only"),   "write-only 없음");
    assert.ok(names.includes("onboarding"),   "onboarding 없음");
    assert.ok(names.includes("audit"),        "audit 없음");
  });

  it("recall-only preset 구조가 올바르다", () => {
    const preset = getPreset("recall-only");
    assert.ok(preset,                                           "preset이 null");
    assert.equal(preset.name, "recall-only");
    assert.ok(Array.isArray(preset.excluded_tools),             "excluded_tools 배열 아님");
    assert.ok(preset.excluded_tools.includes("remember"),       "remember 미포함");
    assert.ok(preset.excluded_tools.includes("batch_remember"), "batch_remember 미포함");
    assert.equal(preset.requiresMaster, false);
  });

  it("audit preset은 requiresMaster=true 이다", () => {
    const preset = getPreset("audit");
    assert.ok(preset);
    assert.equal(preset.requiresMaster, true);
  });

  it("존재하지 않는 preset은 null 반환", () => {
    assert.equal(getPreset("nonexistent-mode"), null);
  });

});

describe("ModeRegistry — filterTools", () => {

  it("recall-only 모드에서 remember가 필터링된다", () => {
    const result = filterTools(ALL_TOOLS, "recall-only", false);
    const names  = result.map(t => t.name);
    assert.ok(!names.includes("remember"),        "remember가 남아 있음");
    assert.ok(!names.includes("batch_remember"),  "batch_remember가 남아 있음");
    assert.ok(!names.includes("amend"),           "amend가 남아 있음");
    assert.ok(!names.includes("forget"),          "forget이 남아 있음");
    assert.ok(!names.includes("reflect"),         "reflect가 남아 있음");
    assert.ok(!names.includes("memory_consolidate"), "memory_consolidate가 남아 있음");
    assert.ok(names.includes("recall"),           "recall이 제거됨");
    assert.ok(names.includes("context"),          "context가 제거됨");
  });

  it("write-only 모드에서 recall/context가 필터링된다", () => {
    const result = filterTools(ALL_TOOLS, "write-only", false);
    const names  = result.map(t => t.name);
    assert.ok(!names.includes("recall"),   "recall이 남아 있음");
    assert.ok(!names.includes("context"),  "context가 남아 있음");
    assert.ok(names.includes("remember"),  "remember가 제거됨");
    assert.ok(names.includes("reflect"),   "reflect가 제거됨");
  });

  it("onboarding 모드는 도구를 필터링하지 않는다", () => {
    const result = filterTools(ALL_TOOLS, "onboarding", false);
    assert.equal(result.length, ALL_TOOLS.length);
  });

  it("audit 모드는 master key 세션에서만 적용된다", () => {
    /** master key (isMaster=true) → excluded_tools 적용 */
    const masterResult = filterTools(ALL_TOOLS, "audit", true);
    const masterNames  = masterResult.map(t => t.name);
    assert.ok(!masterNames.includes("remember"), "master: remember 남아 있음");
    assert.ok(!masterNames.includes("reflect"),  "master: reflect 남아 있음");
    assert.ok(masterNames.includes("memory_stats"), "master: memory_stats 제거됨");

    /** API key (isMaster=false) → preset 무시, 전체 도구 노출 */
    const apiResult = filterTools(ALL_TOOLS, "audit", false);
    assert.equal(apiResult.length, ALL_TOOLS.length, "API key: 도구가 필터링됨");
  });

  it("알 수 없는 mode 지정 시 도구가 필터링되지 않는다", () => {
    const result = filterTools(ALL_TOOLS, "unknown-mode-xyz", false);
    assert.equal(result.length, ALL_TOOLS.length);
  });

  it("mode=null 이면 전체 도구 반환", () => {
    const result = filterTools(ALL_TOOLS, null, false);
    assert.equal(result.length, ALL_TOOLS.length);
  });

});

describe("ModeRegistry — getSkillGuideOverride", () => {

  it("recall-only 모드에서 override 반환", () => {
    const override = getSkillGuideOverride("recall-only", false);
    assert.ok(typeof override === "string" && override.length > 0);
    assert.ok(override.includes("조회 전용"), "override에 '조회 전용' 문구 없음");
  });

  it("onboarding 모드에서 가이드 override 반환", () => {
    const override = getSkillGuideOverride("onboarding", false);
    assert.ok(typeof override === "string" && override.length > 0);
  });

  it("audit 모드는 master key에서만 override 반환", () => {
    const masterOverride = getSkillGuideOverride("audit", true);
    assert.ok(typeof masterOverride === "string" && masterOverride.length > 0);

    const apiOverride = getSkillGuideOverride("audit", false);
    assert.equal(apiOverride, null, "API key에서 audit override가 반환됨");
  });

  it("mode=null 이면 null 반환", () => {
    assert.equal(getSkillGuideOverride(null, false), null);
  });

  it("알 수 없는 mode이면 null 반환", () => {
    assert.equal(getSkillGuideOverride("ghost-mode", false), null);
  });

});
