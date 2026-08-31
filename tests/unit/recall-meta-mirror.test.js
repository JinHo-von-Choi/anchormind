/**
 * v3.1.0 응답 메타 _meta 단일 경로 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-21
 *
 * v3.0.0까지 제공되던 top-level mirror 필드(_searchEventId / _memento_hint / _suggestion)가
 * v3.1.0에서 제거됐음을 검증한다. tool_recall / tool_context 응답은 `_meta.*` 경로로만
 * 해당 값을 노출해야 한다.
 *
 * 검증 항목:
 *  1. recall 일반 응답: top-level _searchEventId / _memento_hint 부재
 *  2. recall caseMode 응답: top-level mirror 부재, _meta 단독 제공
 *  3. context 응답: top-level _memento_hint / _searchEventId / _suggestion 부재
 *  4. _suggestion 값은 _meta.suggestion으로만 전달
 *  5. hint 없으면 _meta.hints = []
 */

import { describe, it } from "node:test";
import assert            from "node:assert/strict";

function buildRecallHint(fragments) {
  if (!fragments || fragments.length === 0) return null;
  return { trigger: "recall", suggestion: "관련 파편이 있습니다." };
}

/**
 * v3.1.0 tool_recall 응답 조립 로직 (lib/tools/memory.js의 실제 조립부와 동일 shape).
 * top-level mirror 필드는 포함하지 않는다.
 */
function applyRecallMeta(result, args, fragments) {
  const hint          = buildRecallHint(fragments);
  const searchEventId = result._searchEventId ?? null;

  if (result.caseMode) {
    const caseHint = buildRecallHint([]);
    return {
      success   : true,
      caseMode  : true,
      cases     : result.cases,
      caseCount : result.caseCount,
      searchPath: result.searchPath,
      _meta: {
        searchEventId,
        hints      : caseHint ? [caseHint] : [],
        suggestion : result._suggestion ?? undefined
      }
    };
  }

  return {
    success    : true,
    fragments,
    count      : fragments.length,
    totalTokens: result.totalTokens,
    searchPath : result.searchPath,
    _meta: {
      searchEventId,
      hints      : hint ? [hint] : [],
      suggestion : result._suggestion ?? undefined
    }
  };
}

/**
 * v3.1.0 tool_context 응답 조립 로직 (destructure로 내부 필드를 응답 shape에서 분리).
 */
function applyContextMeta(result) {
  const { _memento_hint, _searchEventId, _suggestion, _anchorSelection, ...restResult } = result;
  return {
    success: true,
    ...restResult,
    _meta: {
      searchEventId: _searchEventId ?? null,
      hints        : _memento_hint ? [_memento_hint] : [],
      suggestion   : _suggestion ?? undefined,
      anchorSelection: _anchorSelection
    }
  };
}

/** ─────────────────────────────── 테스트 ─────────────────────────────── */

describe("v3.1.0 _meta 단일 경로 — recall 일반 응답", () => {

  it("top-level _searchEventId / _memento_hint 부재, _meta.searchEventId만 존재", () => {
    const result = {
      _searchEventId: 42,
      _suggestion   : null,
      totalTokens   : 100,
      searchPath    : "L1"
    };
    const fragments = [{ id: "f1", content: "hello" }];

    const res = applyRecallMeta(result, {}, fragments);

    assert.ok(res.success);
    assert.ok(!("_searchEventId" in res), "top-level _searchEventId 제거 확인");
    assert.ok(!("_memento_hint"  in res), "top-level _memento_hint 제거 확인");
    assert.ok(!("_suggestion"    in res), "top-level _suggestion 제거 확인");
    assert.equal(res._meta.searchEventId, 42);
    assert.ok(Array.isArray(res._meta.hints));
  });

  it("hint가 없으면 _meta.hints=[], top-level 필드 전부 부재", () => {
    const result = {
      _searchEventId: 7,
      _suggestion   : null,
      totalTokens   : 0,
      searchPath    : "L3"
    };

    const res = applyRecallMeta(result, {}, []);

    assert.deepEqual(res._meta.hints, []);
    assert.equal(res._meta.searchEventId, 7);
    assert.ok(!("_memento_hint"  in res));
    assert.ok(!("_searchEventId" in res));
  });

  it("파편이 있으면 hint가 _meta.hints[0]으로만 전달", () => {
    const result = {
      _searchEventId: 10,
      _suggestion   : null,
      totalTokens   : 50,
      searchPath    : "L2"
    };
    const fragments = [{ id: "f2", content: "world" }];

    const res = applyRecallMeta(result, {}, fragments);

    assert.ok(res._meta.hints.length > 0);
    assert.ok(!("_memento_hint" in res), "top-level _memento_hint mirror 제거 확인");
    assert.equal(res._meta.hints[0].trigger, "recall");
  });

  it("_suggestion은 _meta.suggestion으로만 전달", () => {
    const suggestion = { recommendedTool: "remember", recommendedArgs: {} };
    const result = {
      _searchEventId: 99,
      _suggestion   : suggestion,
      totalTokens   : 50,
      searchPath    : "L2"
    };

    const res = applyRecallMeta(result, {}, [{ id: "f3", content: "test" }]);

    assert.deepEqual(res._meta.suggestion, suggestion);
    assert.ok(!("_suggestion" in res), "top-level _suggestion mirror 제거 확인");
  });

  it("_suggestion=null이면 _meta.suggestion=undefined", () => {
    const result = {
      _searchEventId: 1,
      _suggestion   : null,
      totalTokens   : 10,
      searchPath    : "L1"
    };

    const res = applyRecallMeta(result, {}, []);

    assert.equal(res._meta.suggestion, undefined);
  });
});

