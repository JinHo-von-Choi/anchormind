/**
 * ApiKeyStore 조회 실패 기록 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, mock } from "node:test";
import assert                 from "node:assert/strict";

let queryImpl = async () => ({ rows: [] });

mock.module("../../lib/tools/db.js", {
  exports: { getPrimaryPool: () => ({ query: (...args) => queryImpl(...args) }) }
});

const { validateApiKeyById, validateApiKeyFromDB, getKeyAuthState } = await import("../../lib/admin/ApiKeyStore.js");
const { register }                                                  = await import("../../lib/metrics.js");
const { getCachedKeyState, invalidateKeyState, isKeyStateRevoked }  = await import("../../lib/admin/key-state-cache.js");

async function storeErrors(operation) {
  const values = (await register.getSingleMetric("mcp_auth_store_errors_total").get()).values;
  return values.find(v => v.labels.operation === operation)?.value ?? 0;
}

describe("ApiKeyStore 조회 실패", () => {
  it("id 조회 실패는 store_unavailable 사유와 지표를 남긴다", async () => {
    queryImpl    = async () => { const e = new Error("timeout"); e.code = "57014"; throw e; };
    const before = await storeErrors("validate_by_id");
    const result = await validateApiKeyById("550e8400-e29b-41d4-a716-446655440000");
    assert.deepEqual(result, { valid: false, reason: "store_unavailable" });
    assert.equal(await storeErrors("validate_by_id"), before + 1);
  });

  it("id가 없는 키는 사유 없이 무효다", async () => {
    queryImpl = async () => ({ rows: [] });
    assert.deepEqual(await validateApiKeyById("550e8400-e29b-41d4-a716-446655440000"), { valid: false });
  });

  it("원시 키 조회 실패는 지표를 남기고 예외를 그대로 전한다", async () => {
    queryImpl    = async () => { const e = new Error("connect ECONNREFUSED"); e.code = "ECONNREFUSED"; throw e; };
    const before = await storeErrors("validate_raw_key");
    await assert.rejects(validateApiKeyFromDB("mmcp_raw"), { code: "ECONNREFUSED" });
    assert.equal(await storeErrors("validate_raw_key"), before + 1);
  });

  it("원시 키가 없는 키는 지표 없이 무효다", async () => {
    queryImpl    = async () => ({ rows: [] });
    const before = await storeErrors("validate_raw_key");
    assert.deepEqual(await validateApiKeyFromDB("mmcp_unknown"), { valid: false });
    assert.equal(await storeErrors("validate_raw_key"), before);
  });

  it("세션 재확인용 키 상태 조회는 실패를 무효 결과로 바꾸지 않고 던진다", async () => {
    queryImpl = async () => { const e = new Error("connect ECONNREFUSED"); e.code = "ECONNREFUSED"; throw e; };
    await assert.rejects(getKeyAuthState("550e8400-e29b-41d4-a716-446655440000"), { code: "ECONNREFUSED" });
  });

  it("세션 재확인용 키 상태 조회는 행이 없으면 exists=false로 답한다", async () => {
    queryImpl = async () => ({ rows: [] });
    assert.deepEqual(await getKeyAuthState("550e8400-e29b-41d4-a716-446655440000"), { exists: false, status: null, permissions: null });
  });

  it("세션 재확인은 조회 실패를 판정 불가(null)로 다뤄 세션을 폐기하지 않는다", async () => {
    const keyId = "550e8400-e29b-41d4-a716-446655440001";
    invalidateKeyState(keyId);
    queryImpl = async () => { const e = new Error("connect ECONNREFUSED"); e.code = "ECONNREFUSED"; throw e; };
    const state = await getCachedKeyState(keyId);
    assert.equal(state, null);
    assert.equal(isKeyStateRevoked(state), false);
  });

  it("세션 재확인은 행이 없는 키를 폐기 대상으로 판정한다", async () => {
    const keyId = "550e8400-e29b-41d4-a716-446655440002";
    invalidateKeyState(keyId);
    queryImpl = async () => ({ rows: [] });
    assert.equal(isKeyStateRevoked(await getCachedKeyState(keyId)), true);
    invalidateKeyState(keyId);
  });
});
