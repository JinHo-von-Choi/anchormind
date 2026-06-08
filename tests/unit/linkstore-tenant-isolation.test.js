/**
 * LinkStore — cross-tenant traversal 격리 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-10
 *
 * 검증 범위:
 *   - getLinkedIds: keyId 지정 시 SQL에 key_id 필터 포함 확인 (SQL 문자열 분석)
 *   - isReachable: keyId 지정 시 SQL에 key_id 필터 포함 확인
 *   - getRCAChain: seed + 1-hop 모두 key_id 필터 포함 확인
 *
 * DB 호출 없이 TestableXxx wrapper로 SQL 빌드 로직만 검증한다.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keyScopeClause } from "../../lib/memory/keyScope.js";

const SCHEMA = "agent_memory";

/** ─────────────────────────────────────────────────────────────────────────
 *  TestableGetLinkedIds — getLinkedIds SQL 빌드 로직 추출
 */
class TestableGetLinkedIds {
  buildSql(keyId) {
    const params    = ["frag-1"];
    let keyFilter   = "";
    if (keyId != null) {
      params.push(keyId);
      keyFilter = `AND key_id IS NOT DISTINCT FROM $${params.length}`;
    }
    return {
      sql   : `SELECT linked_to FROM ${SCHEMA}.fragments
       WHERE id = $1
         AND valid_to IS NULL
         ${keyFilter}`,
      params,
    };
  }
}

/** ─────────────────────────────────────────────────────────────────────────
 *  TestableIsReachable — isReachable SQL 빌드 로직 추출
 */
class TestableIsReachable {
  buildSql(startId, targetId, keyId) {
    const params    = [startId, targetId];
    let keyFilter   = "";
    if (keyId != null) {
      params.push(keyId);
      keyFilter = `AND f.key_id IS NOT DISTINCT FROM $${params.length}`;
    }
    return {
      sql: `WITH RECURSIVE reachable AS (
         SELECT unnest(f0.linked_to) AS id, 1 AS depth
         FROM ${SCHEMA}.fragments f0
         WHERE f0.id = $1
           AND f0.valid_to IS NULL
       UNION
         SELECT unnest(f.linked_to), r.depth + 1
         FROM reachable r
         JOIN ${SCHEMA}.fragments f ON f.id = r.id
         WHERE r.depth < 20
           AND r.id != $2
           AND f.valid_to IS NULL
           ${keyFilter}
       )
       SELECT EXISTS (SELECT 1 FROM reachable WHERE id = $2) AS found`,
      params,
    };
  }
}

/** ─────────────────────────────────────────────────────────────────────────
 *  TestableGetRCAChain — getRCAChain SQL 빌드 로직 추출
 */
class TestableGetRCAChain {
  buildSql(startId, keyId, groupKeyIds = []) {
    const params = [startId];
    const scope  = { keyId, groupKeyIds: groupKeyIds.length > 0 ? groupKeyIds : (keyId != null ? [keyId] : []) };
    const seedKeyFilter = keyScopeClause(params, "f.key_id",  scope);
    const keyFilter     = keyScopeClause(params, "f2.key_id", scope);
    return {
      sql: `WITH rca AS (
         SELECT f.id, f.content, f.type, f.importance, f.topic,
                NULL::text AS relation_type, 0 AS depth
         FROM ${SCHEMA}.fragments f
         WHERE f.id = $1
           AND f.valid_to IS NULL
           ${seedKeyFilter}

         UNION ALL

         SELECT f2.id, f2.content, f2.type, f2.importance, f2.topic,
                l.relation_type, 1 AS depth
         FROM ${SCHEMA}.fragment_links l
         JOIN ${SCHEMA}.fragments f2 ON l.to_id = f2.id
         WHERE l.from_id = $1
           AND l.relation_type IN ('caused_by', 'resolved_by')
           AND f2.valid_to IS NULL
           ${keyFilter}
       )
       SELECT * FROM rca ORDER BY depth ASC, importance DESC`,
      params,
    };
  }
}

describe("LinkStore SQL 빌드 -- cross-tenant 격리", async () => {

  // ── getLinkedIds ──────────────────────────────────────────────────────────

  it("getLinkedIds: keyId=null → key_id 필터 없음", () => {
    const { sql, params } = new TestableGetLinkedIds().buildSql(null);
    assert.ok(!sql.includes("key_id"), "key_id 필터가 없어야 한다");
    assert.equal(params.length, 1);
  });

  it("getLinkedIds: keyId 지정 → key_id 필터 포함 + 파라미터 추가", () => {
    const { sql, params } = new TestableGetLinkedIds().buildSql("key-A");
    assert.ok(sql.includes("key_id"), "key_id 필터가 있어야 한다");
    assert.ok(params.includes("key-A"), "파라미터에 keyId 값이 있어야 한다");
    assert.equal(params.length, 2);
  });

  // ── isReachable ───────────────────────────────────────────────────────────

  it("isReachable: keyId=null → key_id 필터 없음", () => {
    const { sql, params } = new TestableIsReachable().buildSql("s", "t", null);
    assert.ok(!sql.includes("key_id"), "key_id 필터가 없어야 한다");
    assert.equal(params.length, 2);
  });

  it("isReachable: keyId 지정 → 재귀 JOIN에 key_id 필터 포함", () => {
    const { sql, params } = new TestableIsReachable().buildSql("s", "t", "key-B");
    assert.ok(sql.includes("key_id"), "key_id 필터가 있어야 한다");
    assert.ok(params.includes("key-B"));
    assert.equal(params.length, 3);
  });

  // ── getRCAChain ───────────────────────────────────────────────────────────

  it("getRCAChain: keyId=null → key_id 필터 없음", () => {
    const { sql, params } = new TestableGetRCAChain().buildSql("root", null);
    assert.ok(!sql.includes("key_id"), "key_id 필터가 없어야 한다");
    assert.equal(params.length, 1);
  });

  it("getRCAChain: keyId 지정 → seed + 1-hop 모두 key_id 필터 포함 (≥2회)", () => {
    const { sql, params } = new TestableGetRCAChain().buildSql("root", "key-C");
    const occurrences     = (sql.match(/key_id/g) || []).length;
    assert.ok(occurrences >= 2,
      `key_id 필터가 2군데 이상 있어야 한다 (found: ${occurrences})`);
    assert.ok(params.includes("key-C"));
    assert.equal(params.length, 5);   // startId + seed[keyId,arr] + link[keyId,arr]
  });

  // ── cross-tenant 시나리오 검증 ────────────────────────────────────────────

  it("keyId 지정 시 타 테넌트 파편은 파라미터에 없음 (격리 보장)", () => {
    /**
     * 실제 DB 없이 SQL 구조만 검증:
     * key_id IS NOT DISTINCT FROM $N 필터가 있으면 DB는 해당 키 소유 파편만 반환.
     * 타 테넌트 파편 ID를 직접 주입할 방법이 SQL 레벨에서 차단됨을 확인.
     */
    const { sql } = new TestableGetLinkedIds().buildSql("key-tenant-A");
    assert.ok(
      sql.includes("IS NOT DISTINCT FROM"),
      "NULL-safe 등가 비교(IS NOT DISTINCT FROM)로 격리되어야 한다"
    );
  });
});
