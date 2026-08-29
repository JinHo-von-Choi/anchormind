/**
 * POST /session/rotate 통합 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * 시나리오:
 *  1. 정상 rotate: 신규 sessionId 유효 + 구 sessionId 무효
 *  2. rate-limit: 같은 IP에서 5회 연속 → 6번째 429
 *  3. CSRF Origin: 화이트리스트 외부 Origin → 403
 *  4. rotate 후 새 sessionId로 정상 동작 (세션 존재 확인)
 *
 * DB/Redis 없이 stub 주입으로 실행 가능.
 * sessions.js, session-audit.js를 mock하여 격리.
 *
 * 수동 실행:
 *   node --test tests/integration/session-rotate-flow.test.js
 */

import "./_cleanup.js";
import { describe, it, before, beforeEach } from "node:test";
import assert   from "node:assert/strict";
import { Readable } from "node:stream";
import crypto   from "node:crypto";

/* ------------------------------------------------------------------ */
/*  공통 헬퍼                                                           */
/* ------------------------------------------------------------------ */

function fakeRes() {
  const _headers = {};
  const res      = {
    statusCode : 0,
    _body      : null,
    _headers,
    setHeader(k, v)    { _headers[k.toLowerCase()] = v; },
    getHeader(k)       { return _headers[k.toLowerCase()]; },
    writeHead(code, h) { res.statusCode = code; if (h) Object.assign(_headers, h); },
    end(body)          { res._body = body ?? ""; },
    write()            {}
  };
  return res;
}

function makeReq({
  sessionId,
  authToken  = process.env.MEMENTO_ACCESS_KEY || "test-master-key",
  bodyObj    = {},
  origin     = null,
  remoteAddr = "127.0.0.1",
} = {}) {
  const headers = {
    "content-type"   : "application/json",
    "authorization"  : `Bearer ${authToken}`,
  };
  if (sessionId)  headers["mcp-session-id"] = sessionId;
  if (origin)     headers["origin"]          = origin;

  const payload = JSON.stringify(bodyObj);
  const stream  = Readable.from([payload]);
  Object.assign(stream, {
    headers,
    method : "POST",
    url    : "/session/rotate",
    socket : { remoteAddress: remoteAddr },
  });
  return stream;
}

/** sessions.js 직접 호출로 세션 생성 (stub 없이 in-memory Map만 사용) */
async function createSession(overrides = {}) {
  const { createStreamableSessionWithId, streamableSessions } = await import("../../lib/sessions.js");
  const sid = crypto.randomUUID();
  await createStreamableSessionWithId(
    sid,
    overrides.authenticated ?? true,
    overrides.keyId         ?? null,
    null,
    null,
    overrides.workspace     ?? null
  );
  return { sid, streamableSessions };
}

/* ------------------------------------------------------------------ */
/*  auth stub: validateAuthentication을 실제 모듈로 사용하되           */
/*  MEMENTO_AUTH_DISABLED=true 로 인증 우회                            */
/* ------------------------------------------------------------------ */
before(() => {
  process.env.MEMENTO_AUTH_DISABLED = "true";
});

/* ------------------------------------------------------------------ */
/*  각 테스트 전 rate-limit 초기화                                     */
/* ------------------------------------------------------------------ */
let _resetRL;
before(async () => {
  ({ _resetForTest: _resetRL } = await import("../../lib/handlers/_rotate-ratelimit.js"));
});

beforeEach(() => {
  if (_resetRL) _resetRL();
});

/* ------------------------------------------------------------------ */
/*  시나리오 1: 정상 rotate                                             */
/* ------------------------------------------------------------------ */
describe("시나리오 1: 정상 rotate 흐름", () => {
  it("rotate 후 newSessionId가 반환되고 oldSessionId는 streamableSessions에서 제거됨", async () => {
    const { sid, streamableSessions } = await createSession();

    const { handleSessionRotate } = await import("../../lib/handlers/session-handler.js");
    const req = makeReq({ sessionId: sid });
    const res = fakeRes();

    await handleSessionRotate(req, res);

    assert.strictEqual(res.statusCode, 200, `statusCode=${res.statusCode} body=${res._body}`);

    const body = JSON.parse(res._body);
    assert.ok(body.newSessionId, "newSessionId 없음");
    assert.strictEqual(body.oldSessionId, sid);
    assert.ok(body.expiresAt > Date.now(), "expiresAt이 과거");

    /** 구 세션 무효 확인 */
    assert.strictEqual(streamableSessions.has(sid), false, "구 sessionId가 아직 존재함");

    /** 신규 세션 유효 확인 */
    assert.strictEqual(streamableSessions.has(body.newSessionId), true, "신규 sessionId가 없음");
  });
});

