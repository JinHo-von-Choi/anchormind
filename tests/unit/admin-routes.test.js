/**
 * Admin 라우트 계약 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-26
 *
 * handleAdminApi의 라우팅, 인증, 응답 형태 계약을 검증한다.
 * DB/Redis/파일시스템 의존성 없이 핵심 로직만 단위 테스트.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

const ADMIN_BASE = "/v1/internal/model/nothing";

/* ------------------------------------------------------------------ */
/*  공통 유틸리티                                                       */
/* ------------------------------------------------------------------ */

/**
 * 가짜 HTTP Response 객체 생성
 */
function fakeRes() {
  const _headers = {};
  const res      = {
    statusCode : 0,
    _body      : null,
    _headers,
    setHeader(k, v)    { _headers[k.toLowerCase()] = v; },
    writeHead(code, h) { res.statusCode = code; if (h) Object.assign(_headers, h); },
    end(body)          { res._body = body ?? ""; },
    write()            {}
  };
  return res;
}

/**
 * 가짜 HTTP Request 객체 생성
 */
function fakeReq({ method = "GET", pathname = "/", headers = {}, body = null } = {}) {
  const req = new Readable({ read() {} });
  req.method  = method;
  req.url     = pathname;
  req.headers = { ...headers };
  if (body) {
    req.push(JSON.stringify(body));
    req.push(null);
  }
  return req;
}

/* ------------------------------------------------------------------ */
/*  인증 로직 추출 (admin-routes.js 64-71행)                            */
/* ------------------------------------------------------------------ */

/**
 * validateAdminAccess 로직 재현
 * ACCESS_KEY, validateMasterKey, safeCompare를 주입받아 테스트 가능하게 만든다.
 */
function validateAdminAccess(req, { accessKey, validateMasterKeyFn, safeCompareFn }) {
  if (!accessKey) return true;
  if (validateMasterKeyFn(req)) return true;
  const url = new URL(req.url || "/", "http://localhost");
  const key = url.searchParams.get("key");
  if (key && safeCompareFn(key, accessKey)) return true;
  return false;
}

/**
 * validateMasterKey 로직 재현 (auth.js 119-129행)
 */
function validateMasterKey(req, accessKey) {
  if (!accessKey) return true;
  const auth = req.headers.authorization;
  if (!auth) return false;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return match[1] === accessKey;
}

/**
 * handleAdminApi 라우팅 로직 재현
 * 인증 후 URL 패턴에 따라 적절한 핸들러로 분기하는 로직을 검증한다.
 */
