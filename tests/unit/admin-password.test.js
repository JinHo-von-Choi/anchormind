/**
 * 관리자 비밀번호 정책, scrypt 해시 문자열, 동시 해시 제한 시험.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";

const {
  checkPasswordPolicy, hashPassword, verifyPassword, parsePasswordHash, needsRehash, verifyAgainstDummy,
  createHashLimiter, SCRYPT_PARAMS, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, PasswordHashFormatError, HashBusyError
} = await import("../../lib/admin/admin-password.js");

describe("비밀번호 정책", () => {
  it("최소 12자(코드 포인트 기준), 최대 길이 안이어야 한다", () => {
    assert.equal(PASSWORD_MIN_LENGTH, 12);
    assert.deepEqual(checkPasswordPolicy("a".repeat(11)), { ok: false, reason: "too_short" });
    assert.deepEqual(checkPasswordPolicy("a".repeat(12)), { ok: true });
    assert.deepEqual(checkPasswordPolicy("가".repeat(12)), { ok: true });
    assert.deepEqual(checkPasswordPolicy("\u{1F600}".repeat(6)), { ok: false, reason: "too_short" });
    assert.deepEqual(checkPasswordPolicy("a".repeat(PASSWORD_MAX_LENGTH + 1)), { ok: false, reason: "too_long" });
    assert.deepEqual(checkPasswordPolicy(123456789012), { ok: false, reason: "not_string" });
  });

  it("공백뿐이거나 제어 문자가 든 비밀번호는 거부한다", () => {
    assert.deepEqual(checkPasswordPolicy(" ".repeat(16)), { ok: false, reason: "blank" });
    assert.deepEqual(checkPasswordPolicy(`abcdefghijkl\u0000`), { ok: false, reason: "control_char" });
  });
});

describe("scrypt 해시 문자열", () => {
  it("기본 매개변수는 N=2^15, r=8, p=1, salt 16바이트이고 행마다 문자열에 담긴다", async () => {
    assert.deepEqual({ ln: SCRYPT_PARAMS.ln, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, saltLen: SCRYPT_PARAMS.saltLen },
      { ln: 15, r: 8, p: 1, saltLen: 16 });
    const stored = await hashPassword("correct horse battery");
    assert.match(stored, /^\$scrypt\$ln=15,r=8,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    const parsed = parsePasswordHash(stored);
    assert.equal(parsed.salt.length, 16);
    assert.equal(parsed.hash.length, 32);
  });

  it("같은 비밀번호도 salt가 달라 해시 문자열이 다르고, 둘 다 검증된다", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    assert.notEqual(a, b);
    assert.equal(await verifyPassword("correct horse battery", a), true);
    assert.equal(await verifyPassword("correct horse battery", b), true);
    assert.equal(await verifyPassword("correct horse batterz", a), false);
  });

  it("저장된 매개변수로 검증하고, 현재 기본값과 다르면 다시 해시할 대상이다", async () => {
    const weak = await hashPassword("correct horse battery", { params: { ...SCRYPT_PARAMS, ln: 10 } });
    assert.match(weak, /^\$scrypt\$ln=10,/);
    assert.equal(await verifyPassword("correct horse battery", weak), true);
    assert.equal(needsRehash(weak), true);
    assert.equal(needsRehash(await hashPassword("correct horse battery")), false);
  });

  it("형식이 틀리거나 범위 밖 매개변수인 해시 문자열은 PasswordHashFormatError다", () => {
    for (const bad of ["", "plain", "$scrypt$ln=15,r=8$AAAA$BBBB", "$scrypt$ln=40,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAA", "$bcrypt$x"]) {
      assert.throws(() => parsePasswordHash(bad), PasswordHashFormatError);
    }
  });

  it("없는 계정용 검증도 같은 비용으로 scrypt를 한 번 돌리고 false다", async () => {
    assert.equal(await verifyAgainstDummy("anything at all here"), false);
  });
});

describe("동시 해시 제한", () => {
  it("동시 실행 수를 넘는 작업은 대기열에서 차례로 실행된다", async () => {
    const limiter = createHashLimiter({ concurrency: 2, queueMax: 10 });
    let running = 0;
    let peak    = 0;
    const job = () => limiter.run(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return "done";
    });
    const results = await Promise.all(Array.from({ length: 6 }, job));
    assert.equal(peak, 2);
    assert.deepEqual(results, Array(6).fill("done"));
  });

  it("대기열이 차면 HashBusyError로 바로 거절한다", async () => {
    const limiter = createHashLimiter({ concurrency: 1, queueMax: 1 });
    let release;
    const gate  = new Promise((r) => { release = r; });
    const first = limiter.run(() => gate);
    const second = limiter.run(async () => "queued");
    await assert.rejects(limiter.run(async () => "overflow"), HashBusyError);
    release();
    await first;
    assert.equal(await second, "queued");
  });

  it("작업이 실패해도 자리를 돌려준다", async () => {
    const limiter = createHashLimiter({ concurrency: 1, queueMax: 0 });
    await assert.rejects(limiter.run(async () => { throw new Error("boom"); }), /boom/);
    assert.equal(await limiter.run(async () => "next"), "next");
  });
});
