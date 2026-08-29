/**
 * CLI session 서브명령 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";

/**
 * lib/cli/session.js → lib/sessions.js → lib/redis.js 경로로 ioredis 클라이언트가
 * 즉시 연결되므로, 테스트 종료 후 lifecycle helper로 정리하지 않으면 event loop가 유지되어
 * "Promise resolution is still pending" cleanup hang 발생.
 *
 * MEMENTO_METRICS_DEFAULT=off (CP2) 적용 후 prom-client collectDefaultMetrics
 * timer가 비활성화되므로 assertCleanShutdown이 active handle 0을 검증할 수 있다.
 */
after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

/** 공유 mock 세션 데이터 */
const NOW = Date.now();
const MOCK_SESSIONS = [
  {
    sessionId:      "aaaaaaaa-0000-0000-0000-000000000001",
    type:           "streamable",
    authenticated:  true,
    keyId:          "k1",
    createdAt:      NOW - 60_000,
    expiresAt:      NOW + 3_600_000,
    lastAccessedAt: NOW - 5_000,
    workspace:      null,
    defaultWorkspace: null,
  },
  {
    sessionId:      "bbbbbbbb-0000-0000-0000-000000000002",
    type:           "legacy",
    authenticated:  false,
    keyId:          null,
    createdAt:      NOW - 120_000,
    expiresAt:      NOW + 3_600_000,
    lastAccessedAt: NOW - 10_000,
    workspace:      "ws-alpha",
    defaultWorkspace: "ws-alpha",
  },
];

/** ---- 1. usage export 존재 ---- */
describe("session CLI: usage export", () => {
  it("exports a non-empty usage string containing 'Usage:'", async () => {
    const mod = await import("../../lib/cli/session.js");
    assert.ok(typeof mod.usage === "string" && mod.usage.length > 0);
    assert.ok(mod.usage.includes("Usage:"));
  });

  it("usage mentions all 3 subcommands", async () => {
    const { usage } = await import("../../lib/cli/session.js");
    assert.ok(usage.includes("list"));
    assert.ok(usage.includes("show"));
    assert.ok(usage.includes("delete"));
  });
});

/** ---- 2. list 서브명령 ---- */
describe("session CLI: list subcommand", () => {
  let originalLog;
  let captured;

  before(() => {
    originalLog = console.log;
    captured    = [];
    console.log = (...a) => captured.push(a.join(" "));
  });

  after(() => {
    console.log = originalLog;
  });

  it("list --format json returns sessions array", async () => {
    /** sessions.js listAllSessions 을 mock으로 주입 */
    const sessionsMod = await import("../../lib/sessions.js");
    const _origList    = sessionsMod.listAllSessions;

    // node:test mock.method 대신 직접 교체 (ESM module object는 writable=false일 수 있음)
    // → 로컬 모드 대신 args 조작으로 remoteUrl 없이 테스트
    // sessions.js의 streamableSessions Map에 직접 삽입
    const { streamableSessions } = sessionsMod;
    for (const s of MOCK_SESSIONS) {
      streamableSessions.set(s.sessionId, {
        ...s,
        getSseResponse: () => null,
        setSseResponse: () => {},
        close:          async () => { streamableSessions.delete(s.sessionId); },
      });
    }

    captured = [];
    const { default: sessionCmd } = await import("../../lib/cli/session.js");

    // process.exit を mock
    let exitCode = null;
    const origExit = process.exit;
    process.exit    = (code) => { exitCode = code; throw new Error(`exit:${code}`); };

    try {
      await sessionCmd({ _: ["list"], format: "json" });
    } catch (e) {
      if (!e.message.startsWith("exit:")) throw e;
    } finally {
      process.exit = origExit;
    }

    // exitCode null = 정상 종료
    assert.strictEqual(exitCode, null, "list should not call process.exit on success");

    const output = captured.join("\n");
    const parsed = JSON.parse(output);
    assert.ok(Array.isArray(parsed), "output should be JSON array");
    assert.ok(parsed.length >= 1, "should have at least 1 session");
    assert.ok(parsed[0].sessionId, "each row should have sessionId");

    // cleanup
    for (const s of MOCK_SESSIONS) streamableSessions.delete(s.sessionId);
  });
});

/** ---- 3. show 서브명령 ---- */
describe("session CLI: show subcommand", () => {
  it("show with existing sessionId outputs session data (json)", async () => {
    const sessionsMod       = await import("../../lib/sessions.js");
    const { streamableSessions } = sessionsMod;
    const target = MOCK_SESSIONS[0];

    streamableSessions.set(target.sessionId, {
      ...target,
      getSseResponse: () => null,
      setSseResponse: () => {},
      close:          async () => { streamableSessions.delete(target.sessionId); },
    });

    const captured2 = [];
    const origLog   = console.log;
    console.log     = (...a) => captured2.push(a.join(" "));

    const origExit  = process.exit;
    let exitCode    = null;
    process.exit    = (code) => { exitCode = code; throw new Error(`exit:${code}`); };

    try {
      const { default: sessionCmd } = await import("../../lib/cli/session.js");
      await sessionCmd({ _: ["show", target.sessionId], format: "json" });
    } catch (e) {
      if (!e.message.startsWith("exit:")) throw e;
    } finally {
      console.log  = origLog;
      process.exit = origExit;
      streamableSessions.delete(target.sessionId);
    }

    assert.strictEqual(exitCode, null, "show existing session should not exit with error");
    const out = captured2.join("\n");
    const obj = JSON.parse(out);
    assert.ok(obj.sessionId || obj.authenticated !== undefined, "output should be a session object");
  });

  it("show with non-existent sessionId calls process.exit(1)", async () => {
    const origExit = process.exit;
    let exitCode   = null;
    process.exit   = (code) => { exitCode = code; throw new Error(`exit:${code}`); };

    const origErr = console.error;
    console.error  = () => {};

    try {
      const { default: sessionCmd } = await import("../../lib/cli/session.js");
      await sessionCmd({ _: ["show", "00000000-dead-beef-0000-000000000000"], format: "json" });
    } catch (e) {
      if (!e.message.startsWith("exit:")) throw e;
    } finally {
      process.exit  = origExit;
      console.error = origErr;
    }

    assert.strictEqual(exitCode, 1, "show non-existent session should exit(1)");
  });
});

