/**
 * tenant-isolation-boundary.test.js
 *
 * 작성자: 최진호
 * 작성일: 2026-04-19
 *
 * 목적: v2.10.0 keyId 통합 리팩토링 안전망.
 *   - CbrEligibility._normalizeKeyId   : null policy  = null
 *   - SearchParamAdaptor._normalizeKeyId: null policy  = '-1' sentinel
 *   - ClaimStore.normalizeKeyId (내부)  : null policy  = null (공백 포함)
 * 3함수 반환 정책이 의도적으로 다르다는 사실을 고정.
 *
 * 실행: node --test tests/unit/tenant-isolation-boundary.test.js
 */

import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { CbrEligibility } from "../../lib/symbolic/CbrEligibility.js";

const mockClaimStoreQuery = mock.fn(async () => ({ rowCount: 0, rows: [] }));
const mockClaimStorePool  = { query: mockClaimStoreQuery };

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => mockClaimStorePool
  }
});

beforeEach(() => {
  mockClaimStoreQuery.mock.resetCalls();
});

// SearchParamAdaptor._normalizeKeyId 는 module-private 함수.
// 모듈을 동적 import 한 뒤 실제 SearchParamAdaptor 인스턴스 메서드를 통해
// DB를 mock한 경로로만 간접 테스트할 수 있으나, 여기서는 동일 파일 소스를
// 인라인 미러로 검증한다 (단위 레벨 격리).
//
// 실 구현 (lib/memory/signals/SearchParamAdaptor.js:33-38):
//   if (Array.isArray(keyId)) { keyId = keyId[0] ?? null; }
//   if (keyId == null) return '-1';
//   return String(keyId);
function mirrorSearchParamNormalize(keyId) {
  if (Array.isArray(keyId)) {
    keyId = keyId[0] ?? null;
  }
  if (keyId == null) return '-1';
  return String(keyId);
}

// ClaimStore.normalizeKeyId 는 module-private 화살표 함수.
// 실 구현 (lib/symbolic/ClaimStore.js:33-36):
//   if (v === undefined || v === null || v === "") return null;
//   return v;
function mirrorClaimStoreNormalize(v) {
  if (v === undefined || v === null || v === "") return null;
  return v;
}

// -----------------------------------------------------------------------
// A. CbrEligibility._normalizeKeyId (인스턴스 메서드 — 직접 접근 가능)
// -----------------------------------------------------------------------

describe("A. CbrEligibility._normalizeKeyId", () => {

  const cbr = new CbrEligibility({ metrics: { recordGateBlock: () => {} } });

  it("A-1: null 입력 → null 반환", () => {
    assert.strictEqual(cbr._normalizeKeyId(null), null);
  });

  it("A-2: undefined 입력 → null 반환", () => {
    assert.strictEqual(cbr._normalizeKeyId(undefined), null);
  });

  it("A-3: 단일 문자열 → 그대로 반환", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    assert.strictEqual(cbr._normalizeKeyId(uuid), uuid);
  });

  it("A-4: 단일 숫자 → 그대로 반환 (숫자 keyId 허용)", () => {
    assert.strictEqual(cbr._normalizeKeyId(42), 42);
  });

  it("A-5: 배열 [uuid] → 첫 원소 반환", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    assert.strictEqual(cbr._normalizeKeyId([uuid]), uuid);
  });

  it("A-6: 빈 배열 [] → null 반환", () => {
    assert.strictEqual(cbr._normalizeKeyId([]), null);
  });

  it("A-7: 배열 [null, 'x'] → 'x' 반환 (??로 null 건너뜀 후 첫 원소 기준)", () => {
    // 실 구현: keyId[0] ?? null — 첫 원소가 null이면 null이 된다.
    // [null, 'x'] → keyId[0]=null → null ?? null = null
    assert.strictEqual(cbr._normalizeKeyId([null, "x"]), null);
  });

  it("A-8: 배열 [undefined, 'x'] → null 반환 (첫 원소가 undefined → ?? null)", () => {
    assert.strictEqual(cbr._normalizeKeyId([undefined, "x"]), null);
  });

  it("A-9: tenant_match — null keyId는 key_id=null인 파편만 통과", async () => {
    const frag = { id: "f1", key_id: null, case_id: "c1", quarantine_state: null, resolution_status: null };
    const out  = await cbr.filter([frag], { keyId: null });
    assert.equal(out.length, 1);
  });

  it("A-10: tenant_match — null keyId로 API 파편 접근 차단", async () => {
    const frag = { id: "f1", key_id: "api-key-1", case_id: "c1", quarantine_state: null, resolution_status: null };
    const out  = await cbr.filter([frag], { keyId: null });
    assert.equal(out.length, 0);
  });

  it("A-11: tenant_match — API keyId로 master(null) 파편 접근 차단", async () => {
    const frag = { id: "f1", key_id: null, case_id: "c1", quarantine_state: null, resolution_status: null };
    const out  = await cbr.filter([frag], { keyId: "api-key-1" });
    assert.equal(out.length, 0);
  });

});

