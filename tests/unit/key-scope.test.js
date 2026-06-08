import { test } from "node:test";
import assert from "node:assert/strict";
import { keyScopeClause } from "../../lib/memory/keyScope.js";

test("keyId null → 빈 절, params 불변 (마스터 전체 접근)", () => {
  const params = ["x"];
  const clause = keyScopeClause(params, "f.key_id", { keyId: null, groupKeyIds: [] });
  assert.equal(clause, "");
  assert.deepEqual(params, ["x"]);
});

test("groupKeyIds 있으면 스칼라+배열 OR 절, params에 [keyId, group] push", () => {
  const params = ["x"];
  const clause = keyScopeClause(params, "f.key_id", { keyId: "k1", groupKeyIds: ["k1", "k2"] });
  assert.equal(clause, " AND (f.key_id IS NOT DISTINCT FROM $2 OR f.key_id = ANY($3::text[]))");
  assert.deepEqual(params, ["x", "k1", ["k1", "k2"]]);
});

test("groupKeyIds 비면 [keyId]로 폴백", () => {
  const params = [];
  keyScopeClause(params, "f2.key_id", { keyId: "k1", groupKeyIds: [] });
  assert.deepEqual(params, ["k1", ["k1"]]);
});

test("두 번 호출 시 각 절이 자기 인덱스 참조 (RCA 멀티컬럼 케이스)", () => {
  const params = ["seed"];
  const seed = keyScopeClause(params, "f.key_id",  { keyId: "k1", groupKeyIds: ["k1"] });
  const link = keyScopeClause(params, "f2.key_id", { keyId: "k1", groupKeyIds: ["k1"] });
  assert.equal(seed, " AND (f.key_id IS NOT DISTINCT FROM $2 OR f.key_id = ANY($3::text[]))");
  assert.equal(link, " AND (f2.key_id IS NOT DISTINCT FROM $4 OR f2.key_id = ANY($5::text[]))");
});
