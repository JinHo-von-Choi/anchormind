/**
 * ClaimStore — fragment_claims CRUD + tenant isolation 가드 (v2.8.0 Phase 0)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * 원칙:
 *  - 테넌트 격리는 "IS NOT DISTINCT FROM" 패턴으로 처리. 이 연산자는 NULL = NULL 을
 *    true 로 취급하므로 master(NULL) 와 tenant(TEXT) 를 단일 쿼리 분기 없이 격리한다.
 *  - v2.5.7 이후 금지된 NULL-OR-equal 패턴(master union tenant)은 cross-tenant 누출
 *    위험이 있기에 사용하지 않는다. tests/unit/tenant-isolation.test.js 의 grep 가드가
 *    이 패턴을 감시하므로 주석·문서에서도 리터럴 패턴을 직접 쓰지 않는다.
 *  - insert 진입부에서 fragment.key_id 와 ctx.keyId 의 일치 여부를 확인. 불일치면
 *    TENANT_ISOLATION_VIOLATION 예외를 throw 하고 경고 로그만 남긴다 (원문/object 는
 *    로그에 실지 않음 — Winston redactor 규칙 준수).
 *  - migration-032 스키마 기준 key_id 는 TEXT NULL. 따라서 JS 쪽에서도 null 로
 *    정규화한 뒤 동등 비교한다 (undefined 는 null 로 흡수).
 *
 * 참조:
 *  - lib/memory/migrations/migration-032-fragment-claims.sql
 *  - lib/memory/write/ConflictResolver.js (store 패턴)
 *  - plan §"새 테이블: fragment_claims"
 */

import { getPrimaryPool }    from "../tools/db.js";
import { logWarn }           from "../logger.js";
import { normalizeKeyId as _normalizeKeyIdBase } from "../memory/keyId.js";

const SCHEMA                      = "agent_memory";
const TENANT_ISOLATION_VIOLATION  = "TENANT_ISOLATION_VIOLATION";
const DEFAULT_CONFLICT_THRESHOLD  = 0.7;

const normalizeKeyId = (v) => _normalizeKeyIdBase(v, { mode: 'claim' });

export class ClaimStore {

  /**
   * claims 를 fragment_claims 에 일괄 insert.
   * fragment.key_id ≠ ctx.keyId 이면 cross-tenant write 차단.
   *
   * @param {{ id: string, key_id: string|null|undefined }} fragment
   * @param {Array}   claims
   * @param {{ agentId?: string, keyId?: string|null }} ctx
   * @returns {Promise<number>} inserted row count (ON CONFLICT 제외)
   */
  async insert(fragment, claims, ctx = {}) {
    if (!fragment || !fragment.id)            return 0;
    if (!Array.isArray(claims) || claims.length === 0) return 0;

    const fragKeyId = normalizeKeyId(fragment.key_id);
    const ctxKeyId  = normalizeKeyId(ctx.keyId);

    if (fragKeyId !== ctxKeyId) {
      logWarn(`[ClaimStore] tenant mismatch: fragment.key_id=${fragKeyId}, ctx.keyId=${ctxKeyId}`);
      throw new Error(TENANT_ISOLATION_VIOLATION);
    }

    const pool = getPrimaryPool();
    if (!pool) return 0;

    const values = [];
    const chunks = [];
    let p = 1;
    for (const c of claims) {
      chunks.push(`($${p}, $${p+1}, $${p+2}, $${p+3}, $${p+4}, $${p+5}, $${p+6}, $${p+7}, $${p+8})`);
      values.push(
        fragment.id,
        fragKeyId,
        c.subject,
        c.predicate,
        c.object ?? null,
        c.polarity,
        c.confidence,
        c.extractor,
        c.ruleVersion
      );
      p += 9;
    }

    const sql = `
      INSERT INTO ${SCHEMA}.fragment_claims
        (fragment_id, key_id, subject, predicate, object, polarity, confidence, extractor, rule_version)
      VALUES ${chunks.join(", ")}
      ON CONFLICT DO NOTHING
    `;

    const result = await pool.query(sql, values);
    return result.rowCount ?? 0;
  }

