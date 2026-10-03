/**
 * 관리자 계정 규칙(계정 이름, 역할 바인딩, TOTP 필수 역할, 복구 코드) 순수 시험.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";

const {
  normalizeUsername, loginUsernameNorm, normalizeRoleBindings, requiresTotp, generateRecoveryCodes,
  normalizeRecoveryCode, recoveryCodeHash, accountGuardKey, totpSealAad, ASSIGNABLE_ROLES, AdminUserInputError
} = await import("../../lib/admin/admin-user-rules.js");

describe("계정 이름", () => {
  it("표시 값은 그대로, 중복 판정 값은 소문자다", () => {
    assert.deepEqual(normalizeUsername(" Ops.Admin@corp "), { username: "Ops.Admin@corp", norm: "ops.admin@corp" });
  });

  it("허용 문자 밖, 빈 값, 64자 초과는 거부한다", () => {
    for (const bad of ["", "a b", "a/b", "a".repeat(65), "관리자", null]) {
      assert.throws(() => normalizeUsername(bad), AdminUserInputError, String(bad));
    }
  });

  it("로그인 입력의 형식 오류는 null(없는 계정과 같은 처리)이다", () => {
    assert.equal(loginUsernameNorm("x y"), null);
    assert.equal(loginUsernameNorm("Alice"), "alice");
  });
});

describe("역할 바인딩", () => {
  it("사람에게 주는 Core 역할만 받고 service는 받지 않는다", () => {
    assert.deepEqual([...ASSIGNABLE_ROLES].sort(), ["admin", "auditor", "owner", "reviewer", "viewer"]);
    assert.throws(() => normalizeRoleBindings([{ role: "service" }]), (e) => e.reason === "unknown_role");
    assert.throws(() => normalizeRoleBindings([{ role: "__proto__" }]), (e) => e.reason === "unknown_role");
  });

  it("문자열 역할은 전역 바인딩이고, 같은 (역할, workspace)는 하나로 합친다", () => {
    assert.deepEqual(normalizeRoleBindings(["viewer", { role: "viewer" }, { role: "reviewer", workspace: "team-a" }]),
      [{ role: "viewer", workspace: null }, { role: "reviewer", workspace: "team-a" }]);
  });

  it("owner는 전역 바인딩만 받는다", () => {
    assert.throws(() => normalizeRoleBindings([{ role: "owner", workspace: "team-a" }]), (e) => e.reason === "owner_must_be_global");
  });

  it("빈 목록, 형식이 틀린 workspace는 거부한다", () => {
    assert.throws(() => normalizeRoleBindings([]), (e) => e.reason === "required");
    assert.throws(() => normalizeRoleBindings([{ role: "viewer", workspace: "" }]), (e) => e.reason === "workspace_format");
    assert.throws(() => normalizeRoleBindings([{ role: "viewer", workspace: "a\nb" }]), (e) => e.reason === "workspace_format");
    assert.throws(() => normalizeRoleBindings([{ role: "viewer", workspace: "w".repeat(129) }]), (e) => e.reason === "workspace_format");
  });

  it("owner와 admin 역할은 TOTP가 필수다", () => {
    assert.equal(requiresTotp([{ role: "owner" }]), true);
    assert.equal(requiresTotp([{ role: "viewer" }, { role: "admin" }]), true);
    assert.equal(requiresTotp([{ role: "reviewer" }, { role: "auditor" }, { role: "viewer" }]), false);
  });
});

describe("복구 코드", () => {
  it("10개, 서로 다르고 5자-5자 형식이다", () => {
    const codes = generateRecoveryCodes();
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
    for (const c of codes) assert.match(c, /^[a-z2-7]{5}-[a-z2-7]{5}$/);
  });

  it("입력은 대소문자, 하이픈, 공백을 무시하고 형식이 틀리면 null이다", () => {
    assert.equal(normalizeRecoveryCode("ABCDE-FG234"), "abcdefg234");
    assert.equal(normalizeRecoveryCode(" abcde fg234 "), "abcdefg234");
    assert.equal(normalizeRecoveryCode("abcde-fg23"), null);
    assert.equal(normalizeRecoveryCode("abcde-fg231"), null);
    assert.equal(normalizeRecoveryCode(42), null);
  });

  it("해시는 계정마다 달라 다른 계정의 행으로 옮겨 쓸 수 없다", () => {
    const code = "abcdefg234";
    assert.match(recoveryCodeHash("u1", code), /^[0-9a-f]{64}$/);
    assert.notEqual(recoveryCodeHash("u1", code), recoveryCodeHash("u2", code));
  });
});

describe("기타 키", () => {
  it("로그인 계수 키는 계정 이름을 담지 않는 해시이고 봉인 AAD는 계정 id를 담는다", () => {
    assert.match(accountGuardKey("alice"), /^[0-9a-f]{64}$/);
    assert.ok(!accountGuardKey("alice").includes("alice"));
    assert.ok(totpSealAad("u-1").endsWith(":u-1"));
  });
});
