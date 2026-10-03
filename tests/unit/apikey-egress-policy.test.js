/**
 * API 키 외부 전송 정책 조회 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert                             from "node:assert/strict";

const calls   = [];
let queryImpl = async () => ({ rows: [] });

mock.module("../../lib/tools/db.js", {
  exports: { getPrimaryPool: () => ({ query: (...args) => { calls.push(args); return queryImpl(...args); } }) }
});

const { getEgressPolicy, invalidateEgressPolicyCache } = await import("../../lib/admin/ApiKeyStore.js");

const KEY = "550e8400-e29b-41d4-a716-446655440000";

describe("getEgressPolicy", () => {
  beforeEach(() => {
    calls.length = 0;
    invalidateEgressPolicyCache(KEY);
  });

  it("키가 없으면(master) 조회하지 않고 null이다", async () => {
    assert.equal(await getEgressPolicy(null), null);
    assert.equal(await getEgressPolicy(undefined), null);
    assert.equal(calls.length, 0);
  });

  it("행의 정책 값을 돌려주고 캐시한다", async () => {
    queryImpl = async () => ({ rows: [{ egress_policy: { local_only: true } }] });
    assert.deepEqual(await getEgressPolicy(KEY), { local_only: true });
    assert.deepEqual(await getEgressPolicy(KEY), { local_only: true });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1], [KEY]);
  });

  it("열이 없는 설치(행 값 없음)와 없는 키는 null이다", async () => {
    queryImpl = async () => ({ rows: [{ egress_policy: null }] });
    assert.equal(await getEgressPolicy(KEY), null);
    invalidateEgressPolicyCache(KEY);
    queryImpl = async () => ({ rows: [] });
    assert.equal(await getEgressPolicy(KEY), null);
  });

  it("열 이름에 의존하지 않고 행 전체에서 값을 꺼낸다", async () => {
    queryImpl = async () => ({ rows: [] });
    await getEgressPolicy(KEY);
    assert.match(calls[0][0], /to_jsonb\(k\)\s*->\s*'egress_policy'/);
  });

  it("무효화하면 다시 조회한다", async () => {
    queryImpl = async () => ({ rows: [{ egress_policy: { local_only: false } }] });
    await getEgressPolicy(KEY);
    invalidateEgressPolicyCache(KEY);
    queryImpl = async () => ({ rows: [{ egress_policy: { local_only: true } }] });
    assert.deepEqual(await getEgressPolicy(KEY), { local_only: true });
    assert.equal(calls.length, 2);
  });

  it("조회 실패는 캐시하지 않고 그대로 던진다", async () => {
    queryImpl = async () => { const e = new Error("connect ECONNREFUSED"); e.code = "ECONNREFUSED"; throw e; };
    await assert.rejects(getEgressPolicy(KEY), { code: "ECONNREFUSED" });
    queryImpl = async () => ({ rows: [{ egress_policy: { local_only: true } }] });
    assert.deepEqual(await getEgressPolicy(KEY), { local_only: true });
  });
});
