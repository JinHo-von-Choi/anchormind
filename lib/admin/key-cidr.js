/**
 * API 키 허용 주소 대역(allowed_cidrs) 판정
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 키의 allowed_cidrs가 NULL이면 주소 제한이 없다. 목록이 있으면 요청 주소(신뢰 프록시 hop 수를 적용한
 * resolveClientIp 값)가 목록의 대역 하나에 들어야 통과한다. 목록이 있는 키에서는 다음을 거부한다.
 *   - 목록 항목 하나라도 대역 표기가 아니다(malformed_list)
 *   - 요청 주소를 IPv4, IPv6 주소로 읽을 수 없다(invalid_address)
 *   - 어느 대역에도 들지 않는다, 빈 목록 포함(not_in_list)
 * IPv4 매핑 IPv6 주소(::ffff:a.b.c.d)는 IPv4 주소로 판정한다. 판정은 node:net BlockList를 쓴다.
 * 저장소와 HTTP에 의존하지 않는다.
 */

import net from "node:net";
import { KeyPolicyValidationError } from "./key-policy.js";

/** allowed_cidrs 항목 수 상한 */
export const MAX_ALLOWED_CIDRS = 64;

/** 대역 표기 한 항목의 길이 상한(IPv6 주소 45자 + "/128") */
const MAX_CIDR_TEXT = 49;

/** 컴파일한 목록 캐시 크기 */
const MATCHER_CACHE_MAX = 1000;

const PREFIX_PATTERN = /^(0|[1-9]\d{0,2})$/;
const MAPPED_V4      = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** 목록 문자열 → BlockList 또는 null(잘못된 목록) */
const matcherCache = new Map();

/**
 * 대역 표기 한 항목을 읽는다. 접두 길이가 없으면 단일 주소(/32, /128)다.
 *
 * @param {unknown} text
 * @returns {{ address: string, prefix: number, family: "ipv4"|"ipv6" }|null}
 */
export function parseCidr(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CIDR_TEXT) return null;

  const slash   = trimmed.indexOf("/");
  const address = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const version = address.includes("%") ? 0 : net.isIP(address);
  if (version === 0) return null;

  const family = version === 4 ? "ipv4" : "ipv6";
  const max    = version === 4 ? 32 : 128;
  if (slash === -1) return { address, prefix: max, family };

  const prefixText = trimmed.slice(slash + 1);
  if (!PREFIX_PATTERN.test(prefixText)) return null;
  const prefix = Number(prefixText);
  return prefix <= max ? { address, prefix, family } : null;
}

/**
 * 요청 주소를 판정용 주소로 바꾼다. 영역 표기(%)가 있거나 IP 주소가 아니면 null이다.
 *
 * @param {unknown} ip
 * @returns {{ address: string, family: "ipv4"|"ipv6" }|null}
 */
export function normalizeClientAddress(ip) {
  if (typeof ip !== "string" || ip.length === 0 || ip.includes("%")) return null;
  const mapped = MAPPED_V4.exec(ip);
  const text   = mapped ? mapped[1] : ip;
  const version = net.isIP(text);
  if (version === 0) return null;
  return { address: text, family: version === 4 ? "ipv4" : "ipv6" };
}

/**
 * 목록을 BlockList로 만든다. 항목 하나라도 잘못되면 null이다.
 *
 * @param {unknown[]} list
 * @returns {net.BlockList|null}
 */
function compile(list) {
  const blockList = new net.BlockList();
  for (const entry of list) {
    const cidr = parseCidr(entry);
    if (!cidr) return null;
    blockList.addSubnet(cidr.address, cidr.prefix, cidr.family);
  }
  return blockList;
}

/**
 * 캐시한 BlockList를 돌려준다.
 *
 * @param {unknown[]} list
 * @returns {net.BlockList|null}
 */
function matcherFor(list) {
  const cacheKey = JSON.stringify(list);
  if (matcherCache.has(cacheKey)) return matcherCache.get(cacheKey);
  const matcher = compile(list);
  matcherCache.set(cacheKey, matcher);
  if (matcherCache.size > MATCHER_CACHE_MAX) matcherCache.delete(matcherCache.keys().next().value);
  return matcher;
}

/**
 * 키의 허용 대역에 요청 주소가 드는지 판정한다.
 *
 * @param {unknown} allowedCidrs 키의 allowed_cidrs 값(NULL이면 제한 없음)
 * @param {unknown} clientIp     resolveClientIp 결과
 * @returns {{ allowed: boolean, reason: "no_list"|"in_list"|"malformed_list"|"invalid_address"|"not_in_list" }}
 */
export function checkKeyAddress(allowedCidrs, clientIp) {
  if (allowedCidrs === null || allowedCidrs === undefined) return { allowed: true, reason: "no_list" };
  if (!Array.isArray(allowedCidrs)) return { allowed: false, reason: "malformed_list" };

  const matcher = matcherFor(allowedCidrs);
  if (!matcher) return { allowed: false, reason: "malformed_list" };

  const client = normalizeClientAddress(clientIp);
  if (!client) return { allowed: false, reason: "invalid_address" };

  return matcher.check(client.address, client.family)
    ? { allowed: true, reason: "in_list" }
    : { allowed: false, reason: "not_in_list" };
}

/**
 * 편집 값 검증. NULL은 제한 해제, 빈 배열은 모든 주소 거부다. 항목은 "주소/접두 길이" 정규 표기로 돌려준다.
 *
 * @param {unknown} value
 * @returns {string[]|null}
 * @throws {KeyPolicyValidationError}
 */
export function validateCidrList(value) {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new KeyPolicyValidationError("allowed_cidrs", "allowed_cidrs must be null or an array of CIDR strings");
  }
  if (value.length > MAX_ALLOWED_CIDRS) {
    throw new KeyPolicyValidationError("allowed_cidrs", `allowed_cidrs accepts at most ${MAX_ALLOWED_CIDRS} entries`);
  }
  const normalized = value.map((entry) => {
    const cidr = parseCidr(entry);
    if (!cidr) throw new KeyPolicyValidationError("allowed_cidrs", "allowed_cidrs entries must be IPv4 or IPv6 CIDR blocks");
    return `${cidr.address}/${cidr.prefix}`;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new KeyPolicyValidationError("allowed_cidrs", "allowed_cidrs must not contain duplicates");
  }
  return normalized;
}
