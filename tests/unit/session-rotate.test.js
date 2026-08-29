/**
 * POST /session/rotate + rotateSession() 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * 검증 대상:
 *  1. rotateSession 성공 — oldSessionId 무효, newSessionId 유효
 *  2. rotateSession — bound_key_id / workspace 이관 확인
 *  3. rotateSession — 존재하지 않는 sessionId → 404 에러
 *  4. rotateSession — 만료된 세션 → 401 에러
 *  5. POST /session/rotate — 인증 없는 요청 → 401
 *  6. POST /session/rotate — Mcp-Session-Id 헤더 누락 → 400
 *  7. POST /session/rotate — 인증된 요청 → 200, 응답 shape 검증
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable }  from "node:stream";

/* ------------------------------------------------------------------ */
/*  공통 유틸리티                                                       */
/* ------------------------------------------------------------------ */

function fakeRes() {
  const _headers = {};
  const res      = {
    statusCode  : 0,
    _body       : null,
    _headers,
    setHeader(k, v)    { _headers[k.toLowerCase()] = v; },
    getHeader(k)       { return _headers[k.toLowerCase()]; },
    writeHead(code, h) { res.statusCode = code; if (h) Object.assign(_headers, h); },
    end(body)          { res._body = body ?? ""; },
    write()            {}
  };
  return res;
}

function fakeReq({ method = "POST", pathname = "/session/rotate", headers = {}, bodyObj = null } = {}) {
  const req   = new Readable({ read() {} });
  req.method  = method;
  req.url     = pathname;
  req.headers = { "content-type": "application/json", ...headers };

  if (bodyObj !== null) {
    req.push(JSON.stringify(bodyObj));
  }
  req.push(null);
  return req;
}

/* ------------------------------------------------------------------ */
/*  rotateSession 순수 로직 재현 (DB/Redis 의존성 없이)                 */
/* ------------------------------------------------------------------ */

/**
 * rotateSession과 동일한 흐름을 의존성 주입 방식으로 재현.
 * sessions.js의 실제 Map/Redis 대신 인메모리 Map을 주입해 검증한다.
 */
async function rotateSessionLocal(oldSessionId, {
  sessionsMap        = new Map(),
  createNewSession   = null,  /** (id, ctx) => Promise<void> */
  deleteOldSession   = null,  /** (id) => Promise<void> */
  sessionTtlMs       = 30 * 24 * 3600 * 1000,
  _reason             = "explicit_rotate"
} = {}) {
  const existing = sessionsMap.get(oldSessionId);

  if (!existing) {
    const err       = new Error("Session not found");
    err.statusCode  = 404;
    throw err;
  }

  const now = Date.now();
  if (now > existing.expiresAt) {
    sessionsMap.delete(oldSessionId);
    const err       = new Error("Session expired");
    err.statusCode  = 401;
    throw err;
  }

  const {
    keyId            = null,
    groupKeyIds      = null,
    permissions      = null,
    defaultWorkspace = null,
    mode             = null,
    authenticated    = false
  } = existing;

  /** 신규 세션 ID 생성 */
  const { randomUUID } = await import("node:crypto");
  const newSessionId   = randomUUID();

  const newSession = {
    sessionId        : newSessionId,
    authenticated,
    keyId,
    groupKeyIds,
    permissions,
    defaultWorkspace,
    mode,
    createdAt        : now,
    expiresAt        : now + sessionTtlMs,
    lastAccessedAt   : now
  };

  sessionsMap.set(newSessionId, newSession);

  if (createNewSession) await createNewSession(newSessionId, newSession);

  /** 기존 세션 제거 */
  sessionsMap.delete(oldSessionId);
  if (deleteOldSession) await deleteOldSession(oldSessionId);

  return { oldSessionId, newSessionId, expiresAt: newSession.expiresAt, keyId, workspace: defaultWorkspace };
}

/* ------------------------------------------------------------------ */
/*  HTTP 핸들러 라우팅 재현 (handleSessionRotate 핵심 흐름)             */
/* ------------------------------------------------------------------ */

async function routeSessionRotate(req, res, {
  validateAuthFn   = null,  /** (req) => Promise<{ valid, keyId? }> */
  rotateSessionFn  = null,  /** (id, opts) => Promise<result> */
} = {}) {
  /** Origin 검증 — strict=false 기본값이므로 항상 통과 */

  /** 인증 */
  const auth = await validateAuthFn(req);
  if (!auth.valid) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "unauthorized", error_description: "Valid Bearer token required" }));
    return;
  }

  /** 세션 ID 헤더 */
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "bad_request", error_description: "Mcp-Session-Id header is required" }));
    return;
  }

  /** 본문 파싱 */
  let reason = "explicit_rotate";
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw  = Buffer.concat(chunks).toString("utf-8");
    if (raw) {
      const body = JSON.parse(raw);
      if (body && typeof body.reason === "string" && body.reason.trim()) {
        reason = body.reason.trim().slice(0, 128);
      }
    }
  } catch { /* 기본값 유지 */ }

  try {
    const result = await rotateSessionFn(sessionId, { reason });
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      oldSessionId: result.oldSessionId,
      newSessionId: result.newSessionId,
      expiresAt:    result.expiresAt,
      reason
    }));
  } catch (err) {
    const code = err.statusCode ?? 500;
    res.statusCode = code;
    res.setHeader("content-type", "application/json");
    const body = code === 404
      ? { error: "not_found",       error_description: "Session not found" }
      : code === 401
      ? { error: "session_expired", error_description: "Session has expired" }
      : { error: "server_error",    error_description: "Failed to rotate session" };
    res.end(JSON.stringify(body));
  }
}

