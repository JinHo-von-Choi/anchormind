/**
 * memory://active-session 리소스 — 세션 활동 로그 반환 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-08-16
 *
 * readResource("memory://active-session")가 주입된 _sessionId로
 * SessionActivityTracker.getActivity를 조회해 활동 로그를 반환하는지,
 * 세션 컨텍스트·활동 기록 부재 시 각각의 안내 응답을 주는지 검증한다.
 * DB·Redis 연결 없이 순수 로직만 검증하기 위해 의존 모듈을 모킹한다.
 */

import { describe, it } from "node:test";
import assert            from "node:assert/strict";
import { mock }          from "node:test";

const activityBySession = new Map();
const dbModuleUrl       = new URL("../../lib/tools/db.js", import.meta.url).href;
const trackerModuleUrl  = new URL("../../lib/memory/processors/SessionActivityTracker.js", import.meta.url).href;

mock.module(dbModuleUrl, {
  namedExports: {
    getPrimaryPool: () => ({ query: async () => ({ rows: [] }) })
  }
});

mock.module(trackerModuleUrl, {
  namedExports: {
    SessionActivityTracker: {
      getActivity: async (sessionId) => activityBySession.get(sessionId) ?? null
    }
  }
});

const { readResource } = await import("../../lib/tools/resources.js");

/** contents[0].text를 파싱해 반환한다. */
async function readActiveSession(params) {
  const result = await readResource("memory://active-session", params);
  assert.equal(result.contents.length, 1);
  assert.equal(result.contents[0].mimeType, "application/json");
  return JSON.parse(result.contents[0].text);
}

describe("memory://active-session", () => {
  it("활동 로그가 있으면 sessionId와 병합해 반환한다", async () => {
    activityBySession.set("sess-1#2", {
      startedAt    : "2026-08-16T00:00:00.000Z",
      lastActivity : "2026-08-16T00:05:00.000Z",
      toolCalls    : { remember: 3, recall: 1 }
    });

    const body = await readActiveSession({ _sessionId: "sess-1#2" });

    assert.equal(body.sessionId, "sess-1#2");
    assert.equal(body.toolCalls.remember, 3);
    assert.equal(body.lastActivity, "2026-08-16T00:05:00.000Z");
  });

  it("활동 기록이 없으면 안내 메시지를 반환한다", async () => {
    const body = await readActiveSession({ _sessionId: "sess-empty" });

    assert.equal(body.sessionId, "sess-empty");
    assert.match(body.message, /No activity recorded/);
  });

  it("_sessionId 미주입 시 세션 컨텍스트 부재를 알린다", async () => {
    const body = await readActiveSession({});

    assert.equal(body.sessionId, null);
    assert.match(body.status, /No session context/);
  });
});
