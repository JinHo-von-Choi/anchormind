/**
 * 관리자 TOTP 비밀 봉인
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * MEMENTO_ADMIN_SEAL_KEY는 쉼표로 나눈 "id:키" 목록이다. 키는 32바이트(base64 또는 64자 hex)이고 첫 항목이
 * 현재 키다. id를 생략한 키 하나는 id v1이다. 봉인은 현재 키로, 해제는 목록의 어느 키로든 한다. 키를 바꿀 때는
 * 새 키를 앞에 두고 옛 키를 뒤에 남긴다. 옛 키로 봉인된 값은 성공한 TOTP 검증 뒤에 현재 키로 다시 봉인한다
 * (needsReseal). 모든 값이 다시 봉인되면 옛 키를 목록에서 뺀다.
 *
 * 봉인 형식: s1.<키 id>.<nonce>.<암호문>.<태그> (base64url). AES-256-GCM, 12바이트 난수 nonce, 16바이트 태그.
 * AAD는 호출자가 정하는 문맥 문자열(계정 id 포함)로, 다른 계정의 행에 옮긴 값은 해제되지 않는다.
 * 오류 메시지에는 키 값과 비밀을 담지 않는다. 순수 함수 모듈이다(node:crypto만 쓴다).
 */

import crypto from "node:crypto";

const SEAL_VERSION   = "s1";
const KEY_BYTES      = 32;
const NONCE_BYTES    = 12;
const TAG_BYTES      = 16;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/;
const HEX_KEY        = /^[0-9a-fA-F]{64}$/;
const BASE64_KEY     = /^[A-Za-z0-9+/_-]+={0,2}$/;
const B64URL_PART    = /^[A-Za-z0-9_-]+$/;

/** 봉인 키 설정 오류. problem: empty, key_id, key_length, duplicate_key_id */
export class SealKeyError extends Error {
  /**
   * @param {string} problem
   * @param {string} message
   */
  constructor(problem, message) {
    super(message);
    this.name    = "SealKeyError";
    this.problem = problem;
  }
}

/** 봉인 값 해제 오류. reason: malformed, unknown_key, auth_failed */
export class SealError extends Error {
  /**
   * @param {string} reason
   * @param {string} message
   */
  constructor(reason, message) {
    super(message);
    this.name   = "SealError";
    this.reason = reason;
  }
}

/**
 * 키 문자열 하나를 32바이트 버퍼로 바꾼다.
 *
 * @param {string} text
 * @returns {Buffer}
 */
function decodeKey(text) {
  if (HEX_KEY.test(text)) return Buffer.from(text, "hex");
  const buf = BASE64_KEY.test(text) ? Buffer.from(text, "base64") : Buffer.alloc(0);
  if (buf.length !== KEY_BYTES) throw new SealKeyError("key_length", "봉인 키는 32바이트(base64 또는 64자 hex)여야 한다");
  return buf;
}

/**
 * MEMENTO_ADMIN_SEAL_KEY 값을 키 목록으로 해석한다.
 *
 * @param {string} raw
 * @returns {{ currentId: string, keys: Map<string, Buffer> }}
 */
export function parseSealKeyRing(raw) {
  const entries = String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) throw new SealKeyError("empty", "봉인 키가 비어 있다");
  const keys = new Map();
  for (const entry of entries) {
    const colon = entry.indexOf(":");
    const id    = colon < 0 && entries.length === 1 ? "v1" : entry.slice(0, Math.max(colon, 0)).trim();
    const text  = colon < 0 ? entry : entry.slice(colon + 1).trim();
    if (!KEY_ID_PATTERN.test(id)) throw new SealKeyError("key_id", "봉인 키 id는 영문자, 숫자, _, -로 된 16자 이하 값이다");
    if (keys.has(id)) throw new SealKeyError("duplicate_key_id", `봉인 키 id ${id}가 두 번 있다`);
    keys.set(id, decodeKey(text));
  }
  return { currentId: [...keys.keys()][0], keys };
}

/**
 * 현재 키로 비밀을 봉인한다.
 *
 * @param {{ currentId: string, keys: Map<string, Buffer> }} ring
 * @param {Buffer} secret
 * @param {string} aad
 * @returns {string}
 */
export function sealSecret(ring, secret, aad) {
  const key    = ring.keys.get(ring.currentId);
  const nonce  = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(String(aad), "utf8"));
  const body = Buffer.concat([cipher.update(secret), cipher.final()]);
  const tag  = cipher.getAuthTag();
  return [SEAL_VERSION, ring.currentId, nonce.toString("base64url"), body.toString("base64url"), tag.toString("base64url")].join(".");
}

/**
 * 봉인 값을 형식 검사해 조각으로 나눈다.
 *
 * @param {unknown} sealed
 * @returns {{ keyId: string, nonce: Buffer, body: Buffer, tag: Buffer }}
 */
function splitSealed(sealed) {
  const parts = typeof sealed === "string" ? sealed.split(".") : [];
  if (parts.length !== 5 || parts[0] !== SEAL_VERSION || !KEY_ID_PATTERN.test(parts[1])
    || !parts.slice(2).every((p) => B64URL_PART.test(p))) {
    throw new SealError("malformed", "봉인 값 형식이 아니다");
  }
  const nonce = Buffer.from(parts[2], "base64url");
  const tag   = Buffer.from(parts[4], "base64url");
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new SealError("malformed", "봉인 값 형식이 아니다");
  return { keyId: parts[1], nonce, body: Buffer.from(parts[3], "base64url"), tag };
}

/**
 * 봉인 값의 키 id.
 *
 * @param {string} sealed
 * @returns {string}
 */
export function sealKeyId(sealed) {
  return splitSealed(sealed).keyId;
}

/**
 * 봉인을 해제한다.
 *
 * @param {{ currentId: string, keys: Map<string, Buffer> }} ring
 * @param {string} sealed
 * @param {string} aad
 * @returns {Buffer}
 */
export function unsealSecret(ring, sealed, aad) {
  const { keyId, nonce, body, tag } = splitSealed(sealed);
  const key = ring.keys.get(keyId);
  if (!key) throw new SealError("unknown_key", `봉인 키 ${keyId}가 목록에 없다`);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(String(aad), "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch (err) {
    throw new SealError("auth_failed", `봉인 값을 해제하지 못했다(${err.code ?? "auth"})`);
  }
}

/**
 * 현재 키가 아닌 키로 봉인된 값인지 본다.
 *
 * @param {{ currentId: string }} ring
 * @param {string} sealed
 * @returns {boolean}
 */
export function needsReseal(ring, sealed) {
  return sealKeyId(sealed) !== ring.currentId;
}
