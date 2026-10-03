/**
 * 관리자 TOTP(RFC 6238)와 base32(RFC 4648)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * HMAC-SHA1, 30초 단계, 6자리. 검증은 앞뒤 한 단계까지 받고, 받은 단계를 돌려준다. 호출자는 그 단계를
 * 계정의 totp_last_step에 원자적으로 기록해(그 값보다 큰 단계만) 같은 코드의 재사용을 막는다. lastStep을
 * 넘기면 그 값 이하의 단계는 replayed로 거부한다. 후보 비교는 길이가 같은 버퍼의 상수 시간 비교다.
 * 순수 함수 모듈이다(node:crypto만 쓴다).
 */

import crypto from "node:crypto";

export const TOTP_STEP_SEC   = 30;
export const TOTP_DIGITS     = 6;
export const TOTP_WINDOW     = 1;
export const TOTP_SECRET_LEN = 20;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CODE_PATTERN    = /^\d{6}$/;

/** base32 입력이나 TOTP 인자 형식 오류 */
export class TotpFormatError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "TotpFormatError";
  }
}

/**
 * base32 인코딩(대문자, 덧붙임 없음).
 *
 * @param {Buffer} buf
 * @returns {string}
 */
export function base32Encode(buf) {
  let out   = "";
  let bits  = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out  += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * base32 디코딩. 대소문자, 공백, 덧붙임(=)을 받아들인다.
 *
 * @param {string} text
 * @returns {Buffer}
 */
export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=]/g, "");
  const bytes = [];
  let bits    = 0;
  let value   = 0;
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new TotpFormatError("base32 알파벳 밖의 문자가 있다");
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * HOTP(RFC 4226). counter는 0 이상의 정수다.
 *
 * @param {Buffer} secret
 * @param {number} counter
 * @param {{ digits?: number }} [options]
 * @returns {string}
 */
export function hotp(secret, counter, { digits = TOTP_DIGITS } = {}) {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new TotpFormatError("counter는 0 이상의 정수다");
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac    = crypto.createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * 유닉스 초의 TOTP 시간 단계.
 *
 * @param {number} timeSec
 * @returns {number}
 */
export function totpStep(timeSec) {
  return Math.floor(timeSec / TOTP_STEP_SEC);
}

/**
 * 시각 timeSec의 TOTP 코드.
 *
 * @param {Buffer} secret
 * @param {number} timeSec
 * @param {{ digits?: number }} [options]
 * @returns {string}
 */
export function totpAt(secret, timeSec, { digits = TOTP_DIGITS } = {}) {
  return hotp(secret, totpStep(timeSec), { digits });
}

/**
 * TOTP 코드를 검증한다. 앞뒤 TOTP_WINDOW 단계까지 받는다.
 *
 * @param {Buffer} secret
 * @param {unknown} code 사용자가 입력한 6자리 숫자 문자열
 * @param {{ nowSec?: number, lastStep?: number|null }} [options]
 * @returns {{ ok: true, step: number }|{ ok: false, reason: "format"|"mismatch"|"replayed" }}
 */
export function verifyTotp(secret, code, { nowSec = Date.now() / 1000, lastStep = null } = {}) {
  if (typeof code !== "string" || !CODE_PATTERN.test(code)) return { ok: false, reason: "format" };
  const given   = Buffer.from(code);
  const current = totpStep(nowSec);
  let matched   = null;
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
    const step = current + delta;
    if (step < 0) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (crypto.timingSafeEqual(expected, given) && matched === null) matched = step;
  }
  if (matched === null) return { ok: false, reason: "mismatch" };
  if (lastStep !== null && lastStep !== undefined && matched <= Number(lastStep)) return { ok: false, reason: "replayed" };
  return { ok: true, step: matched };
}

/**
 * 새 TOTP 비밀(20바이트 난수).
 *
 * @returns {Buffer}
 */
export function generateTotpSecret() {
  return crypto.randomBytes(TOTP_SECRET_LEN);
}

/**
 * 인증 앱 등록용 otpauth URI.
 *
 * @param {{ issuer: string, account: string, secret: Buffer }} args
 * @returns {string}
 */
export function otpauthUri({ issuer, account, secret }) {
  const label  = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret   : base32Encode(secret),
    issuer,
    algorithm: "SHA1",
    digits   : String(TOTP_DIGITS),
    period   : String(TOTP_STEP_SEC)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
