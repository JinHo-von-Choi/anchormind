/**
 * API 키 수명 판정 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 순수 함수 시험: 키 상태(폐기, 비활성, 만료), 비밀 행(조회 출처, 회전 겹침 종료, 폐기), 사용량 판정의 순서,
 * 회전 겹침 종료 시각, 편집 값과 폐기 사유 검증, 요청 주소 지문.
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
  evaluateKeyState, evaluateKeyCredential, rotationValidUntil, resolveGraceHours,
  validateKeyLifecyclePatch, validateRevokeReason, hashClientIp, diffKeyLifecycle,
  DEFAULT_ROTATION_GRACE_HOURS, MAX_ROTATION_GRACE_HOURS, KEY_SECRET_SOURCE
} from "../../lib/admin/key-lifecycle.js";
import { KeyPolicyValidationError } from "../../lib/admin/key-policy.js";

const NOW    = Date.parse("2026-10-03T12:00:00Z");
const BEFORE = new Date(NOW - 1000);
const AFTER  = new Date(NOW + 1000);

const key = (extra = {}) => ({ status: "active", revoked_at: null, expires_at: null, daily_limit: 100, usage_today: 0, ...extra });
const viaSecret = (extra = {}) => ({ ...key(), secret_source: KEY_SECRET_SOURCE.SECRET, secret_status: "active", secret_valid_until: null, ...extra });
const viaLegacy = (extra = {}) => ({ ...key(), secret_source: KEY_SECRET_SOURCE.LEGACY, secret_status: null, secret_valid_until: null, ...extra });

describe("키 상태 판정", () => {
  it("수명 열이 비어 있는 활성 키는 유효하다", () => {
    assert.deepEqual(evaluateKeyState(key(), NOW), { valid: true });
  });

  it("폐기가 비활성과 만료보다 먼저다", () => {
    assert.deepEqual(evaluateKeyState(key({ revoked_at: BEFORE, status: "inactive", expires_at: BEFORE }), NOW), { valid: false, reason: "revoked" });
  });

  it("비활성은 만료보다 먼저다", () => {
    assert.deepEqual(evaluateKeyState(key({ status: "inactive", expires_at: BEFORE }), NOW), { valid: false, reason: "inactive" });
  });

  it("만료 시각이 지났거나 같으면 만료다", () => {
    assert.deepEqual(evaluateKeyState(key({ expires_at: BEFORE }), NOW), { valid: false, reason: "expired" });
    assert.deepEqual(evaluateKeyState(key({ expires_at: new Date(NOW) }), NOW), { valid: false, reason: "expired" });
    assert.deepEqual(evaluateKeyState(key({ expires_at: AFTER }), NOW), { valid: true });
    assert.deepEqual(evaluateKeyState(key({ expires_at: "2026-10-03T11:59:59Z" }), NOW), { valid: false, reason: "expired" });
  });

  it("읽을 수 없는 만료 값은 만료로 본다", () => {
    assert.deepEqual(evaluateKeyState(key({ expires_at: "not a date" }), NOW), { valid: false, reason: "expired" });
  });
});

describe("원시 키 판정 순서", () => {
  it("비밀 행과 레거시 행 모두 수명 열이 비면 현행과 같은 결과다", () => {
    assert.deepEqual(evaluateKeyCredential(viaSecret(), NOW), { valid: true });
    assert.deepEqual(evaluateKeyCredential(viaLegacy(), NOW), { valid: true });
    assert.deepEqual(evaluateKeyCredential(viaLegacy({ status: "inactive" }), NOW), { valid: false, reason: "inactive" });
    assert.deepEqual(evaluateKeyCredential(viaLegacy({ usage_today: 100 }), NOW), { valid: false, reason: "limit_exceeded" });
    assert.deepEqual(evaluateKeyCredential(viaSecret({ usage_today: 100 }), NOW), { valid: false, reason: "limit_exceeded" });
  });

  it("회전 겹침이 끝난 비밀은 rotated다", () => {
    assert.deepEqual(evaluateKeyCredential(viaSecret({ secret_valid_until: BEFORE }), NOW), { valid: false, reason: "rotated" });
    assert.deepEqual(evaluateKeyCredential(viaSecret({ secret_valid_until: AFTER }), NOW), { valid: true });
  });

  it("폐기된 비밀은 키 상태와 무관하게 revoked다", () => {
    assert.deepEqual(evaluateKeyCredential(viaSecret({ secret_status: "revoked" }), NOW), { valid: false, reason: "revoked" });
  });

  it("키 상태가 비밀 판정보다 먼저이고 사용량이 마지막이다", () => {
    assert.deepEqual(evaluateKeyCredential(viaSecret({ status: "inactive", secret_valid_until: BEFORE }), NOW), { valid: false, reason: "inactive" });
    assert.deepEqual(evaluateKeyCredential(viaSecret({ secret_valid_until: BEFORE, usage_today: 500 }), NOW), { valid: false, reason: "rotated" });
    assert.deepEqual(evaluateKeyCredential(viaSecret({ expires_at: BEFORE, usage_today: 500 }), NOW), { valid: false, reason: "expired" });
  });

  it("알 수 없는 비밀 상태는 거부한다", () => {
    assert.deepEqual(evaluateKeyCredential(viaSecret({ secret_status: "pending" }), NOW), { valid: false, reason: "revoked" });
  });
});

describe("회전 겹침", () => {
  it("겹침 종료 시각은 지금 + 시간이다", () => {
    assert.equal(rotationValidUntil(NOW, 24).toISOString(), "2026-10-04T12:00:00.000Z");
    assert.equal(rotationValidUntil(NOW, 0).getTime(), NOW);
  });

  it("시간 값을 검증한다", () => {
    assert.equal(DEFAULT_ROTATION_GRACE_HOURS, 24);
    assert.equal(resolveGraceHours(undefined, 24), 24);
    assert.equal(resolveGraceHours(null, 6), 6);
    assert.equal(resolveGraceHours(0, 24), 0);
    assert.equal(resolveGraceHours(MAX_ROTATION_GRACE_HOURS, 24), MAX_ROTATION_GRACE_HOURS);
    for (const bad of [-1, 1.5, "24", MAX_ROTATION_GRACE_HOURS + 1, Number.NaN]) {
      assert.throws(() => resolveGraceHours(bad, 24), KeyPolicyValidationError, String(bad));
    }
  });
});

describe("수명 편집 값 검증", () => {
  it("전달된 필드만 정규화해 돌려준다", () => {
    assert.deepEqual(validateKeyLifecyclePatch({ owner: " team-a ", foo: 1 }), { owner: "team-a" });
    assert.deepEqual(validateKeyLifecyclePatch({ expires_at: "2027-01-01T00:00:00+09:00" }), { expires_at: "2026-12-31T15:00:00.000Z" });
    assert.deepEqual(validateKeyLifecyclePatch({ expires_at: null, allowed_cidrs: null, kind: null, description: null, owner: "" }),
      { expires_at: null, allowed_cidrs: null, kind: null, description: null, owner: null });
    assert.deepEqual(validateKeyLifecyclePatch({ allowed_cidrs: ["10.0.0.0/8"], kind: "service" }), { allowed_cidrs: ["10.0.0.0/8"], kind: "service" });
  });

  it("빈 본문과 수명 필드 없는 본문은 오류다", () => {
    assert.throws(() => validateKeyLifecyclePatch({}), KeyPolicyValidationError);
    assert.throws(() => validateKeyLifecyclePatch(null), KeyPolicyValidationError);
    assert.throws(() => validateKeyLifecyclePatch([]), KeyPolicyValidationError);
  });

  it("잘못된 값은 필드 이름과 함께 거부한다", () => {
    const cases = [
      [{ expires_at: "tomorrow" }, "expires_at"],
      [{ expires_at: 1234 }, "expires_at"],
      [{ kind: "Has Space" }, "kind"],
      [{ owner: "x".repeat(129) }, "owner"],
      [{ owner: "a\u0001b" }, "owner"],
      [{ description: "d".repeat(501) }, "description"],
      [{ description: 5 }, "description"],
      [{ allowed_cidrs: ["nope"] }, "allowed_cidrs"]
    ];
    for (const [body, field] of cases) {
      assert.throws(() => validateKeyLifecyclePatch(body), (err) => err instanceof KeyPolicyValidationError && err.field === field, JSON.stringify(body));
    }
  });
});

describe("폐기 사유", () => {
  it("공백을 지운 1자 이상 500자 이하 문자열이다", () => {
    assert.equal(validateRevokeReason("  leaked in ci log "), "leaked in ci log");
    for (const bad of [undefined, null, "", "   ", 5, "r".repeat(501), "a\u0000b"]) {
      assert.throws(() => validateRevokeReason(bad), (err) => err instanceof KeyPolicyValidationError && err.field === "reason", String(bad));
    }
  });
});

describe("요청 주소 지문", () => {
  it("같은 주소와 같은 비밀값이면 같은 32자 16진 지문이고 매핑 표기는 IPv4와 같다", () => {
    const a = hashClientIp("10.1.2.3", "pepper");
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.equal(hashClientIp("::ffff:10.1.2.3", "pepper"), a);
    assert.notEqual(hashClientIp("10.1.2.3", "other"), a);
    assert.notEqual(hashClientIp("10.1.2.4", "pepper"), a);
  });

  it("주소가 아니면 null이다", () => {
    assert.equal(hashClientIp("unknown", "pepper"), null);
    assert.equal(hashClientIp(undefined, "pepper"), null);
  });
});

describe("수명 변경 감사 detail", () => {
  it("바뀐 필드만 담고 설명은 이름만 남긴다", () => {
    const detail = diffKeyLifecycle(
      { expires_at: null, owner: "a", kind: null, description: "old", allowed_cidrs: null },
      { expires_at: new Date("2027-01-01T00:00:00Z"), owner: "a", kind: null, description: "new text", allowed_cidrs: ["10.0.0.0/8"] }
    );
    assert.deepEqual(detail.changed, ["expires_at", "description", "allowed_cidrs"]);
    assert.deepEqual(detail.before, { expires_at: null, allowed_cidrs: null });
    assert.deepEqual(detail.after, { expires_at: "2027-01-01T00:00:00.000Z", allowed_cidrs: ["10.0.0.0/8"] });
  });
});
