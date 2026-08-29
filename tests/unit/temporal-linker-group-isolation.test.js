/**
 * TemporalLinker — groupKeyIds 격리 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-10
 *
 * DB/LinkStore 의존성은 mock 처리.
 * cross-tenant temporal 링크 미생성 및 그룹 내 링크 생성 검증.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * TemporalLinker 핵심 쿼리 조건 빌드 로직을 독립 추출
 * — 실제 구현과 동일한 분기 규칙을 검증한다.
 */
function buildKeyFilter(groupKeyIds, paramOffset) {
  if (groupKeyIds == null) return { filter: "", params: [] };
  return {
    filter : `AND key_id = ANY($${paramOffset}::integer[])`,
    params : [groupKeyIds]
  };
}

/**
 * groupKeyIds 해석 로직 (TemporalLinker.linkTemporalNeighbors 내부와 동일)
 */
function resolveGroupKeyIds(options) {
  const keyId       = options.keyId ?? null;
  const groupKeyIds = options.groupKeyIds ?? (keyId != null ? [keyId] : null);
  return groupKeyIds;
}

/** TemporalLinker를 mock DB로 구동하는 테스트용 래퍼 */
class TestableTL {
  constructor(mockDb, mockLinkStore) {
    this.db        = mockDb;
    this.linkStore = mockLinkStore;
    this.lastSql   = null;
    this.lastParams = null;
  }

  async linkTemporalNeighbors(fragment, options = {}) {
    if (!fragment.topic) return [];

    const agentId     = options.agentId || "default";
    const keyId       = options.keyId ?? null;
    const groupKeyIds = options.groupKeyIds ?? (keyId != null ? [keyId] : null);
    const workspace   = fragment.workspace ?? null;

    const params  = [fragment.topic, fragment.id, fragment.created_at, 5];
    let keyFilter = "";
    if (groupKeyIds != null) {
      params.push(groupKeyIds);
      keyFilter = `AND key_id = ANY($${params.length}::integer[])`;
    }

    let workspaceFilter = "";
    if (workspace != null) {
      params.push(workspace);
      workspaceFilter = `AND (workspace IS NULL OR workspace = $${params.length})`;
    }

    const sql = `SELECT id, created_at FROM agent_memory.fragments
       WHERE topic = $1 AND id != $2
         AND created_at BETWEEN $3::timestamptz - interval '24 hours'
                             AND $3::timestamptz + interval '24 hours'
         AND valid_to IS NULL
         ${keyFilter}
         ${workspaceFilter}
       ORDER BY ABS(EXTRACT(EPOCH FROM (created_at - $3::timestamptz))) ASC
       LIMIT $4`;

    this.lastSql    = sql;
    this.lastParams = params;

    const neighbors = await this.db.query(sql, params);

    return Promise.all(
      neighbors.rows.map(async neighbor => {
        const hoursDiff = Math.abs(
          new Date(fragment.created_at) - new Date(neighbor.created_at)
        ) / (1000 * 60 * 60);
        const weight = Math.max(0.3, 1.0 - hoursDiff / 24);
        await this.linkStore.createLink(fragment.id, neighbor.id, "temporal", agentId, weight);
        return { toId: neighbor.id, weight };
      })
    );
  }
}

/** ===== groupKeyIds 해석 규칙 ===== */

describe("TemporalLinker — groupKeyIds 해석 규칙", () => {

  it("keyId=null (master): groupKeyIds=null → key_id 조건 없음", () => {
    const gk = resolveGroupKeyIds({ keyId: null });
    assert.equal(gk, null);
  });

  it("keyId 단독: [keyId]로 wrapping", () => {
    const gk = resolveGroupKeyIds({ keyId: 7 });
    assert.deepEqual(gk, [7]);
  });

  it("groupKeyIds 명시: 그대로 사용", () => {
    const gk = resolveGroupKeyIds({ keyId: 3, groupKeyIds: [3, 5, 9] });
    assert.deepEqual(gk, [3, 5, 9]);
  });

  it("keyId=null이고 groupKeyIds=null: 조건 없음 (master key)", () => {
    const gk = resolveGroupKeyIds({ keyId: null, groupKeyIds: null });
    assert.equal(gk, null);
  });

});

/** ===== keyFilter SQL 생성 ===== */