  /**
   * 특정 fragment 의 claim 목록 조회. 테넌트 격리 필터 포함.
   *
   * @param {string} fragmentId
   * @param {string|null} [keyId]
   * @returns {Promise<Array>}
   */
  async getByFragmentId(fragmentId, keyId = null) {
    const pool = getPrimaryPool();
    if (!pool) return [];

    const params = [fragmentId, normalizeKeyId(keyId)];
    const sql = `
      SELECT id, fragment_id, key_id, subject, predicate, object,
             polarity, confidence, extractor, rule_version, created_at
        FROM ${SCHEMA}.fragment_claims
       WHERE fragment_id = $1
         AND key_id IS NOT DISTINCT FROM $2
       ORDER BY id ASC
    `;
    const { rows } = await pool.query(sql, params);
    return rows;
  }

  /**
   * fragment 단위 전체 삭제. FK CASCADE 가 이미 있으므로 fragment 삭제 시에는
   * 불필요하지만, 수동 cleanup (예: ClaimExtractor 재실행 전) 경로에서 사용.
   *
   * @param {string} fragmentId
   * @param {string|null} [keyId]
   * @returns {Promise<number>} deleted row count
   */
  async deleteByFragmentId(fragmentId, keyId = null) {
    const pool = getPrimaryPool();
    if (!pool) return 0;

    const params = [fragmentId, normalizeKeyId(keyId)];
    const { rowCount } = await pool.query(
      `DELETE FROM ${SCHEMA}.fragment_claims
        WHERE fragment_id = $1
          AND key_id IS NOT DISTINCT FROM $2`,
      params
    );
    return rowCount ?? 0;
  }

  /**
   * polarity 충돌 탐지. 동일 (subject, predicate, COALESCE(object,'')) 에서
   * 한쪽은 positive, 다른 쪽은 negative 이고 confidence 가 임계값 이상인 쌍만.
   * 테넌트 격리: 양쪽 claim 모두 동일 key_id 여야 한다.
   *
   * @param {string} fragmentId - 기준 fragment
   * @param {string|null} [keyId]
   * @param {{ minConfidence?: number }} [opts]
   * @returns {Promise<Array<{f1:string,f2:string,subject:string,predicate:string,object:string|null}>>}
   */
  async findPolarityConflicts(fragmentId, keyId = null, opts = {}) {
    const pool = getPrimaryPool();
    if (!pool) return [];

    const threshold = Number.isFinite(opts.minConfidence) ? opts.minConfidence : DEFAULT_CONFLICT_THRESHOLD;
    const params    = [fragmentId, normalizeKeyId(keyId), threshold];

    const sql = `
      SELECT c1.fragment_id AS f1,
             c2.fragment_id AS f2,
             c1.subject,
             c1.predicate,
             c1.object
        FROM ${SCHEMA}.fragment_claims c1
        JOIN ${SCHEMA}.fragment_claims c2
          ON c1.subject   = c2.subject
         AND c1.predicate = c2.predicate
         AND COALESCE(c1.object, '') = COALESCE(c2.object, '')
         AND c1.polarity  = 'positive'
         AND c2.polarity  = 'negative'
         AND c1.fragment_id <> c2.fragment_id
       WHERE (c1.fragment_id = $1 OR c2.fragment_id = $1)
         AND c1.key_id IS NOT DISTINCT FROM $2
         AND c2.key_id IS NOT DISTINCT FROM $2
         AND c1.confidence >= $3
         AND c2.confidence >= $3
    `;
    const { rows } = await pool.query(sql, params);
    return rows;
  }
}

export { TENANT_ISOLATION_VIOLATION };
