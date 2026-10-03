/**
 * API 키 허용 주소 대역 판정 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 순수 함수 시험: 대역 표기 해석, IPv4, IPv6, IPv4 매핑 IPv6 주소의 판정, 목록이 없는 키의 통과,
 * 잘못된 목록과 판정할 수 없는 주소의 거부(목록이 있는 키에 한함).
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
  parseCidr, normalizeClientAddress, checkKeyAddress, validateCidrList, MAX_ALLOWED_CIDRS
} from "../../lib/admin/key-cidr.js";

describe("대역 표기 해석", () => {
  it("IPv4와 IPv6 대역, 접두 길이 없는 단일 주소를 읽는다", () => {
    assert.deepEqual(parseCidr("198.51.100.0/24"), { address: "198.51.100.0", prefix: 24, family: "ipv4" });
    assert.deepEqual(parseCidr("2001:db8::/32"),   { address: "2001:db8::", prefix: 32, family: "ipv6" });
    assert.deepEqual(parseCidr("203.0.113.5"),     { address: "203.0.113.5", prefix: 32, family: "ipv4" });
    assert.deepEqual(parseCidr("::1"),             { address: "::1", prefix: 128, family: "ipv6" });
    assert.deepEqual(parseCidr(" 203.0.113.0/25 "), { address: "203.0.113.0", prefix: 25, family: "ipv4" });
  });

  it("범위 밖 접두 길이, 숫자가 아닌 접두, 주소가 아닌 값, 영역 표기는 null이다", () => {
    for (const bad of ["198.51.100.0/33", "2001:db8::/129", "198.51.100.0/-1", "198.51.100.0/24a", "198.51.100.0/", "/8",
      "198.51.100", "example.com/24", "", "fe80::1%eth0/64", "198.51.100.0/024", null, 42]) {
      assert.equal(parseCidr(bad), null, String(bad));
    }
  });
});

describe("요청 주소 정규화", () => {
  it("IPv4 매핑 IPv6 주소는 IPv4로 본다", () => {
    assert.deepEqual(normalizeClientAddress("::ffff:198.51.100.3"), { address: "198.51.100.3", family: "ipv4" });
    assert.deepEqual(normalizeClientAddress("::FFFF:198.51.100.3"), { address: "198.51.100.3", family: "ipv4" });
    assert.deepEqual(normalizeClientAddress("198.51.100.3"),        { address: "198.51.100.3", family: "ipv4" });
    assert.deepEqual(normalizeClientAddress("2001:db8::1"),     { address: "2001:db8::1", family: "ipv6" });
  });

  it("판정할 수 없는 주소는 null이다", () => {
    for (const bad of ["unknown", "", null, undefined, "fe80::1%eth0", "198.51.100.256"]) {
      assert.equal(normalizeClientAddress(bad), null, String(bad));
    }
  });
});

describe("키 허용 대역 판정", () => {
  it("목록이 없는 키는 주소와 무관하게 통과한다", () => {
    assert.deepEqual(checkKeyAddress(null, "unknown"),       { allowed: true, reason: "no_list" });
    assert.deepEqual(checkKeyAddress(undefined, "198.51.100.1"), { allowed: true, reason: "no_list" });
  });

  it("IPv4 대역 안의 주소, 매핑 표기 주소는 통과한다", () => {
    const list = ["198.51.100.0/24", "203.0.113.5"];
    assert.equal(checkKeyAddress(list, "198.51.100.200").allowed, true);
    assert.equal(checkKeyAddress(list, "::ffff:198.51.100.200").allowed, true);
    assert.equal(checkKeyAddress(list, "::ffff:c633:64c8").allowed, true);
    assert.equal(checkKeyAddress(list, "203.0.113.5").allowed, true);
  });

  it("대역 밖 주소는 not_in_list로 거부한다", () => {
    const list = ["198.51.100.0/24"];
    assert.deepEqual(checkKeyAddress(list, "192.0.2.1"), { allowed: false, reason: "not_in_list" });
    assert.deepEqual(checkKeyAddress(list, "2001:db8::1"), { allowed: false, reason: "not_in_list" });
    assert.deepEqual(checkKeyAddress(["203.0.113.5"], "203.0.113.6"), { allowed: false, reason: "not_in_list" });
  });

  it("IPv6 대역을 판정한다", () => {
    const list = ["2001:db8::/32"];
    assert.equal(checkKeyAddress(list, "2001:db8:1::5").allowed, true);
    assert.equal(checkKeyAddress(list, "2001:db9::5").allowed, false);
    assert.equal(checkKeyAddress(list, "198.51.100.1").allowed, false);
  });

  it("IPv4 매핑 IPv6 대역은 IPv4 요청 주소에도 적용된다", () => {
    assert.equal(checkKeyAddress(["::ffff:198.51.100.0/120"], "198.51.100.3").allowed, true);
  });

  it("빈 목록은 모든 주소를 거부한다", () => {
    assert.deepEqual(checkKeyAddress([], "198.51.100.1"), { allowed: false, reason: "not_in_list" });
  });

  it("항목 하나라도 잘못된 목록은 어떤 주소도 통과시키지 않는다", () => {
    assert.deepEqual(checkKeyAddress(["198.51.100.0/24", "garbage"], "198.51.100.1"), { allowed: false, reason: "malformed_list" });
    assert.deepEqual(checkKeyAddress("198.51.100.0/24", "198.51.100.1"),              { allowed: false, reason: "malformed_list" });
    assert.deepEqual(checkKeyAddress([null], "198.51.100.1"),                    { allowed: false, reason: "malformed_list" });
  });

  it("목록이 있는 키에서 판정할 수 없는 요청 주소는 거부한다", () => {
    assert.deepEqual(checkKeyAddress(["0.0.0.0/0"], "unknown"), { allowed: false, reason: "invalid_address" });
    assert.deepEqual(checkKeyAddress(["::/0"], ""),             { allowed: false, reason: "invalid_address" });
  });

  it("0.0.0.0/0은 모든 IPv4 주소를 허용한다", () => {
    assert.equal(checkKeyAddress(["0.0.0.0/0"], "198.51.100.7").allowed, true);
    assert.equal(checkKeyAddress(["0.0.0.0/0"], "2001:db8::1").allowed, false);
  });
});

describe("편집 값 검증", () => {
  it("공백을 지운 정규 표기 목록을 돌려준다", () => {
    assert.deepEqual(validateCidrList([" 198.51.100.0/24", "2001:db8::/32 "]), ["198.51.100.0/24", "2001:db8::/32"]);
    assert.deepEqual(validateCidrList(["203.0.113.5"]), ["203.0.113.5/32"]);
    assert.equal(validateCidrList(null), null);
    assert.deepEqual(validateCidrList([]), []);
  });

  it("배열이 아닌 값, 잘못된 항목, 상한 초과, 중복은 오류다", () => {
    assert.throws(() => validateCidrList("198.51.100.0/24"), /allowed_cidrs/);
    assert.throws(() => validateCidrList(["198.51.100.0/33"]), /allowed_cidrs/);
    assert.throws(() => validateCidrList(["198.51.100.0/24", "198.51.100.0/24"]), /allowed_cidrs/);
    assert.throws(() => validateCidrList(Array.from({ length: MAX_ALLOWED_CIDRS + 1 }, (_, i) => `198.51.100.${i}`)), /allowed_cidrs/);
  });
});
