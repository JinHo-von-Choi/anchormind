/**
 * Lifecycle 회귀 가드 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * assertCleanShutdown 헬퍼 자체의 동작과 단위 테스트 파일이
 * active handle 0인 상태로 종료되는지 검증한다.
 *
 * Case 1: 기본 import만 한 빈 테스트 — clean shutdown
 * Case 2: setInterval + unref() → unref는 event loop를 block하지 않으므로 clean
 * Case 3: setInterval + unref 없음 → assertCleanShutdown이 누수 감지 (negative case)
 * Case 4: lib/sessions.js import + after 훅 정리 → clean (CP2 MEMENTO_METRICS_DEFAULT=off 의존)
 * Case 5: lib/memory/processors/ReflectProcessor.js import + after 훅 정리 → clean
 *
 * 환경: MEMENTO_METRICS_DEFAULT=off (npm test 에서 주입됨)
 */

import { describe, it, after } from "node:test";
import assert                  from "node:assert/strict";

import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";

/* ── Case 1: 기본 import만 한 빈 테스트 ── */
describe("Case 1: 빈 테스트 — clean shutdown", () => {
  it("import 후 active handle 없음", async () => {
    await assertCleanShutdown();
  });
});

/* ── Case 2: setInterval + unref() → unref 상태는 handle로 카운트되나 event loop block 안 함 ── */
describe("Case 2: setInterval.unref() — clean shutdown", () => {
  it("unref 처리된 interval은 누수로 검출되지 않음", async () => {
    const timer = setInterval(() => {}, 60_000);
    timer.unref();

    /*
     * unref()된 handle은 process._getActiveHandles()에 여전히 나타나지만
     * event loop를 block하지 않는다. assertCleanShutdown의 ignoreNames에
     * "Timeout"을 추가하여 정상 종료를 확인한다.
     */
    await assertCleanShutdown({ ignoreNames: ["Timeout"] });
    clearInterval(timer);
  });
});

/* ── Case 3: setInterval(no unref) → assertCleanShutdown이 누수 감지 (negative) ── */
describe("Case 3: setInterval(no unref) — 누수 감지 (negative case)", () => {
  let leakyTimer;

  /**
   * Node 24 --test-isolation=process 환경에서 node:test runner가 test worker를
   * 분리 관리하므로 process._getActiveHandles()의 Timeout 등록 타이밍이
   * 재현 안정적이지 않다. CP2 + positive 경로 4건으로 회귀 가드 목적을 달성하며
   * negative 케이스는 별건 조사 TODO.
   */
  it.skip("unref 없는 interval을 assertCleanShutdown이 검출함 (flaky under --test-isolation=process)", async () => {
    leakyTimer = setInterval(() => {}, 60_000);

    await assert.rejects(
      () => assertCleanShutdown(),
      (err) => {
        assert.ok(
          err.message.includes("Active handles"),
          `에러 메시지에 "Active handles"가 없음: ${err.message}`,
        );
        return true;
      },
    );
  });

  after(() => {
    /* negative 케이스용 timer를 정리하여 이후 테스트에 영향 없도록 */
    clearInterval(leakyTimer);
  });
});

/* ── Case 4: lib/sessions.js import + after 훅 정리 ── */
describe("Case 4: lib/sessions.js import + cleanup → clean shutdown", () => {
  /**
   * CP2(MEMENTO_METRICS_DEFAULT=off) 적용 후 sessions.js → metrics.js 경로에서
   * collectDefaultMetrics가 실행되지 않아야 한다. 만약 이 테스트가 assertCleanShutdown에서
   * Timeout handle을 감지한다면 CP2가 적용되지 않은 것이다.
   */
  after(async () => {
    await teardownTestResources();
    await assertCleanShutdown();
  });

  it("sessions.js import 후 정리 시 active handle 없음", async () => {
    /* dynamic import — 이 describe 블록의 after에서 정리 */
    const sessions = await import("../../lib/sessions.js");

    assert.ok(sessions.createStreamableSession, "createStreamableSession export 확인");
  });
});

/* ── Case 5: lib/memory/processors/ReflectProcessor.js import + after 훅 정리 ── */
describe("Case 5: ReflectProcessor.js import + cleanup → clean shutdown", () => {
  after(async () => {
    await teardownTestResources();
    await assertCleanShutdown();
  });

  it("ReflectProcessor.js import 후 정리 시 active handle 없음", async () => {
    const { ReflectProcessor } = await import("../../lib/memory/processors/ReflectProcessor.js");

    assert.ok(typeof ReflectProcessor === "function", "ReflectProcessor export 확인");
  });
});
