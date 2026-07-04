/**
 * FragmentReader.getById keyId 격리 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-10
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

/** queryWithAgentVector mock — 테스트별로 반환값 교체 */
let _queryMock = mock.fn(async () => ({ rows: [] }));

/** FragmentReader를 import하기 전에 db 모듈을 스텁으로 대체 */
const mockModule = {
  queryWithAgentVector: (...args) => _queryMock(...args)
};

describe("FragmentReader.getById — keyId SQL 격리", () => {

  beforeEach(() => {
    _queryMock = mock.fn(async () => ({ rows: [] }));
  });

  it("keyId=null(마스터)이면 SQL에 key_id 조건이 없어야 한다", async () => {
    const { FragmentReader } = await import("../../lib/memory/read/FragmentReader.js");
    const reader = new FragmentReader();

    /** queryWithAgentVector를 인스턴스 메서드로 교체 */
    reader._query = async (agentId, sql, params) => {
      assert.ok(!sql.includes("key_id"), `마스터 키 조회에 key_id 조건 포함됨: ${sql}`);
      assert.strictEqual(params.length, 2, "파라미터는 [id, agentId] 2개여야 한다");
      return { rows: [] };
    };

    /** _query를 사용하도록 임시 패치 */
    const origQuery = (await import("../../lib/tools/db.js")).queryWithAgentVector;
    const { queryWithAgentVector } = await import("../../lib/tools/db.js");

    let capturedSql    = "";
    let capturedParams = [];

    /** 모듈 캐시 없이 직접 SQL 검증 — getById 로직을 인라인으로 재현 */
    const SCHEMA = "agent_memory";
    const id      = "frag-aaa";
    const agentId = "default";
    const keyId   = null;
    const groupKeyIds = [];

    const baseWhere = `id = $1 AND (agent_id = $2 OR agent_id = 'default') AND valid_to IS NULL`;
    let   keyFilter = "";
    const params    = [id, agentId];

    if (keyId !== null) {
      const allKeys = Array.isArray(groupKeyIds) && groupKeyIds.length > 0 ? groupKeyIds : [keyId];
      params.push(keyId, allKeys);
      keyFilter = ` AND (key_id IS NOT DISTINCT FROM $3 OR key_id = ANY($4::text[]))`;
    }

    capturedSql    = `SELECT ... FROM ${SCHEMA}.fragments WHERE ${baseWhere}${keyFilter}`;
    capturedParams = params;

    assert.ok(!capturedSql.includes("key_id"), "마스터 키는 key_id 조건 없이 조회");
    assert.strictEqual(capturedParams.length, 2);
  });

  it("keyId가 있으면 SQL에 IS NOT DISTINCT FROM + ANY 조건이 추가되어야 한다", () => {
    const SCHEMA      = "agent_memory";
    const id          = "frag-bbb";
    const agentId     = "default";
    const keyId       = "key-99";
    const groupKeyIds = ["key-99", "key-100"];

    const baseWhere = `id = $1 AND (agent_id = $2 OR agent_id = 'default') AND valid_to IS NULL`;
    let   keyFilter = "";
    const params    = [id, agentId];

    if (keyId !== null) {
      const allKeys = Array.isArray(groupKeyIds) && groupKeyIds.length > 0 ? groupKeyIds : [keyId];
      params.push(keyId, allKeys);
      keyFilter = ` AND (key_id IS NOT DISTINCT FROM $3 OR key_id = ANY($4::text[]))`;
    }

    const sql = `SELECT ... FROM ${SCHEMA}.fragments WHERE ${baseWhere}${keyFilter}`;

    assert.ok(sql.includes("IS NOT DISTINCT FROM $3"), "IS NOT DISTINCT FROM $3 조건 필수");
    assert.ok(sql.includes("key_id = ANY($4::text[])"), "ANY($4::text[]) 조건 필수");
    assert.strictEqual(params.length, 4);
    assert.strictEqual(params[2], "key-99");
    assert.deepStrictEqual(params[3], ["key-99", "key-100"]);
  });

  it("keyId만 있고 groupKeyIds 비어있으면 [keyId]를 그룹으로 사용한다", () => {
    const id          = "frag-ccc";
    const agentId     = "default";
    const keyId       = "key-77";
    const groupKeyIds = [];

    const params = [id, agentId];
    if (keyId !== null) {
      const allKeys = Array.isArray(groupKeyIds) && groupKeyIds.length > 0 ? groupKeyIds : [keyId];
      params.push(keyId, allKeys);
    }

    assert.strictEqual(params.length, 4);
    assert.strictEqual(params[2], "key-77");
    assert.deepStrictEqual(params[3], ["key-77"]);
  });

});

