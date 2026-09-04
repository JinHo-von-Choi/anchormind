/**
 * SessionLinker 토큰 재사용 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-19
 *
 * deriveTokenKey(lib/handlers/mcp-handler.js:38)
 * bindTokenToSession / getSessionIdByToken / getTokenSessionKey(lib/redis.js:258~288)
 * 의 핵심 동작을 DB·Redis 없이 검증한다.
 *
 * 문제 배경 (v2.9.0 CHANGELOG):
 *   claude.ai 커넥터가 Mcp-Session-Id 헤더를 버리는 경우 매 initialize마다
 *   새 세션이 생성되는 문제 → 토큰 기반 역인덱스(token_session:{key})로 해결.
 *
 * 검증 항목:
 * 1. deriveTokenKey — Authorization Bearer 헤더 추출
 * 2. deriveTokenKey — memento-access-key 헤더 추출
 * 3. deriveTokenKey — initialize.params.accessKey 추출
 * 4. deriveTokenKey — 토큰 원문이 아닌 sha256 16자 해시 사용
 * 5. deriveTokenKey — keyId 네임스페이스 포함 (`ns:hash`)
 * 6. deriveTokenKey — 동일 토큰 + 동일 keyId → 동일 tokenKey
 * 7. deriveTokenKey — 동일 토큰 + 다른 keyId → 다른 tokenKey (cross-tenant 차단)
 * 8. deriveTokenKey — 인증 정보 없으면 null 반환
 * 9. bindTokenToSession — Redis setex 호출 검증
 * 10. getSessionIdByToken — 존재 시 세션 ID 반환
 * 11. getSessionIdByToken — 키 없으면 null 반환
 * 12. 토큰 유실 후 재시도 — 동일 토큰 두 번째 initialize에서 기존 세션 재사용
 * 13. getTokenSessionKey — `token_session:` prefix 포함
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

import { deriveTokenKey } from "../../lib/handlers/mcp-handler.js";
import { getTokenSessionKey } from "../../lib/redis.js";

/* ── Redis stub ── */
function makeRedisStub() {
  const store = new Map();
  return {
    store,
    status: "ready",
    async setex(key, ttl, value) { store.set(key, { value, ttl }); },
    async get(key) {
      const entry = store.get(key);
      return entry ? entry.value : null;
    },
    async del(key) { store.delete(key); },
  };
}

/* bindTokenToSession / getSessionIdByToken 인라인 재현
   (실 함수는 module-level redisClient를 참조하므로 직접 테스트 대신 로직 재현) */
async function bindTokenToSessionLocal(stub, tokenKey, sessionId, ttlSeconds) {
  const key = getTokenSessionKey(tokenKey);
  await stub.setex(key, ttlSeconds, sessionId);
  return true;
}

async function getSessionIdByTokenLocal(stub, tokenKey) {
  const key   = getTokenSessionKey(tokenKey);
  const value = await stub.get(key);
  return value || null;
}

/* ── deriveTokenKey 테스트 ── */

describe("deriveTokenKey — Authorization Bearer 헤더", () => {
  it("Bearer 토큰에서 hash 추출 및 keyId 네임스페이스 포함", () => {
    const req = {
      headers: { authorization: "Bearer test-token-abc123" }
    };
    const authCheck = { keyId: 42 };

    const key = deriveTokenKey(req, {}, authCheck);

    assert.ok(key, "tokenKey가 null이면 안 된다");
    assert.ok(key.startsWith("42:"), `keyId 네임스페이스 포함 필요: ${key}`);

    const parts = key.split(":");
    assert.strictEqual(parts.length, 2, "형식은 `ns:hash16`이어야 한다");
    assert.strictEqual(parts[1].length, 16, "해시는 16자 hex");
  });
});

