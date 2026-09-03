/**
 * MCP protocol-version 자가치유 — 실제 핸들러 통합 테스트
 *
 * 작성자: codex (계약 위임 구현)
 * 작성일: 2026-07-26
 *
 * 배경 (findings/anchormind-protocol-mismatch-contract-20260725.md):
 *   서버 재기동 시 in-memory streamableSessions Map은 비워지지만 Redis 세션은
 *   preserveRedis:true로 살아남는다. 이때 Redis 복원 경로(lib/sessions.js
 *   validateStreamableSession)는 `...redisSession` 스프레드로 전 필드를 복원하므로
 *   stale negotiatedVersion이 되살아난다. 그 값이 클라이언트의
 *   MCP-Protocol-Version 헤더와 다르면 구 코드는 이후 모든 요청을 HTTP 400
 *   -32000 "Protocol version mismatch"로 영구 거부했다 — 재initialize 전까지
 *   회복 불가능한 장애였다.
 *
 * 이 파일은 tests/unit/mcp-protocol-version.test.js / mcp-404-session.test.js의
 * "분기 로직을 복사한 순수 함수" 검증의 공백을 메운다: 실제 initialize →
 * (fake) Redis 저장 → in-memory Map 초기화(재기동 시뮬레이션) → 실제 Redis 복원 →
 * 실제 protocol validation까지 mcp-handler.js / sessions.js의 진짜 코드로 수행한다.
 *
 * 모킹 대상은 lib/redis.js 단 하나뿐이다 (실제 ioredis 연결 없이 세션 저장/조회/
 * 삭제를 인메모리로 재현). saveSession/getSession/deleteSession/bindTokenToSession/
 * getSessionIdByToken은 sessions.js·mcp-handler.js가 상수 redisClient를 직접
 * 참조하므로 `__setRedisClientForTest`로는 가로챌 수 없다 — 모듈 자체를 mock한다.
 * 인증은 master key(MEMENTO_ACCESS_KEY) 경로를 사용해 DB(admin/ApiKeyStore.js,
 * getGroupKeyIds)와 rate-limit 캐시(getRateLimitUsageCached)가 전혀 호출되지
 * 않도록 한다(keyId=null이면 두 경로 모두 가드로 스킵됨) — 그 외 로직은 전부 실물이다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

/**
 * config.js는 최초 import 시점의 process.env를 그대로 캡처하므로, 이 값들은
 * 반드시 아래의 동적 import보다 먼저 설정되어야 한다 (정적 import는 호이스팅되어
 * 파일 최상단에서 먼저 평가되므로, config.js를 정적 import하는 대신 이후 모든
 * 관련 모듈을 동적 import로 불러온다).
 */
process.env.MEMENTO_ACCESS_KEY      = "reanchor-it-master-key-20260726";
process.env.REDIS_ENABLED           = "true";
process.env.MEMENTO_METRICS_DEFAULT = "off";

/** ------------------------------------------------------------------
 *  인메모리 fake Redis — lib/redis.js 전체를 대체한다.
 *  세션 관련 5개 함수(getSession/saveSession/deleteSession/bindTokenToSession/
 *  getSessionIdByToken)만 실제와 동등하게 동작하고, 나머지는 mcp-handler.js의
 *  import 그래프(jsonrpc.js → tools/index.js → 각 도구 구현)가 링크 단계에서
 *  요구하는 이름을 전부 채우기 위한 무해한 스텁이다.
 * ------------------------------------------------------------------ */
const _store = new Map();

function _rawGet(key) {
  const entry = _store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _store.delete(key);
    return null;
  }
  return entry.value;
}

function _rawSet(key, value, ttlSeconds) {
  _store.set(key, { value, expiresAt: Date.now() + Math.max(ttlSeconds, 1) * 1000 });
}

const fakeRedisClient = {
  status: "fake",
  get: async () => null, set: async () => "OK", setex: async () => "OK", del: async () => 0,
  lpush: async () => 0, rpush: async () => 0, rpop: async () => null, lpop: async () => null,
  rpoplpush: async () => null, lrem: async () => 0,
  keys: async () => [], scan: async () => ["0", []],
  llen: async () => 0, expire: async () => 1, ping: async () => "PONG",
  hset: async () => 1, hgetall: async () => ({}),
  quit: async () => {}, disconnect: () => {},
  on: () => {}, once: () => {}, removeListener: () => {}
};