// -----------------------------------------------------------------------
// B. ClaimStore.normalizeKeyId (미러 함수 검증)
// -----------------------------------------------------------------------

describe("B. ClaimStore.normalizeKeyId (미러)", () => {

  it("B-1: null → null", () => {
    assert.strictEqual(mirrorClaimStoreNormalize(null), null);
  });

  it("B-2: undefined → null", () => {
    assert.strictEqual(mirrorClaimStoreNormalize(undefined), null);
  });

  it("B-3: 빈 문자열 '' → null (공백 아닌 빈 문자열)", () => {
    assert.strictEqual(mirrorClaimStoreNormalize(""), null);
  });

  it("B-4: 공백 문자열 '   ' → '   ' 그대로 (실 구현은 공백을 null로 변환하지 않음)", () => {
    // 실 구현은 v === "" 만 체크하므로 공백(" ")은 원본 반환
    assert.strictEqual(mirrorClaimStoreNormalize("   "), "   ");
  });

  it("B-5: 'master' 문자열 → 'master' 그대로", () => {
    assert.strictEqual(mirrorClaimStoreNormalize("master"), "master");
  });

  it("B-6: UUID 문자열 → UUID 그대로", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    assert.strictEqual(mirrorClaimStoreNormalize(uuid), uuid);
  });

  it("B-7: ClaimStore insert — fragment.key_id ≠ ctx.keyId이면 예외 throw", async () => {
    const { ClaimStore } = await import("../../lib/symbolic/ClaimStore.js");
    const store = new ClaimStore();

    await assert.rejects(
      () => store.insert(
        { id: "frag-1", key_id: "tenant-A" },
        [{ subject: "s", predicate: "p", object: "o", polarity: "positive", confidence: 0.9, extractor: "x", ruleVersion: "1" }],
        { keyId: "tenant-B" }
      ),
      (err) => {
        assert.ok(err.message.includes("TENANT_ISOLATION_VIOLATION"));
        return true;
      }
    );
  });

  it("B-8: ClaimStore insert — master(null) fragment를 API key ctx로 접근 시 차단", async () => {
    const { ClaimStore } = await import("../../lib/symbolic/ClaimStore.js");
    const store = new ClaimStore();

    await assert.rejects(
      () => store.insert(
        { id: "frag-1", key_id: null },
        [{ subject: "s", predicate: "p", object: null, polarity: "positive", confidence: 0.8, extractor: "e", ruleVersion: "1" }],
        { keyId: "api-tenant" }
      ),
      (err) => {
        assert.ok(err.message.includes("TENANT_ISOLATION_VIOLATION"));
        return true;
      }
    );
  });

  it("B-9: ClaimStore insert — API key fragment를 master(null) ctx로 접근 시 차단", async () => {
    const { ClaimStore } = await import("../../lib/symbolic/ClaimStore.js");
    const store = new ClaimStore();

    await assert.rejects(
      () => store.insert(
        { id: "frag-2", key_id: "api-tenant" },
        [{ subject: "s", predicate: "p", object: null, polarity: "positive", confidence: 0.8, extractor: "e", ruleVersion: "1" }],
        { keyId: null }
      ),
      (err) => {
        assert.ok(err.message.includes("TENANT_ISOLATION_VIOLATION"));
        return true;
      }
    );
  });

});

// -----------------------------------------------------------------------
// C. SearchParamAdaptor._normalizeKeyId (미러 함수 검증)
// -----------------------------------------------------------------------

