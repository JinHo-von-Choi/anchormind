/**
 * 세션 idle reflect 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-17
 *
 * 검증 대상 (cleanupExpiredSessions의 idle reflect 분기):
 *  1. lastAccessedAt이 24h 이상 지난 세션 → autoReflect 실행, lastReflectedAt 갱신
 *  2. lastAccessedAt이 24h 미만 → autoReflect 미실행
 *  3. 이미 24h 내에 reflect한 세션은 재호출 안 됨
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

/** ─────────────────────────────────────────────────────────────────
 *  cleanupExpiredSessions idle-reflect 분기를 독립 순수 함수로 재현
 *
 *  실제 함수를 import하면 Redis/PostgreSQL 의존성이 너무 깊어지므로,
 *  분기 로직만 추출한 테스트 헬퍼를 사용한다.
 * ──────────────────────────────────────────────────────────────── */

/**
 * cleanupExpiredSessions의 idle-reflect 분기를 재현한 순수 함수.
 *
 * @param {object}   session           - 세션 객체 (mutable: lastReflectedAt 갱신됨)
 * @param {number}   now               - 현재 타임스탬프 (ms)
 * @param {number}   idleThresholdMs   - idle reflect 임계값 (ms)
 * @param {Function} autoReflectFn     - autoReflect mock
 * @param {Function} recordFn          - recordSessionIdleReflect mock
 * @returns {Promise<boolean>}          - reflect가 실행됐으면 true
 */
