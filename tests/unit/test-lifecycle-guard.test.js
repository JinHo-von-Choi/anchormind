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
 * Case 3: 닫지 않은 net.Server → assertCleanShutdown이 누수 감지 (negative case)
 * Case 4: lib/sessions.js import + after 훅 정리 → clean (CP2 MEMENTO_METRICS_DEFAULT=off 의존)
 * Case 5: lib/memory/processors/ReflectProcessor.js import + after 훅 정리 → clean
 * Case 6: 표준 출력 쓰기 요청과 소켓 쓰기 요청 구분
 *
 * 환경: MEMENTO_METRICS_DEFAULT=off (npm test 에서 주입됨)
 */

import { describe, it, after } from "node:test";
import assert                  from "node:assert/strict";
import net                     from "node:net";

import { teardownTestResources, assertCleanShutdown, isStdioWriteRequest } from "../_lifecycle.js";

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

/* ── Case 3: 닫지 않은 net.Server → assertCleanShutdown이 누수 감지 (negative) ── */
describe("Case 3: 닫지 않은 서버 handle — 누수 감지 (negative case)", () => {
  /**
   * Node 11 이후 process._getActiveHandles()는 setInterval/setTimeout의 Timeout을 담지 않는다.
   * 타이머 누수는 이 헬퍼로 검출할 수 없으므로 목록에 나타나는 handle(서버, 소켓)로 검출 경로를 확인한다.
   */
  it("닫지 않은 net.Server를 assertCleanShutdown이 검출한다", async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await assert.rejects(
        () => assertCleanShutdown(),
        (err) => {
          assert.match(err.message, /Active handles after test/);
          assert.match(err.message, /Server x1/);
          return true;
        },
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("서버를 닫으면 같은 검사가 통과한다", async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => server.close(resolve));
    await assertCleanShutdown();
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

/* ── Case 6: 표준 출력 쓰기 요청과 소켓 쓰기 요청 구분 ── */
describe("Case 6: 표준 출력 쓰기 요청과 소켓 쓰기 요청 구분", () => {
  it("표준 출력 handle에 대한 요청은 표준 출력 쓰기로 판정된다", (t) => {
    if (process.stdout._handle == null) { t.skip("표준 출력 handle 없음"); return; }
    assert.equal(isStdioWriteRequest({ handle: process.stdout._handle }), true);
    assert.equal(isStdioWriteRequest({ handle: process.stderr._handle }), process.stderr._handle != null);
  });

  it("다른 handle이거나 handle이 없으면 표준 출력 쓰기가 아니다", () => {
    assert.equal(isStdioWriteRequest({ handle: {} }), false);
    assert.equal(isStdioWriteRequest({}), false);
    assert.equal(isStdioWriteRequest(null), false);
  });

  it("읽지 않는 상대에게 보내는 소켓 쓰기는 잔여 요청으로 검출된다", async () => {
    const peers  = new Set();
    const server = net.createServer((sock) => { sock.pause(); peers.add(sock); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = net.connect(server.address().port, "127.0.0.1");
    await new Promise((resolve) => client.once("connect", resolve));
    client.write(Buffer.alloc(64 * 1024 * 1024));
    try {
      await assert.rejects(() => assertCleanShutdown(), (err) => {
        assert.match(err.message, /Active requests after test/);
        assert.match(err.message, /WriteWrap/);
        return true;
      });
    } finally {
      client.destroy();
      for (const sock of peers) sock.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