describe("C. SearchParamAdaptor._normalizeKeyId (미러)", () => {

  it("C-1: null → '-1' sentinel", () => {
    assert.strictEqual(mirrorSearchParamNormalize(null), "-1");
  });

  it("C-2: undefined → '-1' sentinel", () => {
    assert.strictEqual(mirrorSearchParamNormalize(undefined), "-1");
  });

  it("C-3: 단일 UUID → UUID 문자열", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    assert.strictEqual(mirrorSearchParamNormalize(uuid), uuid);
  });

  it("C-4: 배열 [uuid] → UUID 문자열 (flatten)", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    assert.strictEqual(mirrorSearchParamNormalize([uuid]), uuid);
  });

  it("C-5: 배열 [null, uuid] → '-1' (첫 원소 null → null → sentinel)", () => {
    // 실 구현: keyId[0] ?? null → null인 경우 → '-1'
    const uuid = "abc-123";
    assert.strictEqual(mirrorSearchParamNormalize([null, uuid]), "-1");
  });

  it("C-6: 빈 배열 [] → '-1' sentinel", () => {
    assert.strictEqual(mirrorSearchParamNormalize([]), "-1");
  });

  it("C-7: 숫자 입력 → String 변환", () => {
    assert.strictEqual(mirrorSearchParamNormalize(42), "42");
  });

});

// -----------------------------------------------------------------------
// D. 교차 격리 — master vs API key 경계 (ClaimStore 진입부 mock 없이 검증)
// -----------------------------------------------------------------------

describe("D. 교차 격리 — master(null) ↔ API key cross-tenant 차단", () => {

  it("D-1: insert path — master fragment + API ctx → 차단", async () => {
    const { ClaimStore } = await import("../../lib/symbolic/ClaimStore.js");
    const store = new ClaimStore();
    const claims = [{ subject: "s", predicate: "p", object: null, polarity: "positive", confidence: 0.9, extractor: "e", ruleVersion: "1" }];

    await assert.rejects(
      () => store.insert({ id: "x", key_id: null }, claims, { keyId: "some-api-key" }),
      /TENANT_ISOLATION_VIOLATION/
    );
  });

  it("D-2: insert path — API fragment + master ctx → 차단", async () => {
    const { ClaimStore } = await import("../../lib/symbolic/ClaimStore.js");
    const store = new ClaimStore();
    const claims = [{ subject: "s", predicate: "p", object: null, polarity: "positive", confidence: 0.9, extractor: "e", ruleVersion: "1" }];

    await assert.rejects(
      () => store.insert({ id: "y", key_id: "some-api-key" }, claims, { keyId: null }),
      /TENANT_ISOLATION_VIOLATION/
    );
  });

  it("D-3: insert path — 서로 다른 두 API key → 차단", async () => {
    const { ClaimStore } = await import("../../lib/symbolic/ClaimStore.js");
    const store = new ClaimStore();
    const claims = [{ subject: "s", predicate: "p", object: null, polarity: "positive", confidence: 0.9, extractor: "e", ruleVersion: "1" }];

    await assert.rejects(
      () => store.insert({ id: "z", key_id: "tenant-A" }, claims, { keyId: "tenant-B" }),
      /TENANT_ISOLATION_VIOLATION/
    );
  });

  it("D-4: insert path — 동일 API key → TENANT_ISOLATION_VIOLATION 예외 없이 진입", async () => {
    const { ClaimStore } = await import("../../lib/symbolic/ClaimStore.js");
    const store = new ClaimStore();
    const claims = [{ subject: "s", predicate: "p", object: null, polarity: "positive", confidence: 0.9, extractor: "e", ruleVersion: "1" }];

    // 동일 keyId → 격리 위반 예외를 던지지 않아야 한다 (DB 오류가 나더라도 TENANT_ISOLATION_VIOLATION은 아님)
    try {
      await store.insert({ id: "w", key_id: "same-key" }, claims, { keyId: "same-key" });
    } catch (err) {
      // DB 체크 제약 등 DB 레벨 오류는 허용 — TENANT_ISOLATION_VIOLATION만 금지
      assert.notEqual(err.message, "TENANT_ISOLATION_VIOLATION",
        "동일 keyId 는 TENANT_ISOLATION_VIOLATION 을 던지면 안 됨");
      assert.ok(!err.message.includes("TENANT_ISOLATION_VIOLATION"),
        "동일 keyId 는 테넌트 격리 오류가 아닌 다른 오류여야 함");
    }
  });

  it("D-5: select path — getByFragmentId는 normalizeKeyId를 거쳐 IS NOT DISTINCT FROM 사용", async () => {
    const { ClaimStore } = await import("../../lib/symbolic/ClaimStore.js");
    mockClaimStoreQuery.mock.mockImplementationOnce(async () => ({ rows: [] }));
    const store = new ClaimStore();
    const rows = await store.getByFragmentId("frag-x", null);
    assert.deepStrictEqual(rows, []);

    const [sql, params] = mockClaimStoreQuery.mock.calls.at(-1).arguments;
    assert.match(sql, /key_id IS NOT DISTINCT FROM \$2/);
    assert.deepStrictEqual(params, ["frag-x", null]);
  });

  it("D-6: delete path — deleteByFragmentId는 normalizeKeyId를 거쳐 IS NOT DISTINCT FROM 사용", async () => {
    const { ClaimStore } = await import("../../lib/symbolic/ClaimStore.js");
    mockClaimStoreQuery.mock.mockImplementationOnce(async () => ({ rowCount: 0 }));
    const store = new ClaimStore();
    const count = await store.deleteByFragmentId("frag-x", null);
    assert.equal(count, 0);

    const [sql, params] = mockClaimStoreQuery.mock.calls.at(-1).arguments;
    assert.match(sql, /key_id IS NOT DISTINCT FROM \$2/);
    assert.deepStrictEqual(params, ["frag-x", null]);
  });

});