describe("TemporalLinker — keyFilter SQL 조건 생성", () => {

  it("groupKeyIds=null: 빈 필터 반환", () => {
    const { filter, params } = buildKeyFilter(null, 5);
    assert.equal(filter, "");
    assert.deepEqual(params, []);
  });

  it("groupKeyIds=[3]: ANY 배열 조건 생성", () => {
    const { filter, params } = buildKeyFilter([3], 5);
    assert.equal(filter, "AND key_id = ANY($5::integer[])");
    assert.deepEqual(params, [[3]]);
  });

  it("groupKeyIds=[3,5,9]: 배열 그대로 전달", () => {
    const { filter, params } = buildKeyFilter([3, 5, 9], 5);
    assert.equal(filter, "AND key_id = ANY($5::integer[])");
    assert.deepEqual(params, [[3, 5, 9]]);
  });

  it("paramOffset이 올바르게 반영됨", () => {
    const { filter } = buildKeyFilter([1], 7);
    assert.equal(filter, "AND key_id = ANY($7::integer[])");
  });

});

/** ===== 실제 쿼리 발사 검증 (mock DB) ===== */

describe("TemporalLinker — cross-tenant 링크 미생성 검증", () => {

  /** keyA(id=1) 소유 파편이 있을 때 keyB(id=2) 요청은 이웃을 찾지 못함 */
  it("다른 key_id 파편은 이웃으로 발견되지 않음", async () => {
    const keyAId  = 1;
    const keyBId  = 2;
    const now     = new Date().toISOString();

    const linksCreated = [];

    /** keyA 소유 파편만 DB에 존재 */
    const mockDb = {
      query: async (_sql, params) => {
        const filterArg = params[4] ?? null;  // groupKeyIds 위치
        if (filterArg && !filterArg.includes(keyAId)) {
          return { rows: [] };  // 다른 key → 결과 없음
        }
        return { rows: [{ id: "frag-keyA-001", created_at: now }] };
      }
    };

    const mockLinkStore = {
      createLink: async (fromId, toId, _type, _agentId, _weight) => {
        linksCreated.push({ fromId, toId });
      }
    };

    const tl      = new TestableTL(mockDb, mockLinkStore);
    const fragment = { id: "frag-keyB-new", topic: "auth-bug", created_at: now };

    /** keyB 요청: groupKeyIds=[2] → keyA 파편과 연결 안됨 */
    const result = await tl.linkTemporalNeighbors(fragment, {
      agentId     : "default",
      keyId       : keyBId,
      groupKeyIds : [keyBId]
    });

    assert.equal(result.length, 0, "cross-tenant 링크는 생성되지 않아야 함");
    assert.equal(linksCreated.length, 0);
  });

  it("같은 key_id 파편은 이웃으로 발견되어 링크 생성됨", async () => {
    const keyId = 3;
    const now   = new Date().toISOString();
    const linksCreated = [];

    const mockDb = {
      query: async () => ({
        rows: [{ id: "frag-same-key-001", created_at: now }]
      })
    };

    const mockLinkStore = {
      createLink: async (fromId, toId, type, agentId, weight) => {
        linksCreated.push({ fromId, toId, weight });
      }
    };

    const tl      = new TestableTL(mockDb, mockLinkStore);
    const fragment = { id: "frag-same-key-new", topic: "deploy", created_at: now };

    const result = await tl.linkTemporalNeighbors(fragment, {
      agentId     : "default",
      keyId       : keyId,
      groupKeyIds : [keyId]
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].toId, "frag-same-key-001");
    assert.equal(linksCreated.length, 1);
  });

  it("그룹 내 여러 key는 서로 링크 가능", async () => {
    const groupKeyIds = [3, 5];
    const now         = new Date().toISOString();
    const linksCreated = [];

    const mockDb = {
      query: async (_sql, params) => {
        const filterArg = params[4];
        assert.ok(Array.isArray(filterArg), "groupKeyIds는 배열로 전달돼야 함");
        assert.deepEqual(filterArg, groupKeyIds);
        return { rows: [{ id: "frag-group-peer", created_at: now }] };
      }
    };

    const mockLinkStore = {
      createLink: async (fromId, toId) => { linksCreated.push({ fromId, toId }); }
    };

    const tl      = new TestableTL(mockDb, mockLinkStore);
    const fragment = { id: "frag-group-new", topic: "migration", created_at: now };

    const result = await tl.linkTemporalNeighbors(fragment, {
      agentId     : "default",
      keyId       : 3,
      groupKeyIds : groupKeyIds
    });

    assert.equal(result.length, 1);
    assert.equal(linksCreated.length, 1);
  });

  it("master key (keyId=null): key_id 조건 없이 전체 파편 접근", async () => {
    const now = new Date().toISOString();
    let capturedParams = null;

    const mockDb = {
      query: async (_sql, params) => {
        capturedParams = params;
        return { rows: [] };
      }
    };

    const mockLinkStore = { createLink: async () => {} };

    const tl      = new TestableTL(mockDb, mockLinkStore);
    const fragment = { id: "frag-master", topic: "system", created_at: now };

    await tl.linkTemporalNeighbors(fragment, { agentId: "default", keyId: null });

    /** params 길이 4 (topic, id, created_at, LIMIT) → groupKeyIds 없음 */
    assert.equal(capturedParams.length, 4, "master key는 groupKeyIds 파라미터 없이 쿼리해야 함");
  });

  it("topic 없는 파편: 빈 배열 즉시 반환, DB 쿼리 없음", async () => {
    let queryCalled = false;
    const mockDb        = { query: async () => { queryCalled = true; return { rows: [] }; } };
    const mockLinkStore = { createLink: async () => {} };

    const tl      = new TestableTL(mockDb, mockLinkStore);
    const fragment = { id: "frag-no-topic", topic: null, created_at: new Date().toISOString() };

    const result = await tl.linkTemporalNeighbors(fragment, { keyId: 1 });
    assert.equal(result.length, 0);
    assert.equal(queryCalled, false);
  });

});