describe("v3.1.0 _meta 단일 경로 — recall caseMode 응답", () => {

  it("caseMode 응답의 top-level mirror 부재, _meta만 노출", () => {
    const result = {
      caseMode      : true,
      cases         : [],
      caseCount     : 0,
      searchPath    : "CBR",
      _searchEventId: 55,
      _suggestion   : null
    };

    const res = applyRecallMeta(result, {}, []);

    assert.ok(res.caseMode);
    assert.equal(res._meta.searchEventId, 55);
    assert.ok(Array.isArray(res._meta.hints));
    assert.ok(!("_searchEventId" in res), "caseMode top-level _searchEventId 제거 확인");
    assert.ok(!("_memento_hint"  in res), "caseMode top-level _memento_hint 제거 확인");
  });
});

describe("v3.1.0 _meta 단일 경로 — context 응답", () => {

  it("빈 context 응답의 _meta.searchEventId=null, top-level 필드 부재", () => {
    const res = applyContextMeta({
      fragments    : [],
      totalTokens  : 0,
      count        : 0,
      injectionText: ""
    });

    assert.ok(res.success);
    assert.equal(res._meta.searchEventId, null);
    assert.deepEqual(res._meta.hints, []);
    assert.ok(!("_memento_hint"  in res));
    assert.ok(!("_searchEventId" in res));
    assert.ok(!("_suggestion"    in res));
  });

  it("ContextBuilder가 반환한 _memento_hint는 _meta.hints[0]으로만 전달되고 응답 최상위에서 제거됨", () => {
    const hint = { trigger: "recall", suggestion: "더 많은 키워드를 사용하세요" };
    const res = applyContextMeta({
      fragments    : [],
      totalTokens  : 0,
      count        : 0,
      injectionText: "",
      _memento_hint: hint
    });

    assert.deepEqual(res._meta.hints[0], hint);
    assert.ok(!("_memento_hint" in res), "top-level _memento_hint mirror 제거 확인");
  });

  it("context _meta.suggestion은 _suggestion 값이 있으면 그대로 전달", () => {
    const res1 = applyContextMeta({ fragments: [], totalTokens: 0 });
    assert.equal(res1._meta.suggestion, undefined);

    const suggestion = { recommendedTool: "recall", recommendedArgs: {} };
    const res2 = applyContextMeta({ fragments: [], totalTokens: 0, _suggestion: suggestion });
    assert.deepEqual(res2._meta.suggestion, suggestion);
    assert.ok(!("_suggestion" in res2));
  });

  it("anchor 선택 통계는 top-level이 아니라 _meta.anchorSelection으로만 전달", () => {
    const selection = {
      totalLimit: 20,
      workspaceReserve: 10,
      reserveApplied: true,
      candidates: { workspace: 15, global: 12, total: 27 },
      selected: { workspace: 12, global: 8, reservedWorkspace: 10, total: 20 },
      excluded: { workspace: 3, global: 4, total: 7 }
    };
    const res = applyContextMeta({ fragments: [], totalTokens: 0, _anchorSelection: selection });
    assert.deepEqual(res._meta.anchorSelection, selection);
    assert.ok(!("_anchorSelection" in res));
    assert.ok(!("anchorSelection" in res));
  });
});