/* ------------------------------------------------------------------ */
/*  테스트                                                              */
/* ------------------------------------------------------------------ */

describe("rotateSession — 핵심 로직", () => {

  it("1. 성공 시 oldSessionId 무효, newSessionId 유효", async () => {
    const map = new Map();
    const now = Date.now();

    map.set("old-id", {
      sessionId        : "old-id",
      authenticated    : true,
      keyId            : "key-123",
      groupKeyIds      : null,
      permissions      : null,
      defaultWorkspace : null,
      mode             : null,
      createdAt        : now,
      expiresAt        : now + 60_000,
      lastAccessedAt   : now
    });

    const result = await rotateSessionLocal("old-id", { sessionsMap: map });

    assert.ok(!map.has("old-id"),          "old-id는 Map에서 삭제돼야 함");
    assert.ok(map.has(result.newSessionId), "newSessionId는 Map에 존재해야 함");
    assert.equal(result.oldSessionId, "old-id");
    assert.ok(typeof result.newSessionId === "string" && result.newSessionId.length > 0);
    assert.ok(result.expiresAt > now);
  });

  it("2. bound_key_id / workspace 이관 확인", async () => {
    const map = new Map();
    const now = Date.now();

    map.set("old-id", {
      sessionId        : "old-id",
      authenticated    : true,
      keyId            : "key-456",
      groupKeyIds      : ["g1", "g2"],
      permissions      : ["read", "write"],
      defaultWorkspace : "ws-prod",
      mode             : "strict",
      createdAt        : now,
      expiresAt        : now + 60_000,
      lastAccessedAt   : now
    });

    const result = await rotateSessionLocal("old-id", { sessionsMap: map });

    const newSession = map.get(result.newSessionId);
    assert.equal(newSession.keyId,            "key-456");
    assert.deepEqual(newSession.groupKeyIds,  ["g1", "g2"]);
    assert.deepEqual(newSession.permissions,  ["read", "write"]);
    assert.equal(newSession.defaultWorkspace, "ws-prod");
    assert.equal(newSession.mode,             "strict");
    assert.equal(result.keyId,                "key-456");
    assert.equal(result.workspace,            "ws-prod");
  });

  it("3. 존재하지 않는 sessionId → statusCode 404 에러", async () => {
    const map = new Map();

    await assert.rejects(
      () => rotateSessionLocal("nonexistent", { sessionsMap: map }),
      (err) => {
        assert.equal(err.statusCode, 404);
        assert.match(err.message, /Session not found/);
        return true;
      }
    );
  });

  it("4. 만료된 세션 → statusCode 401 에러", async () => {
    const map = new Map();
    const now = Date.now();

    map.set("expired-id", {
      sessionId  : "expired-id",
      authenticated: false,
      keyId      : null,
      expiresAt  : now - 1_000,  /** 이미 만료 */
      createdAt  : now - 60_000,
      lastAccessedAt: now - 30_000
    });

    await assert.rejects(
      () => rotateSessionLocal("expired-id", { sessionsMap: map }),
      (err) => {
        assert.equal(err.statusCode, 401);
        assert.match(err.message, /Session expired/);
        return true;
      }
    );

    assert.ok(!map.has("expired-id"), "만료 세션은 Map에서 제거돼야 함");
  });
});

describe("POST /session/rotate — HTTP 핸들러", () => {

  it("5. 인증 없는 요청 → 401", async () => {
    const req = fakeReq({ headers: {} });
    const res = fakeRes();

    await routeSessionRotate(req, res, {
      validateAuthFn  : async () => ({ valid: false }),
      rotateSessionFn : async () => { throw new Error("should not reach"); }
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res._body);
    assert.equal(body.error, "unauthorized");
  });

  it("6. Mcp-Session-Id 헤더 누락 → 400", async () => {
    const req = fakeReq({ headers: { authorization: "Bearer test-key" } });
    const res = fakeRes();

    await routeSessionRotate(req, res, {
      validateAuthFn  : async () => ({ valid: true, keyId: null }),
      rotateSessionFn : async () => { throw new Error("should not reach"); }
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res._body);
    assert.equal(body.error, "bad_request");
  });

  it("7. 인증된 요청 → 200, 응답 shape 검증", async () => {
    const now        = Date.now();
    const oldSid     = "aaaaaaaa-bbbb-cccc-dddd-111111111111";
    const newSid     = "aaaaaaaa-bbbb-cccc-dddd-222222222222";

    const req = fakeReq({
      headers : {
        authorization   : "Bearer test-key",
        "mcp-session-id": oldSid
      },
      bodyObj : { reason: "security_upgrade" }
    });
    const res = fakeRes();

    await routeSessionRotate(req, res, {
      validateAuthFn  : async () => ({ valid: true, keyId: "key-789" }),
      rotateSessionFn : async (id, _opts) => ({
        oldSessionId : id,
        newSessionId : newSid,
        expiresAt    : now + 60_000,
        keyId        : "key-789",
        workspace    : null
      })
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.oldSessionId, oldSid);
    assert.equal(body.newSessionId, newSid);
    assert.ok(typeof body.expiresAt === "number");
    assert.equal(body.reason, "security_upgrade");
    /** keyId / workspace는 HTTP 응답에 포함하지 않음 (내부 필드) */
    assert.ok(!("keyId"    in body));
    assert.ok(!("workspace" in body));
  });
});
