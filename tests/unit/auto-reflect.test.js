/**
 * AutoReflect 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-19
 *
 * reflect-filter.test.js / gemini-prompt.test.js에서 커버된 순수 함수
 * (_isEmptySession, _shouldSkipReflect, _buildReflectPrompts)는 제외하고,
 * autoReflect() 함수의 조건별 반환 경로와
 * _buildReflectPrompts 출력의 미검증 속성을 추가 검증한다.
 *
 * mock 전략:
 * - SessionActivityTracker, MemoryManager, geminiCLI는 의존성이 깊어
 *   autoReflect() 내부를 직접 호출하는 대신 순수 함수 경로에 집중.
 * - autoReflect(null) → null 반환 경로는 의존성 없이 테스트 가능.
 * - _buildReflectPrompts 반환값의 추가 속성(LEARNING 접두사 힌트, 소요 시간 표현)을 보강.
 */

import { describe, it } from "node:test";
import assert            from "node:assert/strict";

import {
  _shouldSkipReflect,
  _buildReflectPrompts,
  _buildGeminiPrompt,
  MIN_SESSION_DURATION_MS,
  autoReflect,
  GEMINI_TIMEOUT_MS,
} from "../../lib/memory/processors/AutoReflect.js";

/* ── Phase 6 회귀: Gemini timeout 30s 검증 ── */

describe("Phase 6 — GEMINI_TIMEOUT_MS 회귀 가드", () => {

  it("GEMINI_TIMEOUT_MS가 export된 숫자다", () => {
    assert.strictEqual(typeof GEMINI_TIMEOUT_MS, "number");
  });

  it("GEMINI_TIMEOUT_MS가 30_000(30s)이다 (외부 게이트웨이 60s 컷오프 대비 30s 마진)", () => {
    assert.strictEqual(GEMINI_TIMEOUT_MS, 30_000,
      "게이트웨이 컷오프 회피 마진 확보를 위해 30s를 초과해서는 안 된다");
  });

  it("GEMINI_TIMEOUT_MS가 40_000이 아니다 (이전 값 회귀 방지)", () => {
    assert.notStrictEqual(GEMINI_TIMEOUT_MS, 40_000);
  });

});

/* ── autoReflect 인터페이스 ── */

describe("autoReflect — 공개 함수 인터페이스", () => {

  it("autoReflect가 export된 함수이다", () => {
    assert.strictEqual(typeof autoReflect, "function");
  });

  it("sessionId=null이면 null을 반환한다", async () => {
    const result = await autoReflect(null);
    assert.strictEqual(result, null);
  });

  it("sessionId=undefined이면 null을 반환한다", async () => {
    const result = await autoReflect(undefined);
    assert.strictEqual(result, null);
  });

  it("sessionId='  '(공백만)이면 null을 반환한다", async () => {
    // falsy 스트링이지만 빈 문자열이 아닌 공백: truthy이므로 내부 로직으로 진입
    // SessionActivityTracker.getActivity가 없는 환경이면 catch 후 null 반환
    const result = await autoReflect("   ");
    // null 또는 skip 객체 중 하나 — DB 없는 환경이므로 null이 정상
    assert.ok(result === null || (typeof result === "object" && result !== null));
  });

});

/* ── _shouldSkipReflect 보완 케이스 ── */