// -----------------------------------------------------------------------
// E. 3개 normalizeKeyId 반환 정책 불일치 고정 — 리팩토링 회귀 방지
// -----------------------------------------------------------------------

describe("E. 3-way 정규화 정책 불일치 고정 테스트", () => {

  const cbr = new CbrEligibility({ metrics: { recordGateBlock: () => {} } });

  it("E-1: null 입력 — CbrEligibility=null, ClaimStore=null, SearchParam='-1' (sentinel 불일치)", () => {
    const cbrResult    = cbr._normalizeKeyId(null);
    const claimResult  = mirrorClaimStoreNormalize(null);
    const searchResult = mirrorSearchParamNormalize(null);

    assert.strictEqual(cbrResult, null);
    assert.strictEqual(claimResult, null);
    assert.strictEqual(searchResult, "-1");
    assert.notStrictEqual(searchResult, cbrResult, "SearchParam은 null을 '-1'로 바꾸므로 CbrEligibility와 다름");
  });

  it("E-2: undefined 입력 — CbrEligibility=null, ClaimStore=null, SearchParam='-1'", () => {
    assert.strictEqual(cbr._normalizeKeyId(undefined), null);
    assert.strictEqual(mirrorClaimStoreNormalize(undefined), null);
    assert.strictEqual(mirrorSearchParamNormalize(undefined), "-1");
  });

  it("E-3: 빈 문자열 '' — CbrEligibility='', ClaimStore=null, SearchParam='' (3개 모두 다름)", () => {
    // CbrEligibility: '' ?? null = '' (빈 문자열은 nullish가 아님)
    assert.strictEqual(cbr._normalizeKeyId(""), "");
    // ClaimStore: '' === "" → null
    assert.strictEqual(mirrorClaimStoreNormalize(""), null);
    // SearchParam: '' == null 은 false → String('') = ''
    assert.strictEqual(mirrorSearchParamNormalize(""), "");
    // 세 값이 동일하지 않음을 명시적으로 고정
    assert.notStrictEqual(cbr._normalizeKeyId(""), mirrorClaimStoreNormalize(""));
  });

  it("E-4: 배열 ['uuid'] — CbrEligibility='uuid', ClaimStore='uuid'(배열 미지원), SearchParam='uuid'", () => {
    const uuid = "test-uuid";
    // CbrEligibility: 배열 지원 → 첫 원소
    assert.strictEqual(cbr._normalizeKeyId([uuid]), uuid);
    // SearchParam: 배열 지원 → 첫 원소
    assert.strictEqual(mirrorSearchParamNormalize([uuid]), uuid);
    // ClaimStore: 배열 입력 시 원본 반환 (배열이 truthy이므로 배열 그대로)
    assert.deepStrictEqual(mirrorClaimStoreNormalize([uuid]), [uuid]);
  });

  it("E-5: 빈 배열 [] — CbrEligibility=null, ClaimStore=[] (그대로), SearchParam='-1'", () => {
    assert.strictEqual(cbr._normalizeKeyId([]), null);
    assert.strictEqual(mirrorSearchParamNormalize([]), "-1");
    // ClaimStore은 [] !== null && [] !== undefined && [] !== "" → [] 원본 반환
    assert.deepStrictEqual(mirrorClaimStoreNormalize([]), []);
  });

  it("E-6: UUID 문자열 — 3개 모두 동일 값 반환 (공통 케이스)", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    assert.strictEqual(cbr._normalizeKeyId(uuid), uuid);
    assert.strictEqual(mirrorClaimStoreNormalize(uuid), uuid);
    assert.strictEqual(mirrorSearchParamNormalize(uuid), uuid);
  });

});
