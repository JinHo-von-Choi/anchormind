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

const {
  KEY_PERMISSION_VALUES, MARKER_PERMISSION_VALUES, isValidPermissionList, validatePermissionList, KeyPolicyValidationError
} = await import("../../lib/admin/key-policy.js");
const { updatePermissions } = await import("../../lib/admin/ApiKeyStore.js");
const { TRUSTED_ORIGIN_PERMISSION, checkPermission } = await import("../../lib/rbac.js");
const { renderKeyInspector, KEY_PERMISSION_TOGGLES } = await import("../../assets/admin/modules/keys.js");

describe("권한 목록 검증", () => {
  it("서버가 받는 권한 값에 trusted_origin이 있다", () => {
    assert.ok(KEY_PERMISSION_VALUES.includes(TRUSTED_ORIGIN_PERMISSION));
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

  it("표지 권한을 뺀 목록이 기존 규칙(read, write로만 이뤄진 비어 있지 않은 배열)을 통과할 때만 받는다", () => {
    assert.deepEqual([...MARKER_PERMISSION_VALUES], ["trusted_origin", "anchor", "review_off", "review_all"]);
    const baseRule = list => list.length > 0 && list.every(p => p === "read" || p === "write");
    const lists = [
      [], ["read"], ["write"], ["read", "write"], ["trusted_origin"], ["trusted_origin", "trusted_origin"],
      ["read", "trusted_origin"], ["write", "trusted_origin"], ["admin"], ["read", "admin"], ["admin", "trusted_origin"]
    ];
    for (const list of lists) {
      const known = list.every(p => KEY_PERMISSION_VALUES.includes(p));
      assert.equal(isValidPermissionList(list), known && baseRule(list.filter(p => p !== "trusted_origin")), JSON.stringify(list));
    }
  });

  it("권한 변경 저장도 같은 규칙으로 빈 배열과 표지만 있는 배열을 거부한다", async () => {
    for (const permissions of [[], ["trusted_origin"]]) {
      await assert.rejects(() => updatePermissions("k1", permissions), /permissions must contain 'read' and\/or 'write'/);
    }
  });

  it("모든 표지 권한(trusted_origin, anchor, review_off, review_all)이 함께 있어도 받고, 표지만 있으면 거부한다", async () => {
    assert.deepEqual([...KEY_PERMISSION_VALUES], ["read", "write", ...MARKER_PERMISSION_VALUES]);
    const markers = ["trusted_origin", "anchor", "review_off"];
    for (const base of [["read"], ["write"], ["read", "write"]]) {
      assert.deepEqual(validatePermissionList([...base, ...markers]), [...base, ...markers]);
      assert.equal(isValidPermissionList([...base, "trusted_origin", "anchor", "review_all"]), true);
    }
    for (const list of [[], [...markers], ["trusted_origin", "anchor", "review_all"], ["read", "review_off", "review_all"]]) {
      assert.equal(isValidPermissionList(list), false, JSON.stringify(list));
      assert.throws(() => validatePermissionList(list), KeyPolicyValidationError, JSON.stringify(list));
      await assert.rejects(() => updatePermissions("k1", list), /permissions must contain 'read' and\/or 'write'/, JSON.stringify(list));
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