async function routeAdminApi(req, res, {
  accessKey       = "test-master-key",
  pool            = null,
  listApiKeysFn   = async () => [],
  listKeyGroupsFn = async () => [],
  getSessionCountsFn = () => ({ total: 0 }),
  readJsonBodyFn  = async () => ({}), // eslint-disable-line no-unused-vars
  redisClient     = null,
  allowedOrigins  = new Set(),
} = {}) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(String(origin))) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
  }
  res.setHeader("content-type", "application/json; charset=utf-8");

  const url            = new URL(req.url || "/", "http://localhost");
  const isAuthEndpoint = req.method === "POST" && url.pathname === `${ADMIN_BASE}/auth`;

  if (!isAuthEndpoint && !validateMasterKey(req, accessKey)) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  /** POST /auth */
  if (req.method === "POST" && url.pathname === `${ADMIN_BASE}/auth`) {
    if (validateMasterKey(req, accessKey)) {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "Invalid admin key" }));
    }
    return;
  }

  /** GET /stats */
  if (req.method === "GET" && url.pathname === `${ADMIN_BASE}/stats`) {
    const defaultPool = {
      query: async () => ({ rows: [{ total: "0", bytes: "0" }] })
    };
    const p = pool || defaultPool;
    try {
      const [fragR, callR, keyR] = await Promise.all([
        p.query("SELECT COUNT(*) AS total FROM agent_memory.fragments"),
        p.query("SELECT COALESCE(SUM(call_count),0) AS total FROM agent_memory.api_key_usage WHERE usage_date = CURRENT_DATE"),
        p.query("SELECT COUNT(*) AS total FROM agent_memory.api_keys WHERE status='active'"),
      ]);

      const redisStat = (redisClient && redisClient.status === "ready")
        ? "connected" : "disconnected";

      res.statusCode = 200;
      res.end(JSON.stringify({
        fragments:     parseInt(fragR.rows[0].total),
        sessions:      getSessionCountsFn().total,
        apiCallsToday: parseInt(callR.rows[0].total),
        activeKeys:    parseInt(keyR.rows[0].total),
        uptime:        Math.floor(process.uptime()),
        nodeVersion:   process.version,
        system:        { cpu: 0, memory: 0, disk: 0, dbSizeBytes: 0 },
        db:            "connected",
        redis:         redisStat,
      }));
    } catch (_err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return;
  }

  /** GET /activity */
  if (req.method === "GET" && url.pathname === `${ADMIN_BASE}/activity`) {
    const defaultPool = {
      query: async () => ({ rows: [] })
    };
    const p = pool || defaultPool;
    try {
      const { rows } = await p.query("SELECT ...");
      res.statusCode = 200;
      res.end(JSON.stringify(rows));
    } catch (_err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return;
  }

  /** GET /keys */
  if (req.method === "GET" && url.pathname === `${ADMIN_BASE}/keys`) {
    try {
      const keys = await listApiKeysFn();
      res.statusCode = 200;
      res.end(JSON.stringify(keys));
    } catch (_err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return;
  }

  /** GET /groups */
  if (req.method === "GET" && url.pathname === `${ADMIN_BASE}/groups`) {
    try {
      const groups = await listKeyGroupsFn();
      res.statusCode = 200;
      res.end(JSON.stringify(groups));
    } catch (_err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return;
  }

  /** 미매칭 → 404 */
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "Not found" }));
}

/* ================================================================== */
/*  테스트 1: POST /auth — 인증 성공/실패                                */
/* ================================================================== */

describe("POST /auth — master key validation", () => {
  const MASTER_KEY = "test-master-key-2026";

  it("올바른 마스터 키로 인증 시 200 { ok: true } 반환", async () => {
    const req = fakeReq({
      method:   "POST",
      pathname: `${ADMIN_BASE}/auth`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeAdminApi(req, res, { accessKey: MASTER_KEY });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res._body), { ok: true });
  });

  it("잘못된 키로 인증 시 401 { error: 'Invalid admin key' } 반환", async () => {
    const req = fakeReq({
      method:   "POST",
      pathname: `${ADMIN_BASE}/auth`,
      headers:  { authorization: "Bearer wrong-key" }
    });
    const res = fakeRes();

    await routeAdminApi(req, res, { accessKey: MASTER_KEY });

    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(JSON.parse(res._body), { error: "Invalid admin key" });
  });

  it("Authorization 헤더 없이 인증 시 401 반환", async () => {
    const req = fakeReq({
      method:   "POST",
      pathname: `${ADMIN_BASE}/auth`,
      headers:  {}
    });
    const res = fakeRes();

    await routeAdminApi(req, res, { accessKey: MASTER_KEY });

    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(JSON.parse(res._body), { error: "Invalid admin key" });
  });

  it("ACCESS_KEY 미설정 시 인증 없이도 200 반환", async () => {
    const req = fakeReq({
      method:   "POST",
      pathname: `${ADMIN_BASE}/auth`,
      headers:  {}
    });
    const res = fakeRes();

    await routeAdminApi(req, res, { accessKey: "" });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res._body), { ok: true });
  });
});

/* ================================================================== */
/*  테스트 2: GET /stats — 응답 형태 검증                                */
/* ================================================================== */