const fakeRedisModule = {
  redisClient: fakeRedisClient,
  async checkRedisHealth() { return { healthy: true, message: "fake" }; },
  getSessionKey: (id) => `session:${id}`,
  getOAuthCodeKey: (c) => `oauth:code:${c}`,
  getOAuthTokenKey: (t) => `oauth:token:${t}`,
  getDocCacheKey: (p) => `cache:doc:${p}`,
  getDbCacheKey: () => "cache:db:fake",
  getTokenSessionKey: (t) => `token:session:${t}`,

  /** 세션 저장/조회/삭제 — 이 테스트가 실제로 의존하는 부분 */
  async saveSession(sessionId, sessionData, ttlSeconds) {
    _rawSet(`session:${sessionId}`, JSON.stringify(sessionData), ttlSeconds);
    return true;
  },
  async getSession(sessionId) {
    const raw = _rawGet(`session:${sessionId}`);
    return raw ? JSON.parse(raw) : null;
  },
  async deleteSession(sessionId) {
    _store.delete(`session:${sessionId}`);
    return true;
  },
  async extendSessionTTL() { return true; },

  /** 토큰-세션 역인덱스 */
  async bindTokenToSession(tokenKey, sessionId, ttlSeconds) {
    _rawSet(`token:session:${tokenKey}`, sessionId, ttlSeconds);
    return true;
  },
  async getSessionIdByToken(tokenKey) {
    return _rawGet(`token:session:${tokenKey}`);
  },
  async unbindToken(tokenKey) {
    _store.delete(`token:session:${tokenKey}`);
    return true;
  },

  /** OAuth / 캐싱 / 큐 — 이 테스트 경로에서는 호출되지 않는 무해한 스텁 */
  async saveOAuthCode() { return true; },
  async consumeOAuthCode() { return null; },
  async saveOAuthToken() { return true; },
  async getOAuthToken() { return null; },
  async deleteOAuthToken() { return true; },
  async extendOAuthToken() { return true; },
  async cacheDocument() { return true; },
  async getCachedDocument() { return null; },
  async invalidateDocumentCache() { return true; },
  async cacheDbQuery() { return true; },
  async getCachedDbQuery() { return null; },
  async invalidateCacheByPattern() { return 0; },
  async pushToQueue() { return true; },
  async pushToQueuePriority() { return true; },
  async popFromQueue() { return null; },
  __setRedisClientForTest() {},
  async popFromQueueReliable() { return null; },
  async ackQueueItem() { return true; },
  async requeueProcessing() { return 0; },
  async pushToQueueDead() { return true; },
  async getQueueLength() { return 0; },
  async closeRedis() {},
  async connectRedis() {},
  async disconnectRedis() {},
  async setBatchJobStatus() { return true; },
  async getBatchJobStatus() { return null; }
};

mock.module("../../lib/redis.js", {
  namedExports: fakeRedisModule,
  defaultExport: fakeRedisClient
});

const { handleMcpPost }                         = await import("../../lib/handlers/mcp-handler.js");
const { streamableSessions, createStreamableSessionWithId } = await import("../../lib/sessions.js");
const { protocolVersionReanchoredTotal }        = await import("../../lib/metrics.js");
const { MemoryManager }                         = await import("../../lib/memory/MemoryManager.js");

const MASTER_KEY   = process.env.MEMENTO_ACCESS_KEY;
const rateLimiter  = { allow: () => true };
const SUPPORTED    = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** ------------------------------------------------------------------
 *  req/res 페이크 — handleMcpPost가 요구하는 최소 인터페이스
 * ------------------------------------------------------------------ */

function makeReq(bodyObj, headers = {}) {
  const req = new Readable({ read() {} });
  req.push(Buffer.from(JSON.stringify(bodyObj)));
  req.push(null);
  req.headers = { host: "localhost:57332", authorization: `Bearer ${MASTER_KEY}`, ...headers };
  req.method  = "POST";
  req.url     = "/mcp";
  req.socket  = { remoteAddress: "127.0.0.1", encrypted: false };
  return req;
}

