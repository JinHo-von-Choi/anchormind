/**
 * API 키 원시 값 생성과 해시
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 원시 키는 생성 응답에서 한 번만 돌려주고 저장하지 않는다. 저장소에는 SHA-256 해시와 표시용
 * 접두(앞 14자)만 남긴다. 키 생성과 회전이 같은 함수를 쓴다.
 */

import { createHash, randomBytes } from "node:crypto";

/** 표시용 접두 길이 */
export const KEY_PREFIX_LENGTH = 14;

/**
 * SHA-256 해시(16진 64자)
 *
 * @param {string} raw
 * @returns {string}
 */
export function hashKey(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * 새 원시 키. 형식: mmcp_<8자 슬러그>_<32 hex chars>
 *
 * @param {string} name
 * @returns {string}
 */
export function generateRawKey(name) {
  const slug   = String(name).replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase() || "key";
  const random = randomBytes(16).toString("hex");
  return `mmcp_${slug}_${random}`;
}

/**
 * 새 원시 키와 저장할 해시, 접두.
 *
 * @param {string} name
 * @returns {{ rawKey: string, hash: string, prefix: string }}
 */
export function newKeyMaterial(name) {
  const rawKey = generateRawKey(name);
  return { rawKey, hash: hashKey(rawKey), prefix: rawKey.slice(0, KEY_PREFIX_LENGTH) };
}