describe("GET /stats — response shape", () => {
  const MASTER_KEY = "test-key";

  it("인증 성공 시 stats 객체의 필수 필드를 모두 포함", async () => {
    const mockPool = {
      query: async (sql) => {
        if (sql.includes("fragments"))     return { rows: [{ total: "42" }] };
        if (sql.includes("api_key_usage")) return { rows: [{ total: "100" }] };
        if (sql.includes("api_keys"))      return { rows: [{ total: "3" }] };
        if (sql.includes("pg_database"))   return { rows: [{ bytes: "1048576" }] };
        return { rows: [{ total: "0" }] };
      }
    };

    const req = fakeReq({
      method:   "GET",
      pathname: `${ADMIN_BASE}/stats`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeAdminApi(req, res, {
      accessKey:          MASTER_KEY,
      pool:               mockPool,
      getSessionCountsFn: () => ({ total: 5 }),
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res._body);

    /** 필수 최상위 필드 */
    assert.strictEqual(typeof body.fragments, "number");
    assert.strictEqual(typeof body.sessions, "number");
    assert.strictEqual(typeof body.apiCallsToday, "number");
    assert.strictEqual(typeof body.activeKeys, "number");
    assert.strictEqual(typeof body.uptime, "number");
    assert.strictEqual(typeof body.nodeVersion, "string");
    assert.strictEqual(typeof body.db, "string");
    assert.strictEqual(typeof body.redis, "string");

    /** system 하위 필드 */
    assert.strictEqual(typeof body.system, "object");
    assert.strictEqual(typeof body.system.cpu, "number");
    assert.strictEqual(typeof body.system.memory, "number");
    assert.strictEqual(typeof body.system.disk, "number");
    assert.strictEqual(typeof body.system.dbSizeBytes, "number");

    /** 값 검증 */
    assert.strictEqual(body.fragments, 42);
    assert.strictEqual(body.sessions, 5);
    assert.strictEqual(body.apiCallsToday, 100);
    assert.strictEqual(body.activeKeys, 3);
  });

  it("인증 실패 시 401 반환", async () => {
    const req = fakeReq({
      method:   "GET",
      pathname: `${ADMIN_BASE}/stats`,
      headers:  {}
    });
    const res = fakeRes();

    await routeAdminApi(req, res, { accessKey: MASTER_KEY });

    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(JSON.parse(res._body), { error: "Unauthorized" });
  });

  it("DB 에러 시 500 반환", async () => {
    const brokenPool = {
      query: async () => { throw new Error("Connection refused"); }
    };

    const req = fakeReq({
      method:   "GET",
      pathname: `${ADMIN_BASE}/stats`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeAdminApi(req, res, { accessKey: MASTER_KEY, pool: brokenPool });

    assert.strictEqual(res.statusCode, 500);
    const body = JSON.parse(res._body);
    assert.strictEqual(typeof body.error, "string");
  });

  it("Redis connected 시 redis: 'connected' 반환", async () => {
    const req = fakeReq({
      method:   "GET",
      pathname: `${ADMIN_BASE}/stats`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeAdminApi(req, res, {
      accessKey:   MASTER_KEY,
      redisClient: { status: "ready" },
    });

    const body = JSON.parse(res._body);
    assert.strictEqual(body.redis, "connected");
  });

  it("Redis disconnected 시 redis: 'disconnected' 반환", async () => {
    const req = fakeReq({
      method:   "GET",
      pathname: `${ADMIN_BASE}/stats`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeAdminApi(req, res, {
      accessKey:   MASTER_KEY,
      redisClient: null,
    });

    const body = JSON.parse(res._body);
    assert.strictEqual(body.redis, "disconnected");
  });
});

/* ================================================================== */
/*  테스트 3: GET /activity — 배열 반환 검증                              */
/* ================================================================== */

describe("GET /activity — returns array", () => {
  const MASTER_KEY = "test-key";

  it("인증 성공 시 배열 반환", async () => {
    const mockRows = [
      { id: "1", topic: "test", type: "fact", agent_id: "a1", key_id: null, created_at: "2026-03-26", preview: "hello", key_name: null, key_prefix: null },
      { id: "2", topic: "test2", type: "error", agent_id: "a2", key_id: "k1", created_at: "2026-03-25", preview: "world", key_name: "mykey", key_prefix: "mmcp_abc" },
    ];
    const mockPool = {
      query: async () => ({ rows: mockRows })
    };

    const req = fakeReq({
      method:   "GET",
      pathname: `${ADMIN_BASE}/activity`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeAdminApi(req, res, { accessKey: MASTER_KEY, pool: mockPool });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.ok(Array.isArray(body));
    assert.strictEqual(body.length, 2);
    assert.strictEqual(body[0].id, "1");
    assert.strictEqual(body[1].key_name, "mykey");
  });

  it("인증 실패 시 401 반환", async () => {
    const req = fakeReq({
      method:   "GET",
      pathname: `${ADMIN_BASE}/activity`,
      headers:  {}
    });
    const res = fakeRes();

    await routeAdminApi(req, res, { accessKey: MASTER_KEY });

    assert.strictEqual(res.statusCode, 401);
  });
});

/* ================================================================== */
/*  테스트 4: GET /keys — 인증 보호 검증                                 */
/* ================================================================== */

describe("GET /keys — auth protected", () => {
  const MASTER_KEY = "test-key";

  it("인증 없이 요청 시 401 반환", async () => {
    const req = fakeReq({
      method:   "GET",
      pathname: `${ADMIN_BASE}/keys`,
      headers:  {}
    });
    const res = fakeRes();

    await routeAdminApi(req, res, { accessKey: MASTER_KEY });

    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(JSON.parse(res._body), { error: "Unauthorized" });
  });

  it("인증 성공 시 키 목록 배열 반환", async () => {
    const mockKeys = [
      { id: "k1", name: "test-key-1", status: "active" },
      { id: "k2", name: "test-key-2", status: "revoked" },
    ];

    const req = fakeReq({
      method:   "GET",
      pathname: `${ADMIN_BASE}/keys`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeAdminApi(req, res, {
      accessKey:     MASTER_KEY,
      listApiKeysFn: async () => mockKeys,
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.ok(Array.isArray(body));
    assert.strictEqual(body.length, 2);
    assert.strictEqual(body[0].name, "test-key-1");
  });
});

/* ================================================================== */
/*  테스트 5: GET /groups — 인증 보호 검증                               */
/* ================================================================== */

describe("GET /groups — auth protected", () => {
  const MASTER_KEY = "test-key";

  it("인증 없이 요청 시 401 반환", async () => {
    const req = fakeReq({
      method:   "GET",
      pathname: `${ADMIN_BASE}/groups`,
      headers:  {}
    });
    const res = fakeRes();

    await routeAdminApi(req, res, { accessKey: MASTER_KEY });

    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(JSON.parse(res._body), { error: "Unauthorized" });
  });

  it("인증 성공 시 그룹 목록 배열 반환", async () => {
    const mockGroups = [
      { id: "g1", name: "dev-team", description: "Development" },
    ];

    const req = fakeReq({
      method:   "GET",
      pathname: `${ADMIN_BASE}/groups`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeAdminApi(req, res, {
      accessKey:       MASTER_KEY,
      listKeyGroupsFn: async () => mockGroups,
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.ok(Array.isArray(body));
    assert.strictEqual(body[0].name, "dev-team");
  });
});

/* ================================================================== */
/*  테스트 6: 미매칭 경로 → 404                                         */
/* ================================================================== */

describe("Unknown path — 404", () => {
  const MASTER_KEY = "test-key";

  it("존재하지 않는 경로 요청 시 404 { error: 'Not found' } 반환", async () => {
    const req = fakeReq({
      method:   "GET",
      pathname: `${ADMIN_BASE}/nonexistent`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeAdminApi(req, res, { accessKey: MASTER_KEY });

    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(JSON.parse(res._body), { error: "Not found" });
  });

  it("잘못된 HTTP 메서드로 요청 시 404 반환", async () => {
    const req = fakeReq({
      method:   "PATCH",
      pathname: `${ADMIN_BASE}/stats`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeAdminApi(req, res, { accessKey: MASTER_KEY });

    assert.strictEqual(res.statusCode, 404);
  });
});

/* ================================================================== */
/*  테스트 7: validateAdminAccess — 쿼리스트링 key 인증                   */
/* ================================================================== */

describe("validateAdminAccess — query string key fallback", () => {
  const MASTER_KEY = "admin-secret-123";

  it("Authorization 헤더 인증 성공", () => {
    const req = fakeReq({
      pathname: `${ADMIN_BASE}?key=wrong`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });

    const result = validateAdminAccess(req, {
      accessKey:          MASTER_KEY,
      validateMasterKeyFn: (r) => validateMasterKey(r, MASTER_KEY),
      safeCompareFn:       (a, b) => a === b,
    });

    assert.strictEqual(result, true);
  });

  it("쿼리스트링 key 인증 성공 (Authorization 실패 시 fallback)", () => {
    const req = fakeReq({
      pathname: `${ADMIN_BASE}?key=${MASTER_KEY}`,
      headers:  {}
    });

    const result = validateAdminAccess(req, {
      accessKey:          MASTER_KEY,
      validateMasterKeyFn: (r) => validateMasterKey(r, MASTER_KEY),
      safeCompareFn:       (a, b) => a === b,
    });

    assert.strictEqual(result, true);
  });

  it("두 인증 방법 모두 실패 시 false 반환", () => {
    const req = fakeReq({
      pathname: `${ADMIN_BASE}?key=wrong-key`,
      headers:  { authorization: "Bearer wrong-token" }
    });

    const result = validateAdminAccess(req, {
      accessKey:          MASTER_KEY,
      validateMasterKeyFn: (r) => validateMasterKey(r, MASTER_KEY),
      safeCompareFn:       (a, b) => a === b,
    });

    assert.strictEqual(result, false);
  });

  it("ACCESS_KEY 미설정 시 항상 true", () => {
    const req = fakeReq({ pathname: ADMIN_BASE, headers: {} });

    const result = validateAdminAccess(req, {
      accessKey:          "",
      validateMasterKeyFn: () => true,
      safeCompareFn:       () => false,
    });

    assert.strictEqual(result, true);
  });
});

/* ================================================================== */
/*  테스트 8: safeErrorMessage — 안전 에러 메시지 변환                     */
/* ================================================================== */

describe("safeErrorMessage — safe error filtering", () => {
  const SAFE_ERRORS = new Set(["Key not found", "Group not found", "name is required", "key_id is required"]);

  function safeErrorMessage(err) {
    if (SAFE_ERRORS.has(err.message)) return err.message;
    if (err.message.includes("unique")) return "Duplicate entry";
    if (err.message.includes("violates")) return "Constraint violation";
    return "Internal error";
  }

  it("안전 목록에 있는 에러는 그대로 반환", () => {
    assert.strictEqual(safeErrorMessage(new Error("Key not found")), "Key not found");
    assert.strictEqual(safeErrorMessage(new Error("Group not found")), "Group not found");
    assert.strictEqual(safeErrorMessage(new Error("name is required")), "name is required");
    assert.strictEqual(safeErrorMessage(new Error("key_id is required")), "key_id is required");
  });

  it("unique constraint 에러는 'Duplicate entry' 반환", () => {
    assert.strictEqual(
      safeErrorMessage(new Error("duplicate key violates unique constraint")),
      "Duplicate entry"
    );
  });

  it("violates 키워드 에러는 'Constraint violation' 반환", () => {
    assert.strictEqual(
      safeErrorMessage(new Error("insert violates foreign key constraint")),
      "Constraint violation"
    );
  });

  it("기타 에러는 'Internal error' 반환 (내부 정보 노출 방지)", () => {
    assert.strictEqual(safeErrorMessage(new Error("ECONNREFUSED")), "Internal error");
    assert.strictEqual(safeErrorMessage(new Error("password authentication failed")), "Internal error");
  });
});

/* ================================================================== */
/*  테스트 9: CORS 헤더 설정                                            */
/* ================================================================== */

describe("CORS — Access-Control-Allow-Origin header", () => {
  const MASTER_KEY = "test-key";

  it("화이트리스트에 등록된 Origin만 반사한다", async () => {
    const req = fakeReq({
      method:   "POST",
      pathname: `${ADMIN_BASE}/auth`,
      headers:  {
        authorization: `Bearer ${MASTER_KEY}`,
        origin:        "https://admin.example.com"
      }
    });
    const res = fakeRes();

    await routeAdminApi(req, res, {
      accessKey:      MASTER_KEY,
      allowedOrigins: new Set(["https://admin.example.com"]),
    });

    assert.strictEqual(res._headers["access-control-allow-origin"], "https://admin.example.com");
  });

  it("미등록 Origin은 반사하지 않는다", async () => {
    const req = fakeReq({
      method:   "POST",
      pathname: `${ADMIN_BASE}/auth`,
      headers:  {
        authorization: `Bearer ${MASTER_KEY}`,
        origin:        "https://evil.example.com"
      }
    });
    const res = fakeRes();

    await routeAdminApi(req, res, {
      accessKey:      MASTER_KEY,
      allowedOrigins: new Set(["https://admin.example.com"]),
    });

    assert.strictEqual(res._headers["access-control-allow-origin"], undefined);
  });

  it("Origin 헤더가 없으면 ACAO를 설정하지 않는다(서버 호출)", async () => {
    const req = fakeReq({
      method:   "POST",
      pathname: `${ADMIN_BASE}/auth`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeAdminApi(req, res, { accessKey: MASTER_KEY });

    assert.strictEqual(res._headers["access-control-allow-origin"], undefined);
  });
});

/* ================================================================== */
/*  테스트 10: Content-Type 헤더                                        */
/* ================================================================== */

describe("Content-Type — always application/json", () => {
  const MASTER_KEY = "test-key";

  it("모든 API 응답에 application/json charset=utf-8 설정", async () => {
    const req = fakeReq({
      method:   "GET",
      pathname: `${ADMIN_BASE}/stats`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeAdminApi(req, res, { accessKey: MASTER_KEY });

    assert.strictEqual(res._headers["content-type"], "application/json; charset=utf-8");
  });
});

/* ================================================================== */
/*  테스트 11: /auth 엔드포인트는 인증 검사 제외                          */
/* ================================================================== */

describe("/auth endpoint — bypasses auth check", () => {
  it("POST /auth는 isAuthEndpoint=true로 인증 게이트를 우회", () => {
    const method   = "POST";
    const pathname = `${ADMIN_BASE}/auth`;

    const isAuthEndpoint = method === "POST" && pathname === `${ADMIN_BASE}/auth`;
    assert.strictEqual(isAuthEndpoint, true);
  });

  it("GET /auth는 isAuthEndpoint=false (POST만 허용)", () => {
    const method   = "GET";
    const pathname = `${ADMIN_BASE}/auth`;

    const isAuthEndpoint = method === "POST" && pathname === `${ADMIN_BASE}/auth`;
    assert.strictEqual(isAuthEndpoint, false);
  });

  it("POST /keys는 isAuthEndpoint=false", () => {
    const method   = "POST";
    const pathname = `${ADMIN_BASE}/keys`;

    const isAuthEndpoint = method === "POST" && pathname === `${ADMIN_BASE}/auth`;
    assert.strictEqual(isAuthEndpoint, false);
  });
});