/** ---- 4. delete 서브명령 ---- */
describe("session CLI: delete subcommand", () => {
  it("delete existing session calls close and reports success", async () => {
    const sessionsMod       = await import("../../lib/sessions.js");
    const { streamableSessions } = sessionsMod;
    const target = MOCK_SESSIONS[0];
    let closeCalled = false;

    streamableSessions.set(target.sessionId, {
      ...target,
      getSseResponse: () => null,
      setSseResponse: () => {},
      close:          async () => {
        closeCalled = true;
        streamableSessions.delete(target.sessionId);
      },
    });

    const captured3 = [];
    const origLog   = console.log;
    console.log     = (...a) => captured3.push(a.join(" "));

    const origExit  = process.exit;
    let   exitCode  = null;
    process.exit    = (code) => { exitCode = code; throw new Error(`exit:${code}`); };

    try {
      const { default: sessionCmd } = await import("../../lib/cli/session.js");
      await sessionCmd({ _: ["delete", target.sessionId], format: "json" });
    } catch (e) {
      if (!e.message.startsWith("exit:")) throw e;
    } finally {
      console.log  = origLog;
      process.exit = origExit;
    }

    assert.strictEqual(exitCode, null, "delete existing session should not exit with error");
    const out = captured3.join("\n");
    const obj = JSON.parse(out);
    assert.strictEqual(obj.ok, true, "result.ok should be true");
    assert.strictEqual(closeCalled, true, "세션 close가 호출되지 않았다");
    assert.strictEqual(streamableSessions.has(target.sessionId), false, "세션이 제거되지 않았다");
  });
});

/** ---- 5. --format json 출력 ---- */
describe("session CLI: --format json (list)", () => {
  it("outputs valid JSON array when --format json is set", async () => {
    const sessionsMod       = await import("../../lib/sessions.js");
    const { streamableSessions } = sessionsMod;
    for (const s of MOCK_SESSIONS) {
      streamableSessions.set(s.sessionId, {
        ...s,
        getSseResponse: () => null,
        setSseResponse: () => {},
        close:          async () => { streamableSessions.delete(s.sessionId); },
      });
    }

    const captured4 = [];
    const origLog   = console.log;
    console.log     = (...a) => captured4.push(a.join(" "));

    const origExit  = process.exit;
    let   exitCode  = null;
    process.exit    = (code) => { exitCode = code; throw new Error(`exit:${code}`); };

    try {
      const { default: sessionCmd } = await import("../../lib/cli/session.js");
      await sessionCmd({ _: ["list"], format: "json" });
    } catch (e) {
      if (!e.message.startsWith("exit:")) throw e;
    } finally {
      console.log  = origLog;
      process.exit = origExit;
      for (const s of MOCK_SESSIONS) streamableSessions.delete(s.sessionId);
    }

    assert.strictEqual(exitCode, null);
    const out    = captured4.join("\n");
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed));
    for (const row of parsed) {
      assert.ok(typeof row.sessionId === "string");
      assert.ok(typeof row.authenticated === "string"); // fmtTs 변환 후 String()
    }
  });
});

/** ---- 6. 잘못된 서브명령 에러 ---- */
describe("session CLI: invalid subcommand", () => {
  it("exits with code 1 on unknown subcommand", async () => {
    const origExit  = process.exit;
    let   exitCode  = null;
    process.exit    = (code) => { exitCode = code; throw new Error(`exit:${code}`); };

    const origErr   = console.error;
    console.error   = () => {};

    try {
      const { default: sessionCmd } = await import("../../lib/cli/session.js");
      await sessionCmd({ _: ["purge-all-the-things"] });
    } catch (e) {
      if (!e.message.startsWith("exit:")) throw e;
    } finally {
      process.exit  = origExit;
      console.error = origErr;
    }

    assert.strictEqual(exitCode, 1);
  });
});

/** ---- 7. delete 비존재 세션 ---- */
describe("session CLI: delete non-existent session", () => {
  it("exits with code 1 when session not found (local mode)", async () => {
    const origExit  = process.exit;
    let   exitCode  = null;
    process.exit    = (code) => { exitCode = code; throw new Error(`exit:${code}`); };

    const origErr   = console.error;
    console.error   = () => {};

    try {
      const { default: sessionCmd } = await import("../../lib/cli/session.js");
      await sessionCmd({ _: ["delete", "00000000-dead-beef-0000-000000000099"], format: "table" });
    } catch (e) {
      if (!e.message.startsWith("exit:")) throw e;
    } finally {
      process.exit  = origExit;
      console.error = origErr;
    }

    assert.strictEqual(exitCode, 1);
  });
});
