/**
 * 타이밍 안전 문자열 비교
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { timingSafeEqual, createHash } from "node:crypto";

/**
 * 상수 시간 문자열 비교(constant-time comparison)
 * SHA-256 해시 후 timingSafeEqual 비교 (length early-return 없음)
 */
export function safeCompare(a, b) {
  const hashA = createHash("sha256").update(String(a)).digest();
  const hashB = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(hashA, hashB);
}
