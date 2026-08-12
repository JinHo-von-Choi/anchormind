/**
 * column-spec.js — 임베딩 컬럼 (타입, 차원) 스펙 판정
 *
 * 작성자: 최진호
 * 작성일: 2026-08-12
 *
 * post-migrate-flexible-embedding-dims.js(마이그레이션 스킵 판정)와
 * check-embedding-consistency.js(기동 게이트)가 공유하는 순수 판정 로직.
 * pgvector는 vector(1536)·vector(384) 모두 udt_name을 'vector'로 보고하므로
 * 타입 이름 단독 비교는 차원 변경을 감지하지 못한다. pg_attribute.atttypmod가
 * 선언 차원을 담으므로 (타입, 차원) 쌍으로 판정해야 한다.
 */

/**
 * EMBEDDING_DIMENSIONS로부터 목표 컬럼 스펙을 도출한다.
 * 2000차원 초과는 pgvector HNSW 인덱스 한계로 halfvec을 사용한다.
 *
 * @param {number} dims
 * @returns {{dims: number, udtName: string, colType: string, opsType: string, useHalfvec: boolean}}
 */
export function resolveEmbeddingColumnSpec(dims) {
  const useHalfvec = dims > 2000;
  return {
    dims,
    udtName   : useHalfvec ? "halfvec" : "vector",
    colType   : useHalfvec ? `halfvec(${dims})` : `vector(${dims})`,
    opsType   : useHalfvec ? "halfvec_cosine_ops" : "vector_cosine_ops",
    useHalfvec,
  };
}

/**
 * 현재 컬럼 상태와 목표 스펙을 비교한다. 일치하면 null, 불일치면 사유 객체를 반환한다.
 *
 * @param {{udtName: string, declaredDim: number|null}|null} current
 *   - declaredDim: pg_attribute.atttypmod 유래 선언 차원. 무차원 선언(-1)은 null로 정규화해 전달한다.
 * @param {{dims: number, udtName: string}} spec
 * @returns {{reason: string, detail: string}|null}
 */
export function embeddingColumnMismatch(current, spec) {
  if (!current) {
    return { reason: "column_missing", detail: "embedding 컬럼이 존재하지 않는다" };
  }
  if (current.udtName !== spec.udtName) {
    return {
      reason: "type_mismatch",
      detail: `컬럼 타입 ${current.udtName} ≠ 목표 ${spec.udtName}`
    };
  }
  if (current.declaredDim == null) {
    return {
      reason: "dimension_unspecified",
      detail: `컬럼이 무차원 ${current.udtName}로 선언되어 있어 목표 ${spec.dims}차원 고정이 필요하다`
    };
  }
  if (current.declaredDim !== spec.dims) {
    return {
      reason: "dimension_mismatch",
      detail: `선언 차원 ${current.declaredDim} ≠ 설정 차원 ${spec.dims}`
    };
  }
  return null;
}

/**
 * embedding 컬럼의 (타입, 선언 차원)을 조회한다. 컬럼 미존재 시 null.
 *
 * @param {import('pg').Pool} pool
 * @param {string} schema
 * @param {string} table
 * @returns {Promise<{udtName: string, declaredDim: number|null}|null>}
 */
export async function fetchEmbeddingColumn(pool, schema, table) {
  const { rows } = await pool.query(
    `SELECT t.typname AS udt_name,
            CASE WHEN a.atttypmod > 0 THEN a.atttypmod ELSE NULL END AS declared_dim
     FROM pg_attribute a
     JOIN pg_class     c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_type      t ON t.oid = a.atttypid
     WHERE n.nspname = $1 AND c.relname = $2
       AND a.attname = 'embedding' AND a.attnum > 0 AND NOT a.attisdropped`,
    [schema, table]
  );
  if (rows.length === 0) return null;
  return { udtName: rows[0].udt_name, declaredDim: rows[0].declared_dim };
}
