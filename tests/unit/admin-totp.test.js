/**
 * TOTP(RFC 6238)와 base32(RFC 4648) 시험.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * RFC 6238 부록 B의 SHA-1 시험 벡터(8자리)와 RFC 4648 10절의 base32 벡터를 쓴다.
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";

const {
  base32Encode, base32Decode, hotp, totpAt, totpStep, verifyTotp, generateTotpSecret, otpauthUri,
  TOTP_STEP_SEC, TOTP_DIGITS, TotpFormatError
} = await import("../../lib/admin/admin-totp.js");

const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("RFC 6238 부록 B SHA-1 벡터", () => {
  const vectors = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"]
  ];
  for (const [time, code] of vectors) {
    it(`T=${time} -> ${code}`, () => {
      assert.equal(totpAt(RFC_SECRET, time, { digits: 8 }), code);
    });
  }

  it("기본은 30초 단계, 6자리다(8자리 값의 끝 6자리)", () => {
    assert.equal(TOTP_STEP_SEC, 30);
    assert.equal(TOTP_DIGITS, 6);
    assert.equal(totpAt(RFC_SECRET, 59), "287082");
    assert.equal(totpStep(59), 1);
    assert.equal(totpStep(1111111109), 37037036);
  });

  it("RFC 4226 부록 D HOTP 값(카운터 0, 1)", () => {
    assert.equal(hotp(RFC_SECRET, 0), "755224");
    assert.equal(hotp(RFC_SECRET, 1), "287082");
  });
});

describe("base32", () => {
  const vectors = [["", ""], ["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"]];
  for (const [plain, encoded] of vectors) {
    it(`"${plain}" <-> "${encoded}" (덧붙임 없음)`, () => {
      assert.equal(base32Encode(Buffer.from(plain)), encoded);
      assert.equal(base32Decode(encoded).toString(), plain);
    });
  }

  it("소문자, 공백, 덧붙임 문자를 받아들인다", () => {
    assert.equal(base32Decode("mzxw 6ytb oi======").toString(), "foobar");
  });

  it("알파벳 밖 문자는 TotpFormatError다", () => {
    assert.throws(() => base32Decode("MZ1W"), TotpFormatError);
    assert.throws(() => base32Decode("MZ8W"), TotpFormatError);
  });
});

describe("TOTP 검증", () => {
  const secret = RFC_SECRET;
  const now    = 1111111111;
  const step   = totpStep(now);

  it("현재 단계의 코드를 받고 그 단계를 돌려준다", () => {
    assert.deepEqual(verifyTotp(secret, totpAt(secret, now), { nowSec: now }), { ok: true, step });
  });

  it("앞뒤 한 단계까지 받고 두 단계 밖은 거부한다", () => {
    assert.deepEqual(verifyTotp(secret, totpAt(secret, now - 30), { nowSec: now }), { ok: true, step: step - 1 });
    assert.deepEqual(verifyTotp(secret, totpAt(secret, now + 30), { nowSec: now }), { ok: true, step: step + 1 });
    assert.equal(verifyTotp(secret, totpAt(secret, now - 60), { nowSec: now }).ok, false);
    assert.equal(verifyTotp(secret, totpAt(secret, now + 60), { nowSec: now }).ok, false);
  });

  it("이미 받은 단계 이하의 코드는 재사용으로 거부한다", () => {
    const code = totpAt(secret, now);
    assert.deepEqual(verifyTotp(secret, code, { nowSec: now, lastStep: step }), { ok: false, reason: "replayed" });
    assert.deepEqual(verifyTotp(secret, totpAt(secret, now - 30), { nowSec: now, lastStep: step }), { ok: false, reason: "replayed" });
    assert.deepEqual(verifyTotp(secret, totpAt(secret, now + 30), { nowSec: now, lastStep: step }), { ok: true, step: step + 1 });
  });

  it("형식이 틀린 코드는 비교 없이 거부한다", () => {
    for (const bad of ["", "12345", "1234567", "12a456", null, 123456]) {
      assert.deepEqual(verifyTotp(secret, bad, { nowSec: now }), { ok: false, reason: "format" });
    }
  });

  it("틀린 코드는 mismatch다", () => {
    const code  = totpAt(secret, now);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    assert.deepEqual(verifyTotp(secret, wrong, { nowSec: now }), { ok: false, reason: "mismatch" });
  });
});

describe("비밀 생성과 등록 URI", () => {
  it("비밀은 20바이트 난수이고 매번 다르다", () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    assert.equal(a.length, 20);
    assert.notDeepEqual(a, b);
  });

  it("otpauth URI는 발급자와 계정을 인코딩하고 알고리즘, 자릿수, 주기를 싣는다", () => {
    const uri = new URL(otpauthUri({ issuer: "AnchorMind", account: "ops admin", secret: RFC_SECRET }));
    assert.equal(uri.protocol, "otpauth:");
    assert.equal(uri.host, "totp");
    assert.equal(decodeURIComponent(uri.pathname), "/AnchorMind:ops admin");
    assert.equal(uri.searchParams.get("secret"), base32Encode(RFC_SECRET));
    assert.equal(uri.searchParams.get("issuer"), "AnchorMind");
    assert.equal(uri.searchParams.get("algorithm"), "SHA1");
    assert.equal(uri.searchParams.get("digits"), "6");
    assert.equal(uri.searchParams.get("period"), "30");
  });
});
