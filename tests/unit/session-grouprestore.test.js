/**
 * session-grouprestore 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-10
 *
 * 검증 대상:
 *  1. ApiKeyStore.getGroupKeyIds — mock pg pool로 그룹 자기조인 SQL 호출 검증
 *  2. mcp-handler 세션 복원 폴백 경로 — stale session의 groupKeyIds 재조회 조건 검증
 *
 * 커밋 5291b4f (getGroupKeyIds 추출) + 4117278 (폴백 로직) 회귀 테스트.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

/** ─────────────────────────────────────────────────────────────────
 *  모듈 mock 최상위 등록 (테스트 이전에 단 1회 실행)
 *  mockQuery 구현은 각 테스트에서 mockImplementationOnce로 교체.
 * ──────────────────────────────────────────────────────────────── */

const mockQuery = mock.fn();
const mockPool  = { query: mockQuery };

mock.module("../../lib/tools/db.js", {
  namedExports: { getPrimaryPool: () => mockPool }
});
mock.module("../../lib/logger.js", {
  namedExports: { logError: mock.fn(), logInfo: mock.fn(), logWarn: mock.fn() }
});
mock.module("../../lib/config.js", {
  namedExports: {
    DEFAULT_DAILY_LIMIT:    1000,
    DEFAULT_FRAGMENT_LIMIT: 5000,
    DEFAULT_PERMISSIONS:    ["read", "write"],
  }
});

/** mock 등록 후 getGroupKeyIds import */
const { getGroupKeyIds } = await import(
  "../../lib/admin/ApiKeyStore.js"
);

/** ─────────────────────────────────────────────────────────────────
 *  Section 1: getGroupKeyIds (ApiKeyStore)
 * ──────────────────────────────────────────────────────────────── */

describe("getGroupKeyIds — ApiKeyStore export", () => {
  it("pg가 12 row 반환 시 12개 keyId 배열 반환", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ key_id: `k${i + 1}` }));
    mockQuery.mock.resetCalls();
    mockQuery.mock.mockImplementationOnce(async () => ({ rows }));

    const result = await getGroupKeyIds("K1");

    assert.strictEqual(Array.isArray(result), true);
    assert.strictEqual(result.length, 12);
    assert.deepStrictEqual(result, rows.map(r => r.key_id));

    assert.strictEqual(mockQuery.mock.callCount(), 1);
    const [sql, params] = mockQuery.mock.calls[0].arguments;
    assert.match(sql, /api_key_group_members/);
    assert.deepStrictEqual(params, ["K1"]);
  });

  it("pg가 0 row 반환 시 [keyId] 단독 배열 반환", async () => {
    mockQuery.mock.resetCalls();
    mockQuery.mock.mockImplementationOnce(async () => ({ rows: [] }));

    const result = await getGroupKeyIds("K1");

    assert.deepStrictEqual(result, ["K1"]);
    assert.strictEqual(mockQuery.mock.callCount(), 1);
  });

  it("getGroupKeyIds(null) → null 반환, DB 쿼리 없음", async () => {
    mockQuery.mock.resetCalls();

    assert.strictEqual(await getGroupKeyIds(null),      null);
    assert.strictEqual(await getGroupKeyIds(undefined), null);
    assert.strictEqual(mockQuery.mock.callCount(), 0);
  });
});

/** ─────────────────────────────────────────────────────────────────
 *  Section 2: 세션 복원 폴백 로직
 *
 *  mcp-handler.js 인라인 블록 (커밋 4117278):
 *    if (!sessionGroupKeyIds?.length && sessionKeyId) {
 *      const refetched = await getGroupKeyIds(sessionKeyId);
 *      if (refetched) {
 *        sessionGroupKeyIds  = refetched;
 *        session.groupKeyIds = refetched;
 *        if (REDIS_ENABLED) await saveSessionToRedis(...);
 *      }
 *    }
 *
 *  handler 전체 import 시 불필요한 의존성(auth, jsonrpc 등)이 과도하게
 *  필요하므로, 폴백 조건 블록만 독립 pure helper로 재현하여 spy 검증.
 * ──────────────────────────────────────────────────────────────── */

/**
 * mcp-handler의 stale 세션 폴백 블록을 1:1 재현한 순수 함수.
 *
 * @param {object}   session            - 복원된 세션 객체 (mutable)
 * @param {Function} getGroupKeyIdsFn   - ApiKeyStore.getGroupKeyIds spy
 * @param {Function} saveRedisFn        - redis.saveSession spy
 * @param {boolean}  redisEnabled
 * @param {number}   sessionTtlMs
 * @param {string}   sessionId
 * @returns {Promise<string[]|null>}
 */