function makeRes() {
  const headers = {};
  const res = {
    statusCode: 200,
    body      : undefined,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    getHeader(name) { return headers[name.toLowerCase()]; },
    end(data) { res.body = data; },
    writeHead(code, hdrs) {
      res.statusCode = code;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = v;
    },
    _headers: headers
  };
  return res;
}

function parseBody(res) {
  if (res.body === undefined || res.body === null) return null;
  try { return JSON.parse(res.body); } catch { return res.body; }
}

let _seq = 0;

async function initializeSession({ protocolVersion = "2025-03-26", headers = {} } = {}) {
  const req = makeReq(
    { jsonrpc: "2.0", id: ++_seq, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "it-client", version: "1.0" } } },
    headers
  );
  const res = makeRes();
  await handleMcpPost(req, res, process.hrtime.bigint(), rateLimiter);
  assert.strictEqual(res.statusCode, 200, `initialize 실패: ${res.body}`);
  const sessionId = res._headers["mcp-session-id"];
  assert.ok(sessionId, "MCP-Session-Id 헤더가 있어야 한다");
  return { sessionId, body: parseBody(res) };
}

async function callToolsList(sessionId, headers = {}) {
  const req = makeReq({ jsonrpc: "2.0", id: ++_seq, method: "tools/list", params: {} }, { "mcp-session-id": sessionId, ...headers });
  const res = makeRes();
  await handleMcpPost(req, res, process.hrtime.bigint(), rateLimiter);
  return { res, body: parseBody(res) };
}

