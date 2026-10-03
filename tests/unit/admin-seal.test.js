/**
 * 관리자 TOTP 비밀 봉인(AES-256-GCM, 키 버전 회전) 시험.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import crypto           from "node:crypto";

const {
  parseSealKeyRing, sealSecret, unsealSecret, sealKeyId, needsReseal, SealKeyError, SealError
} = await import("../../lib/admin/admin-seal.js");

const K1 = crypto.randomBytes(32).toString("base64");
const K2 = crypto.randomBytes(32).toString("base64");
const AAD = "admin_user:6f1c9a52-1d2b-4c3d-9e8f-001122334455";

describe("봉인 키 목록 해석", () => {
  it("쉼표로 나눈 id:base64 목록에서 첫 항목이 현재 키다", () => {
    const ring = parseSealKeyRing(`v2:${K2}, v1:${K1}`);
    assert.equal(ring.currentId, "v2");
    assert.deepEqual([...ring.keys.keys()], ["v2", "v1"]);
    assert.equal(ring.keys.get("v1").length, 32);
  });

  it("id 없이 키 하나만 주면 id는 v1이다", () => {
    assert.equal(parseSealKeyRing(K1).currentId, "v1");
  });

  it("64자 hex 키도 받는다", () => {
    const hex = crypto.randomBytes(32).toString("hex");
    assert.equal(parseSealKeyRing(`k7:${hex}`).keys.get("k7").length, 32);
  });

  it("빈 값, 짧은 키, 잘못된 id, 중복 id는 SealKeyError이고 키 값을 메시지에 담지 않는다", () => {
    const cases = [
      ["", "empty"],
      [`v1:${crypto.randomBytes(16).toString("base64")}`, "key_length"],
      [`V 1:${K1}`, "key_id"],
      [`v1:${K1},v1:${K2}`, "duplicate_key_id"],
      ["v1:@@@@", "key_length"]
    ];
    for (const [raw, problem] of cases) {
      assert.throws(() => parseSealKeyRing(raw), (err) => {
        assert.ok(err instanceof SealKeyError);
        assert.equal(err.problem, problem);
        assert.ok(!err.message.includes(K1) && !err.message.includes(K2));
        return true;
      });
    }
  });
});

describe("봉인과 해제", () => {
  const ring = parseSealKeyRing(`v1:${K1}`);
  const secret = crypto.randomBytes(20);

  it("봉인 값은 형식 s1, 키 id, nonce, 암호문, 태그를 담고 해제하면 원래 비밀이다", () => {
    const sealed = sealSecret(ring, secret, AAD);
    assert.match(sealed, /^s1\.v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    assert.equal(sealKeyId(sealed), "v1");
    assert.deepEqual(unsealSecret(ring, sealed, AAD), secret);
    assert.ok(!sealed.includes(secret.toString("base64url")));
  });

  it("같은 비밀도 봉인할 때마다 nonce가 달라 값이 다르다", () => {
    assert.notEqual(sealSecret(ring, secret, AAD), sealSecret(ring, secret, AAD));
  });

  it("AAD가 다르면(다른 계정) 해제하지 못한다", () => {
    const sealed = sealSecret(ring, secret, AAD);
    assert.throws(() => unsealSecret(ring, sealed, "admin_user:other"), (err) => err instanceof SealError && err.reason === "auth_failed");
  });

  it("암호문이나 태그를 바꾸면 해제하지 못한다", () => {
    const sealed = sealSecret(ring, secret, AAD);
    const parts  = sealed.split(".");
    const flip   = (s) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    for (const idx of [2, 3, 4]) {
      const tampered = parts.map((p, i) => (i === idx ? flip(p) : p)).join(".");
      assert.throws(() => unsealSecret(ring, tampered, AAD), SealError);
    }
  });

  it("형식이 틀린 값과 모르는 키 id는 SealError다", () => {
    assert.throws(() => unsealSecret(ring, "s1.v1.abc", AAD), (err) => err.reason === "malformed");
    assert.throws(() => unsealSecret(ring, "s2.v1.a.b.c", AAD), (err) => err.reason === "malformed");
    const other = parseSealKeyRing(`v9:${K2}`);
    assert.throws(() => unsealSecret(ring, sealSecret(other, secret, AAD), AAD), (err) => err.reason === "unknown_key");
  });
});

describe("키 회전", () => {
  const secret = crypto.randomBytes(20);
  const oldRing = parseSealKeyRing(`v1:${K1}`);
  const newRing = parseSealKeyRing(`v2:${K2},v1:${K1}`);

  it("새 목록은 옛 키로 봉인한 값을 해제하고 현재 키로 다시 봉인할 대상으로 판정한다", () => {
    const sealedOld = sealSecret(oldRing, secret, AAD);
    assert.deepEqual(unsealSecret(newRing, sealedOld, AAD), secret);
    assert.equal(needsReseal(newRing, sealedOld), true);
    const resealed = sealSecret(newRing, unsealSecret(newRing, sealedOld, AAD), AAD);
    assert.equal(sealKeyId(resealed), "v2");
    assert.equal(needsReseal(newRing, resealed), false);
  });

  it("옛 키를 목록에서 빼면 그 키의 값은 해제하지 못한다", () => {
    const sealedOld = sealSecret(oldRing, secret, AAD);
    assert.throws(() => unsealSecret(parseSealKeyRing(`v2:${K2}`), sealedOld, AAD), (err) => err.reason === "unknown_key");
  });
});
