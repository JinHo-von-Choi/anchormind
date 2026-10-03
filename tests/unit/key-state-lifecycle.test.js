/**
 * 세션 재확인의 키 수명 판정 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 순수 함수 시험: 세션이 쓰는 키 상태가 폐기, 만료, 허용 대역 밖 주소이면 더 쓸 수 없는 상태로 판정한다.
 * 수명 열이 없는 상태(이전 스키마)와 판정 불가(null)는 기존 판정과 같다.
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { isKeyStateRevoked } from "../../lib/admin/key-state-cache.js";

const NOW    = Date.parse("2026-10-03T12:00:00Z");
const active = { exists: true, status: "active", permissions: ["read"] };

describe("세션 키 상태 판정", () => {
  it("기존 판정은 그대로다", () => {
    assert.equal(isKeyStateRevoked(null), false);
    assert.equal(isKeyStateRevoked(active), false);
    assert.equal(isKeyStateRevoked({ ...active, status: "inactive" }), true);
    assert.equal(isKeyStateRevoked({ exists: false, status: null, permissions: null }), true);
  });

  it("수명 열이 빈 상태는 주소와 무관하게 쓸 수 있다", () => {
    const state = { ...active, revokedAt: null, expiresAt: null, allowedCidrs: null };
    assert.equal(isKeyStateRevoked(state, { now: NOW, clientIp: "unknown" }), false);
  });

  it("폐기와 만료는 더 쓸 수 없다", () => {
    assert.equal(isKeyStateRevoked({ ...active, revokedAt: new Date(NOW - 1) }, { now: NOW }), true);
    assert.equal(isKeyStateRevoked({ ...active, expiresAt: new Date(NOW - 1) }, { now: NOW }), true);
    assert.equal(isKeyStateRevoked({ ...active, expiresAt: new Date(NOW + 1000) }, { now: NOW }), false);
  });

  it("허용 대역 밖 주소의 요청은 세션을 쓸 수 없다", () => {
    const state = { ...active, allowedCidrs: ["10.0.0.0/8"] };
    assert.equal(isKeyStateRevoked(state, { now: NOW, clientIp: "10.1.1.1" }), false);
    assert.equal(isKeyStateRevoked(state, { now: NOW, clientIp: "192.0.2.1" }), true);
  });

  it("요청 주소를 넘기지 않으면 대역 판정을 하지 않는다", () => {
    assert.equal(isKeyStateRevoked({ ...active, allowedCidrs: ["10.0.0.0/8"] }, { now: NOW }), false);
  });
});