async function callRecall(sessionId, args, headers = {}) {
  const req = makeReq(
    { jsonrpc: "2.0", id: ++_seq, method: "tools/call", params: { name: "recall", arguments: args } },
    { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-03-26", ...headers }
  );
  const res = makeRes();
  await handleMcpPost(req, res, process.hrtime.bigint(), rateLimiter);
  return { res, body: parseBody(res) };
}

/* ==================================================================== */
/*  테스트                                                                */
/* ==================================================================== */

describe("MCP protocol-version 자가치유 — 실제 핸들러 통합 테스트", () => {

  beforeEach(() => {
    /**
     * 각 테스트를 완전히 격리한다. master key 인증은 항상 동일한 토큰 문자열이므로
     * deriveTokenKey의 토큰-세션 재사용 기능(claude.ai 커넥터 대응, _createInitializeSession
     * 참고)이 그대로 두면 테스트마다 같은 세션을 재사용해버려 "매 initialize는 새
     * 세션"이라는 이 테스트 스위트의 전제가 깨진다. in-memory Map과 fake Redis를
     * 모두 비워 매 테스트가 독립적인 세션에서 출발하도록 한다.
     */
    streamableSessions.clear();
    _store.clear();
  });

  it("비master 세션은 위조한 _isMaster와 allWorkspaces 요청을 실제 도구 경계에서 거부", async () => {
    const sessionId = `non-master-${++_seq}`;
    await createStreamableSessionWithId(
      sessionId,
      true,
      "key-a",
      ["key-a"],
      ["read"],
      null,
      null,
      "2025-03-26",
      false
    );

    const mgr = MemoryManager.getInstance();
    const originalRecall = mgr.recall;
    const recallSpy = mock.fn(async () => {
      throw new Error("recall must not be reached");
    });
    mgr.recall = recallSpy;

    try {
      const { res, body } = await callRecall(sessionId, {
        keywords: ["synthetic"], allWorkspaces: true, _isMaster: true
      });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(body?.result?.isError, true);
      const payload = JSON.parse(body.result.content[0].text);
      assert.strictEqual(payload.success, false);
      assert.strictEqual(payload.error, "allWorkspaces requires master authentication");
      assert.strictEqual(recallSpy.mock.callCount(), 0, "권한 거부 전에 recall을 실행하면 안 된다");
    } finally {
      mgr.recall = originalRecall;
    }
  });

  it("I3 (핵심 회귀): negotiatedVersion=2025-03-26 세션에 헤더 2025-06-18로 tools/call → 200 (구 400 mismatch 폐기, R1)", async () => {
    const { sessionId } = await initializeSession({ protocolVersion: "2025-03-26" });

    const { res, body } = await callToolsList(sessionId, { "mcp-protocol-version": "2025-06-18" });

    assert.strictEqual(res.statusCode, 200, `mismatch reanchor 실패: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body?.result?.tools), "tools/list 결과가 정상 반환되어야 한다");

    const session = streamableSessions.get(sessionId);
    assert.strictEqual(session.negotiatedVersion, "2025-06-18", "세션이 헤더 값으로 재앵커링되어야 한다");
  });

  it("I2: 재기동 시뮬레이션(streamableSessions.clear 대응 — 개별 delete) 후 동일 sessionId 호출 → 200 (Redis 보존)", async () => {
    const { sessionId } = await initializeSession({ protocolVersion: "2025-06-18" });

    /** 재기동 시뮬레이션: in-memory Map만 비운다. Redis(fake)는 그대로 보존된다. */
    streamableSessions.delete(sessionId);

    const { res, body } = await callToolsList(sessionId, { "mcp-protocol-version": "2025-06-18" });
    assert.strictEqual(res.statusCode, 200, `재기동 후 세션 복원 실패: ${JSON.stringify(body)}`);
  });

  it("구 Redis master 세션은 현재 인증으로 isMaster를 안전하게 재앵커링", async () => {
    const { sessionId } = await initializeSession({ protocolVersion: "2025-03-26" });

    const legacy = await fakeRedisModule.getSession(sessionId);
    delete legacy.isMaster;
    await fakeRedisModule.saveSession(sessionId, legacy, 3600);
    streamableSessions.delete(sessionId);

    const { res, body } = await callToolsList(sessionId, {
      "mcp-protocol-version": "2025-03-26"
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(body));
    assert.strictEqual(streamableSessions.get(sessionId)?.isMaster, true);
    assert.strictEqual((await fakeRedisModule.getSession(sessionId))?.isMaster, true);
  });

  it("I13: Redis에 stale negotiatedVersion(null)이 저장돼 있어도 복원 시 요청 헤더로 즉시 재앵커링된다 (R2)", async () => {
    const { sessionId } = await initializeSession({ protocolVersion: "2025-03-26" });

    /** 구버전 버그 재현: Redis에 저장된 negotiatedVersion을 인위적으로 null로 되돌린다 */
    const raw = await fakeRedisModule.getSession(sessionId);
    raw.negotiatedVersion = null;
    await fakeRedisModule.saveSession(sessionId, raw, 3600);

    streamableSessions.delete(sessionId); // 재기동 시뮬레이션

    const { res } = await callToolsList(sessionId, { "mcp-protocol-version": "2025-11-25" });
    assert.strictEqual(res.statusCode, 200);

    const restored = streamableSessions.get(sessionId);
    assert.strictEqual(restored.negotiatedVersion, "2025-11-25", "Redis 복원 직후 헤더 값으로 재앵커링되어야 한다 (R2)");

    const persisted = await fakeRedisModule.getSession(sessionId);
    assert.strictEqual(persisted.negotiatedVersion, "2025-11-25", "재앵커링된 값이 Redis에도 즉시 반영되어야 한다");
  });

  it("검증 순서 결함 회귀: 재기동 복원 요청의 미지원 헤더는 400으로 거부되고, 거부 전에 세션/Redis/메트릭에 새겨지지 않는다", async () => {
    /**
     * 독립 재검토에서 확정된 결함: _resolveExistingSession이 검증 전 raw 헤더값
     * (fallbackProtoValue)을 validateStreamableSession/createStreamableSessionWithId에
     * 넘겼다. 실제 지원 여부 검사(_validateProtocolVersion)는 호출 순서상 그 뒤에
     * 실행되므로, 미지원 값이 거부되기 *전에* 이미 세션 negotiatedVersion·Redis·
     * Prometheus reanchor 메트릭 label에 새겨졌다(무한 카디널리티 위험 포함).
     * 이 테스트는 세 가지 부작용이 전혀 발생하지 않음을 증명한다.
     */
    const { sessionId } = await initializeSession({ protocolVersion: "2025-03-26" });

    /** 재기동 시뮬레이션: in-memory Map만 비운다 — fake Redis는 "2025-03-26"을 보존 */
    streamableSessions.delete(sessionId);

    const before = await protocolVersionReanchoredTotal.get();
    const totalBefore = before.values.reduce((sum, v) => sum + v.value, 0);

    for (const badHeader of ["2099-01-01", "not-a-real-version"]) {
      const { res, body } = await callToolsList(sessionId, { "mcp-protocol-version": badHeader });

      // (a) 400으로 거부되어야 한다 (기존 _validateProtocolVersion 경로, 변경 없음)
      assert.strictEqual(res.statusCode, 400, `${badHeader} → 400이어야 한다: ${JSON.stringify(body)}`);
      assert.ok(body.error.message.includes("Unsupported protocol version"), body.error.message);

      // (b) 세션 negotiatedVersion이 미지원 값으로 오염되지 않아야 한다
      const session = streamableSessions.get(sessionId);
      assert.ok(session, "거부되더라도 세션 자체는 복원되어 있어야 한다");
      assert.notStrictEqual(session.negotiatedVersion, badHeader, "미지원 헤더 값이 세션에 새겨지면 안 된다");
      assert.strictEqual(session.negotiatedVersion, "2025-03-26", "negotiatedVersion은 원래 값을 유지해야 한다");

      // (b') fake Redis에도 미지원 값이 영속되면 안 된다
      const persisted = await fakeRedisModule.getSession(sessionId);
      assert.notStrictEqual(persisted?.negotiatedVersion, badHeader, "미지원 헤더 값이 Redis에 영속되면 안 된다");
      assert.strictEqual(persisted?.negotiatedVersion, "2025-03-26", "Redis의 negotiatedVersion도 원래 값을 유지해야 한다");

      // 다음 반복을 위해 다시 재기동 상태로 되돌린다 (in-memory만 비움)
      streamableSessions.delete(sessionId);
    }

    // (c) reanchor 메트릭이 증가하지 않아야 한다 — 미지원 값으로 인한 label 카디널리티 오염 금지
    const after = await protocolVersionReanchoredTotal.get();
    const totalAfter = after.values.reduce((sum, v) => sum + v.value, 0);
    assert.strictEqual(totalAfter, totalBefore, "미지원 헤더는 reanchor 메트릭을 증가시키면 안 된다");
    assert.ok(
      !after.values.some(v => v.labels.to === "2099-01-01" || v.labels.to === "not-a-real-version"),
      "미지원 헤더 값이 reanchor 메트릭의 'to' label로 기록되면 안 된다 (카디널리티 오염 금지)"
    );
  });

  it("R3: initialize 직후 negotiatedVersion이 Redis에 즉시 영속된다 (다음 요청까지 지연되지 않음)", async () => {
    const { sessionId } = await initializeSession({ protocolVersion: "2025-11-25" });
    const persisted = await fakeRedisModule.getSession(sessionId);
    assert.strictEqual(persisted.negotiatedVersion, "2025-11-25", "initialize 응답 직후 Redis에 즉시 저장되어야 한다");
  });

  it("A1 (회귀 가드): SUPPORTED_PROTOCOL_VERSIONS의 어떤 값도 400을 유발하지 않는다", async () => {
    const { sessionId } = await initializeSession({ protocolVersion: "2025-03-26" });
    for (const ver of SUPPORTED) {
      const { res, body } = await callToolsList(sessionId, { "mcp-protocol-version": ver });
      assert.notStrictEqual(res.statusCode, 400, `${ver} → 400 발생: ${JSON.stringify(body)}`);
    }
  });

  it("C1: 세션 부재(Session not found) + 인증 유효 → 200 자동복구 (클라이언트에는 투명)", async () => {
    const req = makeReq(
      { jsonrpc: "2.0", id: ++_seq, method: "tools/list", params: {} },
      { "mcp-session-id": "ghost-but-authenticated-session", "mcp-protocol-version": "2025-06-18" }
    );
    const res = makeRes();
    await handleMcpPost(req, res, process.hrtime.bigint(), rateLimiter);

    assert.strictEqual(res.statusCode, 200, `자동복구 실패: ${res.body}`);
    const session = streamableSessions.get("ghost-but-authenticated-session");
    assert.ok(session, "세션이 생성되어야 한다");
    assert.strictEqual(session.negotiatedVersion, "2025-06-18", "자동복구 세션도 헤더 값으로 즉시 채워져야 한다 (R2)");
  });
});