describe("deriveTokenKey — memento-access-key 헤더", () => {
  it("authorization 없을 때 memento-access-key 헤더를 사용", () => {
    const req = {
      headers: { "memento-access-key": "my-access-key-xyz" }
    };

    const key = deriveTokenKey(req, {}, { keyId: 7 });

    assert.ok(key, "memento-access-key에서 tokenKey 추출 필요");
    assert.ok(key.startsWith("7:"));
  });
});

describe("deriveTokenKey — initialize.params.accessKey", () => {
  it("헤더 없을 때 msg.params.accessKey에서 추출", () => {
    const req = { headers: {} };
    const msg = { method: "initialize", params: { accessKey: "params-access-key" } };

    const key = deriveTokenKey(req, msg, { keyId: null, isMaster: true });

    assert.ok(key, "initialize.params.accessKey에서 tokenKey 추출 필요");
    assert.ok(key.startsWith("master:"), `master 네임스페이스 사용: ${key}`);
  });

  it("method != initialize이면 params.accessKey 무시", () => {
    const req = { headers: {} };
    const msg = { method: "tools/call", params: { accessKey: "should-be-ignored" } };

    const key = deriveTokenKey(req, msg, {});

    assert.strictEqual(key, null, "initialize 외 메서드의 accessKey는 무시되어야 한다");
  });
});

describe("deriveTokenKey — sha256 해시 특성", () => {
  it("토큰 원문이 해시에 노출되지 않는다", () => {
    const rawToken = "super-secret-bearer-token";
    const req      = { headers: { authorization: `Bearer ${rawToken}` } };

    const key = deriveTokenKey(req, {}, { keyId: null, isMaster: true });

    assert.ok(key, "tokenKey가 생성되어야 한다");
    assert.ok(!key.includes(rawToken), "원문 토큰이 tokenKey에 포함되면 안 된다");
  });

  it("sha256 해시값이 일관성 있게 생성된다 (결정론적)", () => {
    const rawToken = "deterministic-token";
    const expected = `master:${crypto.createHash("sha256").update(rawToken).digest("hex").slice(0, 16)}`;

    const req1 = { headers: { authorization: `Bearer ${rawToken}` } };
    const req2 = { headers: { authorization: `Bearer ${rawToken}` } };

    const key1 = deriveTokenKey(req1, {}, { keyId: null, isMaster: true });
    const key2 = deriveTokenKey(req2, {}, { keyId: null, isMaster: true });

    assert.notStrictEqual(
      deriveTokenKey(req1, {}, { keyId: null, isMaster: false }),
      key1,
      "non-API OAuth identity must not share the master namespace"
    );

    assert.strictEqual(key1, key2, "동일 토큰은 동일 tokenKey");
    assert.strictEqual(key1, expected, "sha256 16자 해시와 일치");
  });
});

describe("deriveTokenKey — cross-tenant 차단", () => {
  it("동일 토큰 + 다른 keyId → 다른 tokenKey", () => {
    const rawToken = "shared-token";
    const req      = { headers: { authorization: `Bearer ${rawToken}` } };

    const keyForA = deriveTokenKey(req, {}, { keyId: 1 });
    const keyForB = deriveTokenKey(req, {}, { keyId: 2 });

    assert.notStrictEqual(keyForA, keyForB, "keyId가 다르면 tokenKey도 달라야 한다");
    assert.ok(keyForA.startsWith("1:"), `keyId=1 prefix: ${keyForA}`);
    assert.ok(keyForB.startsWith("2:"), `keyId=2 prefix: ${keyForB}`);
  });

  it("인증 정보 없으면 null 반환", () => {
    const req = { headers: {} };
    const key = deriveTokenKey(req, {}, {});
    assert.strictEqual(key, null);
  });
});

/* ── bindTokenToSession / getSessionIdByToken 로직 ── */

