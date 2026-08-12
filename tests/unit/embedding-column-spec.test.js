/**
 * 임베딩 컬럼 (타입, 차원) 스펙 판정 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-08-12
 *
 * pgvector가 vector(1536)·vector(384) 모두 udt_name='vector'로 보고하는 특성 때문에
 * 타입 이름 단독 비교가 차원 변경을 스킵하던 회귀를 방지한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { resolveEmbeddingColumnSpec, embeddingColumnMismatch }
  from "../../lib/memory/embedding/column-spec.js";

describe("resolveEmbeddingColumnSpec", () => {
  it("2000차원 이하는 vector, 초과는 halfvec", () => {
    assert.equal(resolveEmbeddingColumnSpec(1536).udtName, "vector");
    assert.equal(resolveEmbeddingColumnSpec(1536).colType, "vector(1536)");
    assert.equal(resolveEmbeddingColumnSpec(384).colType, "vector(384)");
    assert.equal(resolveEmbeddingColumnSpec(3072).udtName, "halfvec");
    assert.equal(resolveEmbeddingColumnSpec(3072).opsType, "halfvec_cosine_ops");
  });
});

describe("embeddingColumnMismatch", () => {
  const spec384 = resolveEmbeddingColumnSpec(384);

  it("같은 타입·다른 차원(vector(1536) vs 384 설정)을 불일치로 판정한다", () => {
    const m = embeddingColumnMismatch({ udtName: "vector", declaredDim: 1536 }, spec384);
    assert.ok(m, "차원 불일치가 스킵됐다 (이슈 #54 회귀)");
    assert.equal(m.reason, "dimension_mismatch");
  });

  it("타입·차원 모두 일치하면 null", () => {
    assert.equal(embeddingColumnMismatch({ udtName: "vector", declaredDim: 384 }, spec384), null);
  });

  it("타입 불일치(halfvec vs vector)를 판정한다", () => {
    const m = embeddingColumnMismatch({ udtName: "halfvec", declaredDim: 384 }, spec384);
    assert.equal(m.reason, "type_mismatch");
  });

  it("무차원 선언(atttypmod=-1 → null)을 불일치로 판정한다", () => {
    const m = embeddingColumnMismatch({ udtName: "vector", declaredDim: null }, spec384);
    assert.equal(m.reason, "dimension_unspecified");
  });

  it("컬럼 부재를 판정한다", () => {
    const m = embeddingColumnMismatch(null, spec384);
    assert.equal(m.reason, "column_missing");
  });
});
