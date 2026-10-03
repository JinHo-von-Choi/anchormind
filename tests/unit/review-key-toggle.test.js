/**
 * 콘솔 키 상세의 검토 방식 토글 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 검토 방식 표지(review_off, review_all)는 하나만 둘 수 있으므로 콘솔 토글이 하나를 켜면 다른 하나를
 * 끄는지, 다른 권한 토글은 그대로인지 본다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { setupDom } from "./admin-test-helper.js";

setupDom();

const { togglePermission, KEY_PERMISSION_TOGGLES } = await import("../../assets/admin/modules/keys.js");
const { validatePermissionList }                   = await import("../../lib/admin/key-policy.js");

describe("검토 방식 토글", () => {
  it("검토 방식 표지를 켜면 다른 검토 방식 표지를 끈다", () => {
    assert.deepEqual(togglePermission(["read", "write", "review_off"], "review_all"), ["read", "write", "review_all"]);
    assert.deepEqual(togglePermission(["write", "review_all"], "review_off"), ["write", "review_off"]);
  });

  it("켜진 표지를 누르면 끈다", () => {
    assert.deepEqual(togglePermission(["write", "review_all"], "review_all"), ["write"]);
  });

  it("다른 권한 토글은 검토 방식 표지를 건드리지 않는다", () => {
    assert.deepEqual(togglePermission(["write", "review_off"], "read"), ["write", "review_off", "read"]);
    assert.deepEqual(togglePermission(["read", "write"], "write"), ["read"]);
  });

  it("토글로 만든 목록은 서버 검증을 통과한다", () => {
    let permissions = ["read", "write"];
    for (const value of KEY_PERMISSION_TOGGLES.filter(v => v.startsWith("review_"))) {
      permissions = togglePermission(permissions, value);
      assert.deepEqual(validatePermissionList(permissions), permissions);
    }
  });
});