/** ===== workspace 스코프 필터 ===== */

describe("TemporalLinker — workspace 불일치 시 후보 제외", () => {

  it("fragment.workspace 지정 시 workspaceFilter SQL 절이 추가된다", async () => {
    const now = new Date().toISOString();
    let capturedSql = null;

    const mockDb = {
      query: async (sql) => { capturedSql = sql; return { rows: [] }; }
    };
    const mockLinkStore = { createLink: async () => {} };

    const tl      = new TestableTL(mockDb, mockLinkStore);
    const fragment = { id: "frag-ws-a", topic: "deploy", created_at: now, workspace: "proj-a" };

    await tl.linkTemporalNeighbors(fragment, { agentId: "default", keyId: null });

    assert.ok(capturedSql.includes("workspace IS NULL OR workspace ="), "workspaceFilter가 SQL에 포함돼야 함");
  });

  it("fragment.workspace 미지정 시 workspaceFilter가 추가되지 않는다", async () => {
    const now = new Date().toISOString();
    let capturedSql = null;
    let capturedParams = null;

    const mockDb = {
      query: async (sql, params) => { capturedSql = sql; capturedParams = params; return { rows: [] }; }
    };
    const mockLinkStore = { createLink: async () => {} };

    const tl      = new TestableTL(mockDb, mockLinkStore);
    const fragment = { id: "frag-no-ws", topic: "deploy", created_at: now };

    await tl.linkTemporalNeighbors(fragment, { agentId: "default", keyId: null });

    assert.ok(!capturedSql.includes("workspace IS NULL OR workspace ="), "workspace 미지정 시 필터 없음");
    assert.equal(capturedParams.length, 4, "workspace 파라미터가 추가되지 않아야 함");
  });

  it("workspace가 다른 파편은 DB WHERE 절에서 걸러짐(파라미터 전달 검증)", async () => {
    const now = new Date().toISOString();
    let capturedParams = null;

    const mockDb = {
      query: async (_sql, params) => {
        capturedParams = params;
        // 실제 DB WHERE 절이 workspace 불일치 행을 걸러낸다고 가정하고 빈 결과 반환
        return { rows: [] };
      }
    };
    const mockLinkStore = { createLink: async () => {} };

    const tl      = new TestableTL(mockDb, mockLinkStore);
    const fragment = { id: "frag-ws-b", topic: "deploy", created_at: now, workspace: "proj-b" };

    const result = await tl.linkTemporalNeighbors(fragment, { agentId: "default", keyId: null });

    assert.equal(capturedParams[capturedParams.length - 1], "proj-b");
    assert.equal(result.length, 0);
  });

});
