/**
 * 키 정책 값 검증 순수 함수 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";

const {
  validateKeyPolicyPatch,
  validatePermissionList,
  diffKeyPolicy,
  formatKeyPolicyAuditDetails,
  KeyPolicyValidationError,
  MAX_ALLOWED_WORKSPACES,
  MAX_WORKSPACE_LENGTH
} = await import("../../lib/admin/key-policy.js");

const presets  = new Map([
  ["recall-only", { name: "recall-only", requiresMaster: false }],
  ["audit",       { name: "audit",       requiresMaster: true }]
]);
const registry = {
  getPreset  : (name) => presets.get(name) ?? null,
  listPresets: () => [...presets.keys()]
};

const check = (body, opts = {}) => validateKeyPolicyPatch(body, { registry, ...opts });

function rejects(body, field, opts) {
  assert.throws(
    () => check(body, opts),
    (err) => err instanceof KeyPolicyValidationError && err.field === field,
    `${JSON.stringify(body)} 은 ${field} 오류여야 한다`
  );
}

describe("validateKeyPolicyPatch: 본문 형태", () => {
  it("객체가 아니면 거부한다", () => {
    for (const body of [null, undefined, [], "x", 3]) rejects(body, "body");
  });

  it("정책 필드가 하나도 없으면 거부한다", () => {
    rejects({}, "body");
  });

  it("알 수 없는 필드는 거부한다", () => {
    rejects({ symbolic_hard_gate: true, permissions: ["read"] }, "permissions");
  });

  it("전달한 필드만 결과에 담는다", () => {
    assert.deepEqual(check({ symbolic_hard_gate: true }), { symbolic_hard_gate: true });
  });
});

describe("validateKeyPolicyPatch: default_mode", () => {
  it("등록된 preset 이름과 null을 받는다", () => {
    assert.deepEqual(check({ default_mode: "recall-only" }), { default_mode: "recall-only" });
    assert.deepEqual(check({ default_mode: null }), { default_mode: null });
  });

  it("등록되지 않은 이름은 거부한다", () => {
    rejects({ default_mode: "nope" }, "default_mode");
    rejects({ default_mode: "" }, "default_mode");
    rejects({ default_mode: 3 }, "default_mode");
  });

  it("requiresMaster preset은 마스터가 아닌 키에 거부한다", () => {
    rejects({ default_mode: "audit" }, "default_mode");
  });

  it("오류 메시지에 설정 가능한 preset 이름을 싣고 requiresMaster 이름은 싣지 않는다", () => {
    try {
      check({ default_mode: "nope" });
      assert.fail("거부되어야 한다");
    } catch (err) {
      assert.match(err.message, /recall-only/);
      assert.doesNotMatch(err.message, /audit/);
    }
  });

  it("요청 객체의 프로토타입 키 이름은 preset으로 취급하지 않는다", () => {
    rejects({ default_mode: "__proto__" }, "default_mode");
    rejects({ default_mode: "constructor" }, "default_mode");
  });
});

describe("validateKeyPolicyPatch: allowed_workspaces", () => {
  it("null(무제한)과 빈 배열(전면 차단)을 구분해 받는다", () => {
    assert.deepEqual(check({ allowed_workspaces: null }), { allowed_workspaces: null });
    assert.deepEqual(check({ allowed_workspaces: [] }), { allowed_workspaces: [] });
  });

  it("문자열 배열을 순서를 지켜 중복 없이 받는다", () => {
    assert.deepEqual(
      check({ allowed_workspaces: ["alpha", "beta", "alpha"] }),
      { allowed_workspaces: ["alpha", "beta"] }
    );
  });

  it("배열이 아니면 거부한다", () => {
    rejects({ allowed_workspaces: "alpha" }, "allowed_workspaces");
    rejects({ allowed_workspaces: { 0: "alpha" } }, "allowed_workspaces");
  });

  it("문자열이 아닌 항목, 빈 항목, 앞뒤 공백 항목은 거부한다", () => {
    rejects({ allowed_workspaces: [1] }, "allowed_workspaces");
    rejects({ allowed_workspaces: [""] }, "allowed_workspaces");
    rejects({ allowed_workspaces: ["  "] }, "allowed_workspaces");
    rejects({ allowed_workspaces: [" alpha"] }, "allowed_workspaces");
    rejects({ allowed_workspaces: ["alpha "] }, "allowed_workspaces");
  });

  it("제어 문자가 든 항목은 거부한다", () => {
    rejects({ allowed_workspaces: ["al\npha"] }, "allowed_workspaces");
    rejects({ allowed_workspaces: ["al\u0000pha"] }, "allowed_workspaces");
  });

  it("항목 길이 상한을 지킨다", () => {
    const ok  = "w".repeat(MAX_WORKSPACE_LENGTH);
    const bad = "w".repeat(MAX_WORKSPACE_LENGTH + 1);
    assert.deepEqual(check({ allowed_workspaces: [ok] }), { allowed_workspaces: [ok] });
    rejects({ allowed_workspaces: [bad] }, "allowed_workspaces");
  });

  it("항목 수 상한을 지킨다", () => {
    const ok  = Array.from({ length: MAX_ALLOWED_WORKSPACES }, (_, i) => `ws-${i}`);
    const bad = [...ok, "ws-extra"];
    assert.equal(check({ allowed_workspaces: ok }).allowed_workspaces.length, MAX_ALLOWED_WORKSPACES);
    rejects({ allowed_workspaces: bad }, "allowed_workspaces");
  });

  it("중복을 제거한 뒤의 개수로 상한을 판정한다", () => {
    const dup = Array.from({ length: MAX_ALLOWED_WORKSPACES + 5 }, () => "same");
    assert.deepEqual(check({ allowed_workspaces: dup }), { allowed_workspaces: ["same"] });
  });
});

describe("validateKeyPolicyPatch: symbolic_hard_gate", () => {
  it("boolean만 받는다", () => {
    assert.deepEqual(check({ symbolic_hard_gate: false }), { symbolic_hard_gate: false });
    for (const v of ["true", 1, 0, null]) rejects({ symbolic_hard_gate: v }, "symbolic_hard_gate");
  });
});

describe("validatePermissionList", () => {
  it("read와 write만 받고 중복은 제거한다", () => {
    assert.deepEqual(validatePermissionList(["read", "write", "read"]), ["read", "write"]);
  });

  it("빈 배열, 배열이 아닌 값, 알 수 없는 권한은 거부한다", () => {
    for (const v of [[], "read", null, ["admin"], ["read", 1]]) {
      assert.throws(() => validatePermissionList(v), KeyPolicyValidationError, JSON.stringify(v));
    }
  });
});

describe("diffKeyPolicy", () => {
  const before = { default_mode: null, allowed_workspaces: null, symbolic_hard_gate: false };

  it("값이 달라진 필드만 이전과 이후 값으로 돌려준다", () => {
    const after = { default_mode: "recall-only", allowed_workspaces: null, symbolic_hard_gate: true };
    assert.deepEqual(diffKeyPolicy(before, after), [
      { field: "default_mode",        before: null,          after: "recall-only" },
      { field: "symbolic_hard_gate",  before: false,         after: true }
    ]);
  });

  it("배열은 내용으로 비교한다", () => {
    const a = { ...before, allowed_workspaces: ["a", "b"] };
    const b = { ...before, allowed_workspaces: ["a", "b"] };
    assert.deepEqual(diffKeyPolicy(a, b), []);
    assert.equal(diffKeyPolicy(a, { ...b, allowed_workspaces: ["b", "a"] }).length, 1);
    assert.equal(diffKeyPolicy(before, { ...before, allowed_workspaces: [] }).length, 1);
  });
});

describe("formatKeyPolicyAuditDetails", () => {
  it("필드 이름과 이전, 이후 값을 한 줄에 싣는다", () => {
    const line = formatKeyPolicyAuditDetails("k-1", [
      { field: "default_mode", before: null, after: "recall-only" }
    ]);
    assert.match(line, /target=k-1/);
    assert.match(line, /default_mode/);
    assert.match(line, /recall-only/);
    assert.doesNotMatch(line, /[\r\n]/);
  });

  it("대상 키는 앞 8자만 target으로 남기고 key= 토큰을 쓰지 않는다", () => {
    const line = formatKeyPolicyAuditDetails("7a1e0000-0000-4000-8000-0000000000e3", [
      { field: "symbolic_hard_gate", before: false, after: true }
    ]);
    assert.match(line, /^target=7a1e0000 /);
    assert.doesNotMatch(line, /0000-4000/);
    assert.doesNotMatch(line, /\bkey=/);
  });

  it("변경이 없으면 그 사실을 적는다", () => {
    assert.match(formatKeyPolicyAuditDetails("k-1", []), /unchanged/);
  });

  it("긴 값은 잘라 한 줄 길이를 제한한다", () => {
    const many = Array.from({ length: MAX_ALLOWED_WORKSPACES }, () => "w".repeat(MAX_WORKSPACE_LENGTH));
    const line = formatKeyPolicyAuditDetails("k-1", [
      { field: "allowed_workspaces", before: null, after: many }
    ]);
    assert.ok(line.length < 2000, `길이 ${line.length}`);
  });
});