async function applyIdleReflect(session, now, idleThresholdMs, autoReflectFn, recordFn) {
  const lastAccess    = session.lastAccessedAt || session.createdAt;
  const lastReflected = session.lastReflectedAt;
  const isIdleEnough  = (now - lastAccess) > idleThresholdMs;
  const needsReflect  = !lastReflected || (now - lastReflected) > idleThresholdMs;

  if (isIdleEnough && needsReflect) {
    try {
      await autoReflectFn(session.sessionId);
      session.lastReflectedAt = now;
      recordFn();
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

describe("cleanupExpiredSessions idle reflect 분기", () => {

  const IDLE_THRESHOLD_MS = 24 * 3600 * 1000; // 24시간

  it("TC1: lastAccessedAt 25h 전, lastReflectedAt null → autoReflect 호출 + lastReflectedAt 갱신", async () => {
    const now     = Date.now();
    const session = {
      sessionId       : "sess-idle-1",
      lastAccessedAt  : now - 25 * 3600 * 1000,
      lastReflectedAt : null,
    };
    const spyReflect = mock.fn(async () => null);
    const spyRecord  = mock.fn();

    const executed = await applyIdleReflect(session, now, IDLE_THRESHOLD_MS, spyReflect, spyRecord);

    assert.strictEqual(executed, true, "reflect가 실행되어야 함");
    assert.strictEqual(spyReflect.mock.callCount(), 1, "autoReflect 1회 호출");
    assert.strictEqual(spyReflect.mock.calls[0].arguments[0], "sess-idle-1");
    assert.strictEqual(spyRecord.mock.callCount(), 1, "recordSessionIdleReflect 1회 호출");
    assert.strictEqual(session.lastReflectedAt, now, "lastReflectedAt이 now로 갱신");
  });

  it("TC2: lastAccessedAt 23h 전 → autoReflect 미호출 (idle 부족)", async () => {
    const now     = Date.now();
    const session = {
      sessionId       : "sess-active-1",
      lastAccessedAt  : now - 23 * 3600 * 1000,
      lastReflectedAt : null,
    };
    const spyReflect = mock.fn(async () => null);
    const spyRecord  = mock.fn();

    const executed = await applyIdleReflect(session, now, IDLE_THRESHOLD_MS, spyReflect, spyRecord);

    assert.strictEqual(executed, false, "reflect가 실행되지 않아야 함");
    assert.strictEqual(spyReflect.mock.callCount(), 0, "autoReflect 미호출");
    assert.strictEqual(session.lastReflectedAt, null, "lastReflectedAt 변경 없음");
  });

  it("TC3: lastAccessedAt 25h 전, lastReflectedAt 1h 전 → autoReflect 미호출 (최근에 reflect됨)", async () => {
    const now     = Date.now();
    const session = {
      sessionId       : "sess-recent-reflect",
      lastAccessedAt  : now - 25 * 3600 * 1000,
      lastReflectedAt : now - 1 * 3600 * 1000,
    };
    const spyReflect = mock.fn(async () => null);
    const spyRecord  = mock.fn();

    const executed = await applyIdleReflect(session, now, IDLE_THRESHOLD_MS, spyReflect, spyRecord);

    assert.strictEqual(executed, false, "최근 reflect 세션은 재호출 안 됨");
    assert.strictEqual(spyReflect.mock.callCount(), 0);
  });

  it("TC4: lastAccessedAt 25h 전, lastReflectedAt 25h 전 → autoReflect 재호출 (둘 다 임계 초과)", async () => {
    const now     = Date.now();
    const session = {
      sessionId       : "sess-double-idle",
      lastAccessedAt  : now - 25 * 3600 * 1000,
      lastReflectedAt : now - 25 * 3600 * 1000,
    };
    const spyReflect = mock.fn(async () => null);
    const spyRecord  = mock.fn();

    const executed = await applyIdleReflect(session, now, IDLE_THRESHOLD_MS, spyReflect, spyRecord);

    assert.strictEqual(executed, true);
    assert.strictEqual(spyReflect.mock.callCount(), 1);
    assert.strictEqual(session.lastReflectedAt, now);
  });

  it("TC5: autoReflect 예외 발생 시 루프 계속 (false 반환)", async () => {
    const now     = Date.now();
    const session = {
      sessionId       : "sess-error",
      lastAccessedAt  : now - 26 * 3600 * 1000,
      lastReflectedAt : null,
    };
    const originalReflectedAt = session.lastReflectedAt;
    const spyReflect = mock.fn(async () => { throw new Error("reflect failed"); });
    const spyRecord  = mock.fn();

    const executed = await applyIdleReflect(session, now, IDLE_THRESHOLD_MS, spyReflect, spyRecord);

    assert.strictEqual(executed, false, "예외 발생 시 false 반환");
    assert.strictEqual(spyRecord.mock.callCount(), 0, "예외 발생 시 record 미호출");
    assert.strictEqual(session.lastReflectedAt, originalReflectedAt, "lastReflectedAt 변경 없음");
  });

  it("TC6: 정확히 24h = 임계값 초과 아님 → 미실행", async () => {
    const now     = Date.now();
    const session = {
      sessionId       : "sess-boundary",
      lastAccessedAt  : now - IDLE_THRESHOLD_MS,    // 정확히 24h
      lastReflectedAt : null,
    };
    const spyReflect = mock.fn(async () => null);
    const spyRecord  = mock.fn();

    const executed = await applyIdleReflect(session, now, IDLE_THRESHOLD_MS, spyReflect, spyRecord);

    // (now - lastAccess) > idleThresholdMs → 정확히 같으면 false
    assert.strictEqual(executed, false, "정확히 24h는 임계 미초과");
  });

  it("TC7: 24h + 1ms → 임계 초과 → 실행", async () => {
    const now     = Date.now();
    const session = {
      sessionId       : "sess-boundary-plus",
      lastAccessedAt  : now - IDLE_THRESHOLD_MS - 1,
      lastReflectedAt : null,
    };
    const spyReflect = mock.fn(async () => null);
    const spyRecord  = mock.fn();

    const executed = await applyIdleReflect(session, now, IDLE_THRESHOLD_MS, spyReflect, spyRecord);

    assert.strictEqual(executed, true);
    assert.strictEqual(spyReflect.mock.callCount(), 1);
  });

});
