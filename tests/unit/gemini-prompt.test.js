/**
 * _buildReflectPrompts 순수 함수 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-09
 * 수정일: 2026-04-16 (_buildGeminiPrompt → _buildReflectPrompts, {systemPrompt, userPrompt} 반환)
 *
 * _buildReflectPrompts가 세션 메타데이터를 받아 자기완결성 5원칙이 주입된
 * userPrompt와 JSON-only 엄격 지시 systemPrompt를 반환하는지 검증한다.
 * backward compat: _buildGeminiPrompt 별칭도 동일 검증.
 */

import { describe, test } from "node:test";
import assert             from "node:assert/strict";

import {
  _buildReflectPrompts,
  _buildGeminiPrompt
} from "../../lib/memory/processors/AutoReflect.js";

const sampleActivity = {
  startedAt:    "2026-04-09T10:00:00Z",
  lastActivity: "2026-04-09T11:37:00Z",
  toolCalls:    { remember: 3, recall: 5 },
  keywords:     ["인증", "JWT", "세션"],
  fragments:    []
};

describe("_buildReflectPrompts", () => {

  test("반환값이 {systemPrompt, userPrompt} 객체 구조임", () => {
    const result = _buildReflectPrompts("abc-123", sampleActivity);
    assert.ok(typeof result === "object" && result !== null, "must return object");
    assert.ok(typeof result.systemPrompt === "string", "systemPrompt must be string");
    assert.ok(typeof result.userPrompt   === "string", "userPrompt must be string");
  });

  test("세션 ID를 userPrompt에 포함", () => {
    const { userPrompt } = _buildReflectPrompts("abc-123", sampleActivity);
    assert.ok(userPrompt.includes("abc-123"), "sessionId should appear in userPrompt");
  });

  test("도구 사용 카운트를 '툴: N회' 형식으로 userPrompt에 포함", () => {
    const { userPrompt } = _buildReflectPrompts("abc-123", sampleActivity);
    assert.ok(userPrompt.includes("remember: 3회"));
    assert.ok(userPrompt.includes("recall: 5회"));
  });

  test("JSON 스키마 6개 필드 힌트를 userPrompt에 포함", () => {
    const { userPrompt } = _buildReflectPrompts("abc-123", sampleActivity);
    assert.ok(userPrompt.includes("summary"));
    assert.ok(userPrompt.includes("decisions"));
    assert.ok(userPrompt.includes("errors_resolved"));
    assert.ok(userPrompt.includes("new_procedures"));
    assert.ok(userPrompt.includes("open_questions"));
    assert.ok(userPrompt.includes("narrative_summary"));
  });

  test("자기완결성 5원칙 키워드 모두 userPrompt에 포함", () => {
    const { userPrompt } = _buildReflectPrompts("abc-123", sampleActivity);
    assert.ok(userPrompt.includes("대명사"),                                 "원칙 1: 대명사 해소");
    assert.ok(userPrompt.includes("구체 엔티티") || userPrompt.includes("고유명"), "원칙 2: 구체 엔티티");
    assert.ok(userPrompt.includes("메타") && userPrompt.includes("자기참조"),      "원칙 3: 메타·자기참조 금지");
    assert.ok(userPrompt.includes("원자"),                                   "원칙 4: 원자성");
    assert.ok(userPrompt.includes("인과"),                                   "원칙 5: 인과 결합 예외");
  });

  test("6개월 후 판단 테스트 문구를 userPrompt에 포함", () => {
    const { userPrompt } = _buildReflectPrompts("abc-123", sampleActivity);
    assert.ok(userPrompt.includes("6개월") && userPrompt.includes("다른 AI"));
  });

  test("BAD 예시(메타 문자열) 중 하나 이상 userPrompt에 명시적 언급", () => {
    const { userPrompt } = _buildReflectPrompts("abc-123", sampleActivity);
    const hasBadExample = userPrompt.includes("세션 요약")
                          || userPrompt.includes("자동 요약")
                          || userPrompt.includes("이번 대화")
                          || userPrompt.includes("도구 N회");
    assert.ok(hasBadExample, "at least one BAD example keyword should appear");
  });

  test("빈 keywords 배열을 userPrompt에 '없음'으로 표시", () => {
    const activity         = { ...sampleActivity, keywords: [] };
    const { userPrompt }   = _buildReflectPrompts("abc-123", activity);
    assert.ok(userPrompt.includes("검색 키워드: 없음"));
  });

  test("빈 toolCalls 객체를 userPrompt에 '없음'으로 표시", () => {
    const activity         = { ...sampleActivity, toolCalls: {} };
    const { userPrompt }   = _buildReflectPrompts("abc-123", activity);
    assert.ok(userPrompt.includes("도구 사용: 없음"));
  });

  test("systemPrompt가 영어이며 JSON-only 지시 포함", () => {
    const { systemPrompt } = _buildReflectPrompts("abc-123", sampleActivity);
    assert.ok(systemPrompt.includes("JSON"),          "systemPrompt must mention JSON");
    assert.ok(systemPrompt.includes("JSON.parse"),    "systemPrompt must reference JSON.parse");
    assert.ok(systemPrompt.includes("markdown"),      "systemPrompt must forbid markdown");
  });

  test("backward compat: _buildGeminiPrompt 별칭이 동일 결과 반환", () => {
    const fromNew   = _buildReflectPrompts("alias-test", sampleActivity);
    const fromAlias = _buildGeminiPrompt("alias-test", sampleActivity);
    assert.deepStrictEqual(fromNew, fromAlias, "_buildGeminiPrompt alias must equal _buildReflectPrompts");
  });
});
