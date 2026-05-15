/**
 * assistant-query.js 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-28
 */

import { test, describe }        from "node:test";
import assert                     from "node:assert/strict";
import {
  isAssistantQuery,
  expandAssistantQuery,
  boostAssistantFragments
} from "../../lib/memory/assistant-query.js";

describe("isAssistantQuery", () => {
  test("한국어 패턴 감지: 어시스턴트가", () => {
    assert.strictEqual(isAssistantQuery("어시스턴트가 뭐라고 했어?"), true);
  });

  test("한국어 패턴 감지: AI가", () => {
    assert.strictEqual(isAssistantQuery("AI가 추천한 방법"), true);
  });

  test("한국어 패턴 감지: 클로드가", () => {
    assert.strictEqual(isAssistantQuery("클로드가 설명한 내용"), true);
  });

  test("한국어 패턴 감지: 봇이", () => {
    assert.strictEqual(isAssistantQuery("봇이 알려준 설정값"), true);
  });

  test("한국어 패턴 감지: 뭐라고 했", () => {
    assert.strictEqual(isAssistantQuery("아까 뭐라고 했어?"), true);
  });

  test("한국어 패턴 감지: 답변", () => {
    assert.strictEqual(isAssistantQuery("이전 답변 다시 보여줘"), true);
  });

  test("영어 패턴 감지: assistant said", () => {
    assert.strictEqual(isAssistantQuery("What the assistant said about deployment"), true);
  });

  test("영어 패턴 감지: what did you say (대소문자 무시)", () => {
    assert.strictEqual(isAssistantQuery("What Did You Say about caching?"), true);
  });

  test("영어 패턴 감지: your response", () => {
    assert.strictEqual(isAssistantQuery("show me your response about Redis"), true);
  });

  test("영어 패턴 감지: you mentioned", () => {
    assert.strictEqual(isAssistantQuery("You mentioned a migration script"), true);
  });

  test("어시스턴트 패턴 없는 일반 쿼리", () => {
    assert.strictEqual(isAssistantQuery("Redis 설정 방법"), false);
  });

  test("빈 문자열", () => {
    assert.strictEqual(isAssistantQuery(""), false);
  });

  test("null 입력", () => {
    assert.strictEqual(isAssistantQuery(null), false);
  });

  test("undefined 입력", () => {
    assert.strictEqual(isAssistantQuery(undefined), false);
  });

  test("숫자 입력", () => {
    assert.strictEqual(isAssistantQuery(42), false);
  });
});

describe("expandAssistantQuery", () => {
  test("어시스턴트 쿼리: Assistant: 접두어 추가", () => {
    const result = expandAssistantQuery("클로드가 설명한 배포 방법");
    assert.strictEqual(result.isAssistantQuery, true);
    assert.ok(result.text.startsWith("Assistant:"));
    assert.ok(result.text.includes("클로드가 설명한 배포 방법"));
  });

  test("일반 쿼리: 원본 텍스트 그대로 반환", () => {
    const result = expandAssistantQuery("Redis 캐시 설정");
    assert.strictEqual(result.isAssistantQuery, false);
    assert.strictEqual(result.text, "Redis 캐시 설정");
  });

  test("영어 어시스턴트 쿼리 확장", () => {
    const result = expandAssistantQuery("what did you say about indexing?");
    assert.strictEqual(result.isAssistantQuery, true);
    assert.ok(result.text.startsWith("Assistant:"));
  });
});

describe("boostAssistantFragments", () => {
  test("Assistant: 포함 파편 importance 부스트", () => {
    const fragments = [
      { id: "1", content: "User: 배포 방법 알려줘\nAssistant: Docker를 사용합니다.", importance: 0.5 },
      { id: "2", content: "Redis 설정 가이드", importance: 0.5 }
    ];

    boostAssistantFragments(fragments);

    assert.strictEqual(fragments[0].importance, 0.52);
    assert.strictEqual(fragments[1].importance, 0.5);
  });

  test("답변: 포함 파편도 부스트", () => {
    const fragments = [
      { id: "1", content: "질문: X\n답변: Y입니다.", importance: 0.6 }
    ];

    boostAssistantFragments(fragments);

    assert.strictEqual(fragments[0].importance, 0.62);
  });

  test("importance 최대값 1.0 제한", () => {
    const fragments = [
      { id: "1", content: "Assistant: 결과입니다.", importance: 0.98 }
    ];

    boostAssistantFragments(fragments);

    assert.strictEqual(fragments[0].importance, 1.0);
  });

  test("content 없는 파편은 무시", () => {
    const fragments = [
      { id: "1", importance: 0.5 }
    ];

    boostAssistantFragments(fragments);

    assert.strictEqual(fragments[0].importance, 0.5);
  });

  test("커스텀 부스트 값 적용", () => {
    const fragments = [
      { id: "1", content: "Assistant: 답변 내용", importance: 0.5 }
    ];

    boostAssistantFragments(fragments, 0.1);

    assert.strictEqual(fragments[0].importance, 0.6);
  });

  test("importance 미설정 파편도 부스트", () => {
    const fragments = [
      { id: "1", content: "Assistant: 답변 내용" }
    ];

    boostAssistantFragments(fragments);

    assert.strictEqual(fragments[0].importance, 0.02);
  });
});