async function applyGroupKeyIdsFallback(
  session,
  getGroupKeyIdsFn,
  saveRedisFn,
  redisEnabled,
  sessionTtlMs,
  sessionId
) {
  let sessionKeyId       = session.keyId       ?? null;
  let sessionGroupKeyIds = session.groupKeyIds  ?? null;

  if (!sessionGroupKeyIds?.length && sessionKeyId) {
    const refetched = await getGroupKeyIdsFn(sessionKeyId);
    if (refetched) {
      sessionGroupKeyIds      = refetched;
      session.groupKeyIds     = refetched;
      if (redisEnabled) {
        const persistable = { ...session };
        delete persistable.getSseResponse;
        delete persistable.setSseResponse;
        delete persistable.close;
        delete persistable._restoredFromRedis;
        await saveRedisFn(sessionId, persistable, Math.ceil(sessionTtlMs / 1000));
      }
    }
  }

  return sessionGroupKeyIds;
}

describe("mcp-handler stale session 폴백 — groupKeyIds 재조회 조건", () => {
  /** TC4: groupKeyIds undefined + keyId 있음 → 폴백 트리거 */
  it("stale session {keyId: K1, groupKeyIds: undefined} → getGroupKeyIds 호출 후 세션 갱신", async () => {
    const spyGetGroup = mock.fn(async () => ["K1", "K2", "K3"]);
    const spySave     = mock.fn(async () => {});

    const session = { keyId: "K1", groupKeyIds: undefined, authenticated: true };
    const result  = await applyGroupKeyIdsFallback(
      session, spyGetGroup, spySave, false, 43200 * 60 * 1000, "sess-abc"
    );

    assert.strictEqual(spyGetGroup.mock.callCount(), 1);
    assert.deepStrictEqual(spyGetGroup.mock.calls[0].arguments, ["K1"]);
    assert.deepStrictEqual(result,               ["K1", "K2", "K3"]);
    assert.deepStrictEqual(session.groupKeyIds,  ["K1", "K2", "K3"]);
  });

  /** TC4 확장: REDIS_ENABLED=true 시 saveSession 호출 및 메서드 필드 제거 검증 */
  it("REDIS_ENABLED=true 시 saveSessionToRedis 호출 및 메서드 필드 제거 확인", async () => {
    const spyGetGroup = mock.fn(async () => ["K1"]);
    const spySave     = mock.fn(async () => {});

    const session = {
      keyId:             "K1",
      groupKeyIds:       undefined,
      authenticated:     true,
      getSseResponse:    () => null,
      setSseResponse:    () => {},
      close:             () => {},
      _restoredFromRedis: true,
    };

    await applyGroupKeyIdsFallback(
      session, spyGetGroup, spySave, true, 43200 * 60 * 1000, "sess-xyz"
    );

    assert.strictEqual(spySave.mock.callCount(), 1);
    const [sid, data, ttl] = spySave.mock.calls[0].arguments;
    assert.strictEqual(sid, "sess-xyz");
    assert.ok(Number.isInteger(ttl) && ttl > 0);
    assert.ok(!("getSseResponse"     in data));
    assert.ok(!("setSseResponse"     in data));
    assert.ok(!("close"              in data));
    assert.ok(!("_restoredFromRedis" in data));
  });

  /** TC5: master 세션 (keyId: null) → 폴백 미트리거 */
  it("master session {keyId: null, groupKeyIds: undefined} → getGroupKeyIds 미호출", async () => {
    const spyGetGroup = mock.fn(async () => null);
    const spySave     = mock.fn(async () => {});

    const session = { keyId: null, groupKeyIds: undefined, authenticated: true };
    const result  = await applyGroupKeyIdsFallback(
      session, spyGetGroup, spySave, false, 43200 * 60 * 1000, "sess-master"
    );

    assert.strictEqual(spyGetGroup.mock.callCount(), 0);
    assert.strictEqual(result, null);
  });

  /** TC6: 이미 채워진 세션 → 재호출 없음 */
  it("groupKeyIds 이미 채워진 {keyId: K1, groupKeyIds: [K1,K2]} → getGroupKeyIds 미호출", async () => {
    const spyGetGroup = mock.fn(async () => ["K1", "K2"]);
    const spySave     = mock.fn(async () => {});

    const session = { keyId: "K1", groupKeyIds: ["K1", "K2"], authenticated: true };
    const result  = await applyGroupKeyIdsFallback(
      session, spyGetGroup, spySave, false, 43200 * 60 * 1000, "sess-full"
    );

    assert.strictEqual(spyGetGroup.mock.callCount(), 0);
    assert.deepStrictEqual(result, ["K1", "K2"]);
  });

  /** 경계: groupKeyIds = [] (빈 배열) → 재조회 트리거 (length=0) */
  it("groupKeyIds=[] 빈 배열 → 재조회 트리거됨", async () => {
    const spyGetGroup = mock.fn(async () => ["K1"]);
    const spySave     = mock.fn(async () => {});

    const session = { keyId: "K1", groupKeyIds: [], authenticated: true };
    const result  = await applyGroupKeyIdsFallback(
      session, spyGetGroup, spySave, false, 43200 * 60 * 1000, "sess-empty"
    );

    assert.strictEqual(spyGetGroup.mock.callCount(), 1);
    assert.deepStrictEqual(result, ["K1"]);
  });
});