/* ------------------------------------------------------------------ */
/*  시나리오 2: rate-limit                                              */
/* ------------------------------------------------------------------ */
describe("시나리오 2: rate-limit", () => {
  it("같은 IP에서 5회 통과 후 6번째 429 반환", async () => {
    const { handleSessionRotate } = await import("../../lib/handlers/session-handler.js");

    /** 5회 rotate — 각 요청마다 새 세션 필요 */
    for (let i = 0; i < 5; i++) {
      const { sid } = await createSession();
      const req = makeReq({ sessionId: sid, remoteAddr: "10.10.10.10", origin: "http://localhost" });
      const res = fakeRes();
      await handleSessionRotate(req, res);
      assert.strictEqual(res.statusCode, 200, `${i + 1}번째 요청 실패: ${res._body}`);
    }

    /** 6번째 — 세션 없어도 rate-limit이 먼저 적용됨 */
    const req6 = makeReq({ sessionId: "dummy-session-id", remoteAddr: "10.10.10.10", origin: "http://localhost" });
    const res6 = fakeRes();
    await handleSessionRotate(req6, res6);

    assert.strictEqual(res6.statusCode, 429, `429 예상, 실제: ${res6.statusCode}`);
    assert.ok(res6._headers["retry-after"], "Retry-After 헤더 없음");

    const parsed6 = JSON.parse(res6._body);
    assert.strictEqual(parsed6.error, "too_many_requests");
    assert.ok(parsed6.retryAfter > 0);
  });
});

/* ------------------------------------------------------------------ */
/*  시나리오 3: CSRF Origin 거부                                        */
/* ------------------------------------------------------------------ */
describe("시나리오 3: CSRF Origin 거부", () => {
  it("알 수 없는 외부 Origin → 403", async () => {
    /** ALLOWED_ORIGINS에 특정 도메인 추가 후 외부 Origin 거부 확인 */
    const { ALLOWED_ORIGINS } = await import("../../lib/config.js");
    const prev = [...ALLOWED_ORIGINS];
    ALLOWED_ORIGINS.clear();
    ALLOWED_ORIGINS.add("https://trusted.example.com");

    try {
      const { handleSessionRotate } = await import("../../lib/handlers/session-handler.js");
      const req = makeReq({
        sessionId  : "any-session",
        origin     : "https://evil.attacker.com",
        remoteAddr : "203.0.113.99",
      });
      const res = fakeRes();
      await handleSessionRotate(req, res);
      assert.strictEqual(res.statusCode, 403, `403 예상, 실제: ${res.statusCode}`);
      const body = JSON.parse(res._body);
      assert.strictEqual(body.error, "forbidden");
    } finally {
      ALLOWED_ORIGINS.clear();
      prev.forEach(o => ALLOWED_ORIGINS.add(o));
    }
  });

  it("localhost origin → CSRF 허용 (401 — 인증 토큰 없음)", async () => {
    const { handleSessionRotate } = await import("../../lib/handlers/session-handler.js");
    /** auth 토큰 없이 → 인증 실패 401이지만 CSRF는 통과 */
    const req = makeReq({
      sessionId  : "any-session",
      origin     : "http://localhost:5173",
      remoteAddr : "127.0.0.1",
      authToken  : "",
    });
    const res = fakeRes();
    await handleSessionRotate(req, res);
    /** AUTH_DISABLED=true이므로 인증은 통과 — 세션 없어서 404 */
    assert.ok(
      res.statusCode === 401 || res.statusCode === 404 || res.statusCode === 400,
      `CSRF는 통과해야 함, 실제 statusCode=${res.statusCode}`
    );
    assert.notStrictEqual(res.statusCode, 403, "localhost가 CSRF로 거부됨");
  });
});

/* ------------------------------------------------------------------ */
/*  시나리오 4: rotate 후 새 sessionId로 정상 동작                     */
/* ------------------------------------------------------------------ */
describe("시나리오 4: rotate 후 새 sessionId로 세션 접근 가능", () => {
  it("rotate 후 반환된 newSessionId로 세션 유효성 검증 통과", async () => {
    const { sid, streamableSessions } = await createSession({ authenticated: true, keyId: "k-test" });

    const { handleSessionRotate } = await import("../../lib/handlers/session-handler.js");
    const req = makeReq({ sessionId: sid });
    const res = fakeRes();
    await handleSessionRotate(req, res);

    assert.strictEqual(res.statusCode, 200);
    const { newSessionId } = JSON.parse(res._body);

    /** 신규 세션이 streamableSessions에 존재 */
    assert.ok(streamableSessions.has(newSessionId), "newSessionId가 sessions Map에 없음");

    /** 신규 세션의 keyId가 이관됨 */
    const newSession = streamableSessions.get(newSessionId);
    assert.strictEqual(newSession.keyId, "k-test", "keyId 이관 실패");
    assert.strictEqual(newSession.authenticated, true, "authenticated 이관 실패");

    /** 구 sessionId로 재 rotate 시 404 */
    const req2 = makeReq({ sessionId: sid });
    const res2 = fakeRes();
    await handleSessionRotate(req2, res2);
    assert.strictEqual(res2.statusCode, 404, `구 sessionId가 아직 유효함: statusCode=${res2.statusCode}`);
  });
});
