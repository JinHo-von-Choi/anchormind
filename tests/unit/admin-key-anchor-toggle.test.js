/**
 * 관리 콘솔 키 상세의 anchor 권한 토글 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 구조 검사: PERMISSIONS 토글이 서버가 받는 권한 값과 같고 ANCHOR 단추가 있으며, 현재 키 권한이
 * 활성 표시에 반영되는지 본다.
 */

import { describe, test }   from "node:test";
import assert               from "node:assert/strict";
import { setupDom }         from "./admin-test-helper.js";

setupDom();

const { renderKeyInspector, KEY_PERMISSION_TOGGLES } = await import("../../assets/admin/modules/keys.js");
const { KEY_PERMISSION_VALUES }                       = await import("../../lib/admin/key-policy.js");

/** 패널에서 textContent가 text인 단추를 찾는다. */
function buttonOf(panel, text) {
  let found = null;
  (function walk(n) {
    if (found) return;
    if (n.tagName === "BUTTON" && n.textContent === text) { found = n; return; }
    (n.children ?? []).forEach(walk);
  })(panel);
  return found;
}

describe("키 상세 PERMISSIONS 토글", () => {
  test("토글 목록은 서버가 받는 권한 값과 같다", () => {
    assert.deepEqual([...KEY_PERMISSION_TOGGLES], [...KEY_PERMISSION_VALUES]);
  });

  test("ANCHOR 단추가 있고 현재 권한을 활성으로 표시한다", () => {
    const granted = renderKeyInspector({ id: "k1", name: "K", key_prefix: "m_k", status: "active", permissions: ["read", "write", "anchor"] });
    const plain   = renderKeyInspector({ id: "k2", name: "K2", key_prefix: "m_k2", status: "active", permissions: ["read", "write"] });
    const on      = buttonOf(granted, "ANCHOR");
    const off     = buttonOf(plain, "ANCHOR");
    assert.ok(on && off, "ANCHOR 단추 없음");
    assert.match(on.className, /text-primary/);
    assert.doesNotMatch(off.className, /text-primary/);
  });
});