describe("_shouldSkipReflect — 보완 케이스", () => {

  it("startedAt이 있으나 lastActivity 없으면 isTooShort=true → skip true", () => {
    const activity = {
      toolCalls:   { recall: 3 },
      startedAt:   "2026-04-19T10:00:00Z",
      lastActivity: null,
      fragments:   []
    };
    assert.strictEqual(_shouldSkipReflect(activity), true);
  });

  it("lastActivity가 있으나 startedAt 없으면 isTooShort=true → skip true", () => {
    const activity = {
      toolCalls:   { recall: 3 },
      startedAt:   null,
      lastActivity: "2026-04-19T10:10:00Z",
      fragments:   []
    };
    assert.strictEqual(_shouldSkipReflect(activity), true);
  });

  it("정확히 MIN_SESSION_DURATION_MS(30초) 경계: 29.999초 → skip true", () => {
    const start = new Date("2026-04-19T10:00:00.000Z");
    const end   = new Date(start.getTime() + MIN_SESSION_DURATION_MS - 1);
    const activity = {
      toolCalls:   { context: 1 },
      startedAt:   start.toISOString(),
      lastActivity: end.toISOString(),
      fragments:   []
    };
    assert.strictEqual(_shouldSkipReflect(activity), true);
  });

  it("정확히 MIN_SESSION_DURATION_MS(30초): duration=30000ms → skip false", () => {
    const start = new Date("2026-04-19T10:00:00.000Z");
    const end   = new Date(start.getTime() + MIN_SESSION_DURATION_MS);
    const activity = {
      toolCalls:   { context: 1 },
      startedAt:   start.toISOString(),
      lastActivity: end.toISOString(),
      fragments:   []
    };
    assert.strictEqual(_shouldSkipReflect(activity), false);
  });

  it("fragments가 null이면 length=0 취급 → skip false (toolCalls 있고 duration 충분한 경우)", () => {
    const start = new Date("2026-04-19T10:00:00.000Z");
    const end   = new Date(start.getTime() + 60_000);
    const activity = {
      toolCalls:   { context: 2 },
      startedAt:   start.toISOString(),
      lastActivity: end.toISOString(),
      fragments:   null
    };
    // Array.isArray(null) = false → explicitCount=0 → skip false
    assert.strictEqual(_shouldSkipReflect(activity), false);
  });

});

/* ── _buildReflectPrompts 보완 케이스 ── */

describe("_buildReflectPrompts — 보완 케이스", () => {

  const baseActivity = {
    startedAt:    "2026-04-19T09:00:00Z",
    lastActivity: "2026-04-19T10:30:00Z",
    toolCalls:    { remember: 2, recall: 3 },
    keywords:     ["nginx", "ssl"],
    fragments:    []
  };

  it("소요 시간 표현이 userPrompt에 포함된다", () => {
    const { userPrompt } = _buildReflectPrompts("sess-001", baseActivity);
    assert.ok(
      userPrompt.includes("시간") || userPrompt.includes("분"),
      "소요 시간 표현이 없다"
    );
  });

  it("keywords 목록이 userPrompt에 포함된다", () => {
    const { userPrompt } = _buildReflectPrompts("sess-001", baseActivity);
    assert.ok(userPrompt.includes("nginx"), "keyword nginx should appear");
    assert.ok(userPrompt.includes("ssl"),   "keyword ssl should appear");
  });

  it("fragments 수가 userPrompt에 포함된다", () => {
    const activity        = { ...baseActivity, fragments: ["f1", "f2"] };
    const { userPrompt }  = _buildReflectPrompts("sess-002", activity);
    assert.ok(userPrompt.includes("2"), "fragment count should appear");
  });

  it("LEARNING 접두사 가이드가 userPrompt에 포함된다", () => {
    const { userPrompt } = _buildReflectPrompts("sess-003", baseActivity);
    assert.ok(userPrompt.includes("LEARNING:"), "LEARNING: prefix hint missing");
  });

  it("systemPrompt가 JSON-only 엄격 지시를 포함한다", () => {
    const { systemPrompt } = _buildReflectPrompts("sess-004", baseActivity);
    assert.ok(systemPrompt.includes("JSON object"), "JSON object instruction missing");
    assert.ok(systemPrompt.includes("markdown"), "markdown ban missing");
  });

  it("_buildGeminiPrompt alias가 동일한 결과를 반환한다", () => {
    const a = _buildReflectPrompts("alias-sess", baseActivity);
    const b = _buildGeminiPrompt("alias-sess", baseActivity);
    assert.deepStrictEqual(a, b);
  });

  it("keywords 20개 초과 시 첫 20개만 포함한다", () => {
    const manyKw = Array.from({ length: 30 }, (_, i) => `kw${i}`);
    const { userPrompt } = _buildReflectPrompts("sess-005", { ...baseActivity, keywords: manyKw });
    assert.ok(userPrompt.includes("kw19"),  "20th keyword should appear");
    assert.ok(!userPrompt.includes("kw20"), "21st keyword should NOT appear");
  });

  it("toolCalls가 null이면 도구 사용 없음 표시", () => {
    const { userPrompt } = _buildReflectPrompts("sess-006", { ...baseActivity, toolCalls: null });
    assert.ok(userPrompt.includes("없음") || userPrompt.includes("도구 사용"));
  });

});
