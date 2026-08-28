/**
 * 키 격리 변형 4종 동작 고정 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * 호출부를 keyScope 모듈로 옮기는 동안 의미가 바뀌지 않았음을 판정한다.
 * 각 변형이 만들어내는 SQL 문자열과 바인딩 순서를 그대로 고정한다.
 *
 * 네 변형의 차이는 세 축이다. 그룹 공유 허용 여부, 전역 파편 포함 여부,
 * keyId가 null일 때의 처리. 이 시험은 그 축들을 각각 못 박는다.
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";

import {
  keyScopeClause,
  keyScopeScalar,
  keyScopeGroup,
  keyScopeNullable
} from "../../lib/memory/keyScope.js";

describe("keyScopeClause — 그룹 공유 허용", () => {
  test("스칼라와 그룹 배열을 함께 바인딩한다", () => {
    const params = ["앞선값"];
    const sql    = keyScopeClause(params, "f.key_id", { keyId: "k1", groupKeyIds: ["k1", "k2"] });
    assert.equal(sql, " AND (f.key_id IS NOT DISTINCT FROM $2 OR f.key_id = ANY($3::text[]))");
    assert.deepEqual(params, ["앞선값", "k1", ["k1", "k2"]]);
  });

  test("그룹이 없으면 자신의 키 하나짜리 배열을 쓴다", () => {
    const params = [];
    keyScopeClause(params, "key_id", { keyId: "k1" });
    assert.deepEqual(params, ["k1", ["k1"]]);
  });

  test("빈 그룹 배열은 그룹 미지정과 같게 다룬다", () => {
    const params = [];
    keyScopeClause(params, "key_id", { keyId: "k1", groupKeyIds: [] });
    assert.deepEqual(params, ["k1", ["k1"]]);
  });

  test("마스터(null)는 빈 절을 내고 바인딩하지 않는다", () => {
    const params = [];
    assert.equal(keyScopeClause(params, "key_id", { keyId: null }), "");
    assert.deepEqual(params, []);
  });
});

describe("keyScopeScalar — 그룹 공유 없음", () => {
  test("자신의 키만 비교한다", () => {
    const params = ["a"];
    const sql    = keyScopeScalar(params, "key_id", "k1");
    assert.equal(sql, " AND key_id = $2");
    assert.deepEqual(params, ["a", "k1"]);
  });

  test("마스터(null)는 빈 절을 낸다", () => {
    const params = [];
    assert.equal(keyScopeScalar(params, "key_id", null), "");
    assert.deepEqual(params, []);
  });

  test("전역 파편을 매칭하지 않는다는 사실을 SQL 형태로 고정한다", () => {
    assert.doesNotMatch(keyScopeScalar([], "key_id", "k1"), /IS NULL|IS NOT DISTINCT/);
  });
});

describe("keyScopeGroup — 미리 계산된 키 목록", () => {
  test("배열 하나를 text[]로 바인딩한다", () => {
    const params = [];
    const sql    = keyScopeGroup(params, "q.key_id", ["k1", "k2"]);
    assert.equal(sql, " AND q.key_id = ANY($1::text[])");
    assert.deepEqual(params, [["k1", "k2"]]);
  });

  test("null은 격리 없음이므로 빈 절을 낸다", () => {
    const params = [];
    assert.equal(keyScopeGroup(params, "key_id", null), "");
    assert.deepEqual(params, []);
  });

  test("빈 배열은 접근 가능한 키가 없다는 뜻이므로 절을 낸다", () => {
    const params = [];
    assert.equal(keyScopeGroup(params, "key_id", []), " AND key_id = ANY($1::text[])");
    assert.deepEqual(params, [[]]);
  });
});

describe("keyScopeNullable — NULL 동치", () => {
  test("keyId가 null이어도 절을 내고 null을 바인딩한다", () => {
    const params = [];
    const sql    = keyScopeNullable(params, "c.key_id", null);
    assert.equal(sql, " AND c.key_id IS NOT DISTINCT FROM $1");
    assert.deepEqual(params, [null]);
  });

  test("null일 때 전역 파편만 매칭한다는 점에서 다른 변형과 다르다", () => {
    assert.equal(keyScopeNullable([], "key_id", null), " AND key_id IS NOT DISTINCT FROM $1");
    assert.equal(keyScopeScalar([], "key_id", null), "");
    assert.equal(keyScopeClause([], "key_id", { keyId: null }), "");
  });
});

describe("변형 간 바인딩 인덱스 정합", () => {
  test("연속 호출 시 인덱스가 이어진다", () => {
    const params = [];
    const a = keyScopeScalar(params, "a.key_id", "k1");
    const b = keyScopeGroup(params, "b.key_id", ["k1", "k2"]);
    const c = keyScopeNullable(params, "c.key_id", "k1");
    assert.equal(a, " AND a.key_id = $1");
    assert.equal(b, " AND b.key_id = ANY($2::text[])");
    assert.equal(c, " AND c.key_id IS NOT DISTINCT FROM $3");
    assert.equal(params.length, 3);
  });

  test("빈 절을 낸 변형은 인덱스를 소비하지 않는다", () => {
    const params = [];
    keyScopeScalar(params, "a.key_id", null);
    const b = keyScopeGroup(params, "b.key_id", ["k1"]);
    assert.equal(b, " AND b.key_id = ANY($1::text[])");
  });
});
