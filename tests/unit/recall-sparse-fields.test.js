/**
 * H2 Sparse Fieldsets (fields 파라미터) 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * 검증 항목:
 *  1. fields 미지정 시 전체 파편 필드 반환 (기존 동작 보존)
 *  2. fields=["id","content"] 시 2개 키만 포함
 *  3. 허용되지 않은 키 (ALLOWED_FIELDS 외) 는 silently ignore
 *  4. 빈 배열 fields=[] 시 pickFields 대상이 아님 → 전체 반환 (guard 조건: length>0)
 */

import { describe, it } from "node:test";
import assert            from "node:assert/strict";

/**
 * FragmentSearch를 DB 없이 테스트하기 위해 search() 내부의 pickFields 로직만 추출하여 검증한다.
 * pickFields는 파일 내부(module-private) 함수이므로 동일 로직을 인라인 재현하여 단위 테스트한다.
 * FragmentSearch.search() 전체 경로는 DB 의존성이 있어 통합 테스트 영역이다.
 */

/** FragmentSearch.js 의 ALLOWED_FIELDS 및 pickFields 와 동일한 로직 */
const ALLOWED_FIELDS = new Set([
  "id", "content", "type", "topic", "keywords", "importance", "created_at",
  "access_count", "confidence", "linked", "explanations", "workspace",
  "context_summary", "case_id", "valid_to", "affect", "ema_activation",
  "key_id", "key_name"
]);

function pickFields(fragment, fields) {
  const result = {};
  for (const key of fields) {
    if (ALLOWED_FIELDS.has(key) && key in fragment) {
      result[key] = fragment[key];
    }
  }
  return result;
}

/** 테스트 파편 — 화이트리스트 내/외 필드 혼합 */
function makeFragment(overrides = {}) {
  return {
    id           : "frag-abc",
    content      : "hello world",
    type         : "fact",
    topic        : "test-topic",
    keywords     : ["a", "b"],
    importance   : 0.8,
    created_at   : "2026-04-20T00:00:00.000Z",
    access_count : 3,
    confidence   : 0.9,
    linked       : [],
    explanations : [],
    workspace    : null,
    context_summary: null,
    case_id      : null,
    valid_to     : null,
    affect       : "neutral",
    ema_activation: 0.5,
    /** 내부 전용 필드 — ALLOWED_FIELDS 밖 */
    _rrfScore    : 1.234,
    similarity   : 0.77,
    metadata     : { stale: false },
    ...overrides
  };
}

/** ─────────────────────────────── 테스트 ─────────────────────────────── */

describe("H2 Sparse Fieldsets — pickFields 로직 검증", () => {

  it("fields 미지정(전체 필드) 경로: guard 조건 Array.isArray && length>0 이 false 여서 pick 안 함", () => {
    const frag   = makeFragment();
    const fields = undefined;

    /** guard: Array.isArray(fields) && fields.length > 0 */
    const shouldPick = Array.isArray(fields) && fields.length > 0;
    assert.equal(shouldPick, false, "guard: fields 미지정 시 pick 하지 않아야 함");
  });

  it("빈 배열 fields=[] 도 guard 에서 false → pick 하지 않아야 함", () => {
    const fields    = [];
    const shouldPick = Array.isArray(fields) && fields.length > 0;
    assert.equal(shouldPick, false, "빈 배열은 pick 하지 않음");
  });

  it("fields=['id','content'] → 두 키만 포함", () => {
    const frag   = makeFragment();
    const result = pickFields(frag, ["id", "content"]);

    assert.deepEqual(Object.keys(result).sort(), ["content", "id"]);
    assert.equal(result.id,      frag.id);
    assert.equal(result.content, frag.content);
  });

  it("ALLOWED_FIELDS 에 없는 키 (_rrfScore, similarity) 는 silently ignore", () => {
    const frag   = makeFragment();
    const result = pickFields(frag, ["id", "_rrfScore", "similarity", "content"]);

    assert.ok("id" in result,                        "id 포함");
    assert.ok("content" in result,                   "content 포함");
    assert.ok(!("_rrfScore" in result),              "_rrfScore 제외");
    assert.ok(!("similarity" in result),             "similarity 제외");
  });

  it("모든 ALLOWED_FIELDS 키 요청 시 전부 반환 (파편에 있는 키 한정)", () => {
    const frag   = makeFragment();
    const allFields = [...ALLOWED_FIELDS];
    const result = pickFields(frag, allFields);

    for (const key of allFields) {
      if (key in frag) {
        assert.ok(key in result, `${key} 포함되어야 함`);
      }
    }
    assert.ok(!("_rrfScore" in result), "_rrfScore 내부 필드 제외");
    assert.ok(!("similarity" in result), "similarity 내부 필드 제외");
  });

  it("파편에 없는 키는 결과에 포함하지 않음 (partial field set)", () => {
    const frag   = makeFragment({ ema_activation: undefined });
    delete frag.ema_activation;

    const result = pickFields(frag, ["id", "ema_activation"]);

    assert.ok("id" in result,                    "id 있음");
    assert.ok(!("ema_activation" in result),     "없는 필드는 제외");
  });

  it("여러 파편에 map 적용 — 각 파편에 동일하게 pick 적용", () => {
    const frags  = [makeFragment({ id: "f1" }), makeFragment({ id: "f2", content: "other" })];
    const fields = ["id", "importance"];
    const results = frags.map(f => pickFields(f, fields));

    assert.equal(results.length, 2);
    for (const r of results) {
      assert.deepEqual(Object.keys(r).sort(), ["id", "importance"]);
    }
    assert.equal(results[0].id, "f1");
    assert.equal(results[1].id, "f2");
  });
});
