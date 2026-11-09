/**
 * LinkStore — cross-tenant traversal 격리 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-10
 *
 * 검증 범위:
 *   - getRCAChain: seed + 1-hop 모두 key_id 필터 포함 확인
 *
 * DB 호출 없이 TestableXxx wrapper로 SQL 빌드 로직만 검증한다.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keyScopeClause } from "../../lib/memory/keyScope.js";

const SCHEMA = "agent_memory";

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

});
