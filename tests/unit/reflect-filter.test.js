/**
 * AutoReflect 빈 세션 필터 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-28
 *
 * _isEmptySession 판정 로직과 autoReflect의 early-return 동작을 검증한다.
 */

import { describe, test } from "node:test";
import assert             from "node:assert/strict";

import {
  _isEmptySession,
  _shouldSkipReflect,
  MIN_SESSION_DURATION_MS
} from "../../lib/memory/processors/AutoReflect.js";

/* ------------------------------------------------------------------ */
/*  _isEmptySession 단위 테스트                                          */
/* ------------------------------------------------------------------ */

describe("_isEmptySession", () => {

  test("toolCalls가 없으면 빈 세션", () => {
    const activity = {
      startedAt:    "2026-03-28T10:00:00Z",
      lastActivity: "2026-03-28T10:05:00Z",
      fragments:    ["frag-1"]
    };
    assert.strictEqual(_isEmptySession(activity), true);
  });

  test("toolCalls가 빈 객체이면 빈 세션", () => {
    const activity = {
      toolCalls:    {},
      startedAt:    "2026-03-28T10:00:00Z",
      lastActivity: "2026-03-28T10:05:00Z",
      fragments:    ["frag-1"]
    };
    assert.strictEqual(_isEmptySession(activity), true);
  });

  test("fragments가 없으면 빈 세션", () => {
    const activity = {
      toolCalls:    { remember: 3 },
      startedAt:    "2026-03-28T10:00:00Z",
      lastActivity: "2026-03-28T10:05:00Z"
    };
    assert.strictEqual(_isEmptySession(activity), true);
  });

  test("fragments가 빈 배열이면 빈 세션", () => {
    const activity = {
      toolCalls:    { remember: 3 },
      startedAt:    "2026-03-28T10:00:00Z",
      lastActivity: "2026-03-28T10:05:00Z",
      fragments:    []
    };
    assert.strictEqual(_isEmptySession(activity), true);
  });

  test("세션 지속시간 < 30초이면 빈 세션", () => {
    const start = "2026-03-28T10:00:00Z";
    const end   = "2026-03-28T10:00:20Z";
    const activity = {
      toolCalls:    { remember: 2 },
      startedAt:    start,
      lastActivity: end,
      fragments:    ["frag-1"]
    };
    assert.strictEqual(_isEmptySession(activity), true);
  });

  test("startedAt 누락 시 빈 세션 취급", () => {
    const activity = {
      toolCalls:    { remember: 5 },
      lastActivity: "2026-03-28T10:05:00Z",
      fragments:    ["frag-1"]
    };
    assert.strictEqual(_isEmptySession(activity), true);
  });

  test("lastActivity 누락 시 빈 세션 취급", () => {
    const activity = {
      toolCalls:    { remember: 5 },
      startedAt:    "2026-03-28T10:00:00Z",
      fragments:    ["frag-1"]
    };
    assert.strictEqual(_isEmptySession(activity), true);
  });

  test("정상 세션은 빈 세션이 아님", () => {
    const activity = {
      toolCalls:    { remember: 3, recall: 2 },
      startedAt:    "2026-03-28T10:00:00Z",
      lastActivity: "2026-03-28T10:05:00Z",
      fragments:    ["frag-1", "frag-2"]
    };
    assert.strictEqual(_isEmptySession(activity), false);
  });

  test("지속시간이 정확히 30초이면 빈 세션이 아님", () => {
    const start = "2026-03-28T10:00:00.000Z";
    const end   = "2026-03-28T10:00:30.000Z";
    const activity = {
      toolCalls:    { remember: 1 },
      startedAt:    start,
      lastActivity: end,
      fragments:    ["frag-1"]
    };
    assert.strictEqual(_isEmptySession(activity), false);
  });

  test("MIN_SESSION_DURATION_MS 상수가 30초", () => {
    assert.strictEqual(MIN_SESSION_DURATION_MS, 30_000);
  });
});

/* ------------------------------------------------------------------ */
/*  _shouldSkipReflect 단위 테스트                                        */
/* ------------------------------------------------------------------ */

describe("_shouldSkipReflect", () => {

  test("activity가 null이면 skip true", () => {
    assert.strictEqual(_shouldSkipReflect(null), true);
  });

  test("activity가 undefined이면 skip true", () => {
    assert.strictEqual(_shouldSkipReflect(undefined), true);
  });

  test("빈 세션(toolCalls 0)이면 skip true", () => {
    const activity = {
      toolCalls:    {},
      startedAt:    "2026-04-09T10:00:00Z",
      lastActivity: "2026-04-09T10:10:00Z",
      fragments:    []
    };
    assert.strictEqual(_shouldSkipReflect(activity), true);
  });

  test("명시적 파편이 1개 이상이면 skip true (사용자가 이미 remember를 호출한 세션)", () => {
    const activity = {
      toolCalls:    { remember: 3, recall: 2 },
      startedAt:    "2026-04-09T10:00:00Z",
      lastActivity: "2026-04-09T10:10:00Z",
      fragments:    ["frag-abc123"]
    };
    assert.strictEqual(_shouldSkipReflect(activity), true);
  });

  test("명시적 파편이 여러 개면 skip true", () => {
    const activity = {
      toolCalls:    { remember: 5 },
      startedAt:    "2026-04-09T10:00:00Z",
      lastActivity: "2026-04-09T10:30:00Z",
      fragments:    ["frag-1", "frag-2", "frag-3"]
    };
    assert.strictEqual(_shouldSkipReflect(activity), true);
  });

  test("도구 호출은 있고 파편 0개이고 duration 충분한 세션만 skip false (유일한 비-skip 케이스)", () => {
    const activity = {
      toolCalls:    { context: 3, recall: 2 },
      startedAt:    "2026-04-09T10:00:00Z",
      lastActivity: "2026-04-09T10:05:00Z",
      fragments:    []
    };
    assert.strictEqual(_shouldSkipReflect(activity), false);
  });

  test("duration < 30초면 파편이 0개여도 skip true", () => {
    const activity = {
      toolCalls:    { recall: 3 },
      startedAt:    "2026-04-09T10:00:00Z",
      lastActivity: "2026-04-09T10:00:15Z",
      fragments:    []
    };
    assert.strictEqual(_shouldSkipReflect(activity), true);
  });
});