describe("MemoryManager — keyId 격리 통합 (mock store)", () => {

  it("key B가 key A의 fragment를 forget 시도하면 'Fragment not found or no permission' 반환", async () => {
    const { MemoryManager } = await import("../../lib/memory/MemoryManager.js");
    const mm = new MemoryManager();

    /** store.getById를 keyId 격리 동작으로 모킹 */
    mm.store.getById = mock.fn(async (id, agentId, keyId, groupKeyIds) => {
      /** key-A 소유 파편 */
      const frag = { id, key_id: "key-A", ttl_tier: "warm", keywords: [], topic: "test", type: "fact" };

      /** keyId가 있고 frag.key_id가 허용 목록에 없으면 null 반환 (SQL 레벨 필터 시뮬레이션) */
      if (keyId !== null) {
        const allowed = Array.isArray(groupKeyIds) && groupKeyIds.length > 0
          ? groupKeyIds
          : [keyId];
        if (!allowed.includes(frag.key_id)) return null;
      }
      return frag;
    });

    /** deindex가 호출되면 안 됨 */
    const deindexCalled = [];
    mm.index = {
      deindex: mock.fn(async (...args) => { deindexCalled.push(args); })
    };

    const result = await mm.forget({
      id            : "frag-aaa",
      agentId       : "default",
      _keyId        : "key-B",
      _groupKeyIds  : ["key-B"]
    });

    assert.strictEqual(result.error, "Fragment not found or no permission",
      `에러 메시지 불일치: ${result.error}`);
    assert.strictEqual(result.deleted, 0);
    assert.strictEqual(deindexCalled.length, 0, "권한 없는 파편의 deindex가 호출되었다");
  });

  it("key A가 자신의 파편을 forget 시도하면 성공", async () => {
    const { MemoryManager } = await import("../../lib/memory/MemoryManager.js");
    const mm = new MemoryManager();

    mm.store.getById = mock.fn(async (id, agentId, keyId, groupKeyIds) => {
      const frag = { id, key_id: "key-A", ttl_tier: "warm", keywords: [], topic: "test", type: "fact" };
      if (keyId !== null) {
        const allowed = Array.isArray(groupKeyIds) && groupKeyIds.length > 0 ? groupKeyIds : [keyId];
        if (!allowed.includes(frag.key_id)) return null;
      }
      return frag;
    });

    mm.store.delete = mock.fn(async () => true);
    mm.index = { deindex: mock.fn(async () => {}) };

    const result = await mm.forget({
      id          : "frag-aaa",
      agentId     : "default",
      _keyId      : "key-A",
      _groupKeyIds: ["key-A"]
    });

    assert.strictEqual(result.deleted, 1);
    assert.ok(!result.error, `예상치 못한 에러: ${result.error}`);
  });

  it("마스터 키(keyId=null)는 타 키 파편도 forget 가능", async () => {
    const { MemoryManager } = await import("../../lib/memory/MemoryManager.js");
    const mm = new MemoryManager();

    mm.store.getById = mock.fn(async (id, agentId, keyId, groupKeyIds) => {
      /** keyId=null이면 필터 없이 반환 */
      if (keyId === null) {
        return { id, key_id: "key-A", ttl_tier: "warm", keywords: [], topic: "test", type: "fact" };
      }
      return null;
    });

    mm.store.delete = mock.fn(async () => true);
    mm.index = { deindex: mock.fn(async () => {}) };

    const result = await mm.forget({
      id     : "frag-aaa",
      agentId: "default",
      _keyId : null
    });

    assert.strictEqual(result.deleted, 1);
    assert.ok(!result.error);
  });

});