describe("bindTokenToSession / getSessionIdByToken", () => {
  it("bindTokenToSession: setex 호출 후 getSessionIdByToken로 조회 가능", async () => {
    const stub     = makeRedisStub();
    const tokenKey = "master:abcdef1234567890";

    await bindTokenToSessionLocal(stub, tokenKey, "session-xyz", 86400);

    const result = await getSessionIdByTokenLocal(stub, tokenKey);
    assert.strictEqual(result, "session-xyz");
  });

  it("getSessionIdByToken: 키 없으면 null 반환", async () => {
    const stub   = makeRedisStub();
    const result = await getSessionIdByTokenLocal(stub, "nonexistent:key");
    assert.strictEqual(result, null);
  });

  it("bindTokenToSession: TTL이 올바르게 전달된다", async () => {
    const stub = makeRedisStub();
    await bindTokenToSessionLocal(stub, "key:abc", "sess-1", 3600);

    const redisKey = getTokenSessionKey("key:abc");
    const entry    = stub.store.get(redisKey);
    assert.ok(entry, "Redis에 저장되어야 한다");
    assert.strictEqual(entry.ttl, 3600, "TTL 3600이어야 한다");
  });
});

/* ── getTokenSessionKey ── */

describe("getTokenSessionKey", () => {
  it("token_session: prefix가 포함된 키를 반환한다", () => {
    const key = getTokenSessionKey("master:abcdef1234567890");
    assert.ok(key.startsWith("token_session:"), `prefix 없음: ${key}`);
    assert.ok(key.includes("master:abcdef1234567890"), `원본 tokenKey 포함 필요: ${key}`);
  });
});

/* ── 토큰 재사용 시나리오 (핵심 경로) ── */

describe("토큰 재사용 시나리오 — Mcp-Session-Id 유실 대응", () => {
  it("첫 initialize: 토큰 등록 → 두 번째 initialize(세션헤더 없음): 기존 세션 재사용", async () => {
    const stub = makeRedisStub();

    /* 시뮬레이션: 첫 번째 initialize에서 파생된 tokenKey */
    const req        = { headers: { authorization: "Bearer persistent-token" } };
    const authCheck  = { keyId: 99 };
    const tokenKey   = deriveTokenKey(req, {}, authCheck);

    /* 첫 세션 생성 및 바인딩 */
    const firstSessionId = "sess-first-0001";
    await bindTokenToSessionLocal(stub, tokenKey, firstSessionId, 86400);

    /* 두 번째 initialize — Mcp-Session-Id 헤더 없음 (유실 시뮬레이션)
       getSessionIdByToken으로 기존 세션 복구 */
    const recoveredSid = await getSessionIdByTokenLocal(stub, tokenKey);

    assert.strictEqual(recoveredSid, firstSessionId,
      "동일 토큰으로 기존 세션이 복구되어야 한다");
  });

  it("세 번째 initialize까지 동일 세션 유지 (TTL 내)", async () => {
    const stub       = makeRedisStub();
    const tokenKey   = "99:abc1234567890123";
    const sessionId  = "sess-stable-9999";

    await bindTokenToSessionLocal(stub, tokenKey, sessionId, 86400);

    const sid1 = await getSessionIdByTokenLocal(stub, tokenKey);
    const sid2 = await getSessionIdByTokenLocal(stub, tokenKey);
    const sid3 = await getSessionIdByTokenLocal(stub, tokenKey);

    assert.strictEqual(sid1, sessionId);
    assert.strictEqual(sid2, sessionId);
    assert.strictEqual(sid3, sessionId, "세 번 연속 동일 세션 반환");
  });

  it("토큰 삭제(unbind) 후 재시도 시 null 반환", async () => {
    const stub     = makeRedisStub();
    const tokenKey = "99:del1234567890123";

    await bindTokenToSessionLocal(stub, tokenKey, "sess-to-delete", 86400);

    /* 수동 삭제 */
    const redisKey = getTokenSessionKey(tokenKey);
    await stub.del(redisKey);

    const result = await getSessionIdByTokenLocal(stub, tokenKey);
    assert.strictEqual(result, null, "삭제 후에는 null 반환");
  });
});
