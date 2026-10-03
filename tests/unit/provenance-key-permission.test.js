/**
 * 키 권한 목록의 trusted_origin 표지 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 관리 API의 권한 검증이 trusted_origin을 read 또는 write와 함께일 때만 받는지, 콘솔 키 상세의 권한
 * 토글이 서버가 받는 값과 같은지 본다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { setupDom, flatQuery } from "./admin-test-helper.js";

setupDom();

const { KEY_PERMISSION_VALUES, validatePermissionList, KeyPolicyValidationError } =
  await import("../../lib/admin/key-policy.js");
const { TRUSTED_ORIGIN_PERMISSION, checkPermission } = await import("../../lib/rbac.js");
const { renderKeyInspector, KEY_PERMISSION_TOGGLES } = await import("../../assets/admin/modules/keys.js");

describe("권한 목록 검증", () => {
  it("서버가 받는 권한 값에 trusted_origin이 있다", () => {
    assert.deepEqual([...KEY_PERMISSION_VALUES], ["read", "write", TRUSTED_ORIGIN_PERMISSION]);
  });

  it("read 또는 write와 함께면 받는다", () => {
    assert.deepEqual(validatePermissionList(["read", "trusted_origin"]), ["read", "trusted_origin"]);
    assert.deepEqual(validatePermissionList(["write", "trusted_origin", "write"]), ["write", "trusted_origin"]);
  });

  it("trusted_origin만 있거나 모르는 값이 있으면 거부한다", () => {
    for (const permissions of [["trusted_origin"], ["read", "admin"], [], null, "read"]) {
      assert.throws(() => validatePermissionList(permissions), KeyPolicyValidationError, JSON.stringify(permissions));
    }
  });

  it("trusted_origin은 도구 허가를 넓히지 않는다", () => {
    assert.equal(checkPermission(["read", "trusted_origin"], "remember").allowed, false);
    assert.equal(checkPermission(["read", "trusted_origin"], "recall").allowed, true);
  });
});

describe("콘솔 권한 토글", () => {
  it("토글 값은 서버가 받는 권한 값과 같다", () => {
    assert.deepEqual([...KEY_PERMISSION_TOGGLES], [...KEY_PERMISSION_VALUES]);
  });

  it("키 상세에 토글마다 단추가 있다", () => {
    const panel  = renderKeyInspector({ id: "k1", name: "K", key_prefix: "m_k", status: "active", permissions: ["read"] });
    const labels = flatQuery(panel, "button").map((b) => b.textContent);
    for (const value of KEY_PERMISSION_TOGGLES) assert.ok(labels.includes(value.toUpperCase()), value);
  });
});
