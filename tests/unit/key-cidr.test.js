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
    assert.deepEqual(parseCidr("10.0.0.0/8"),      { address: "10.0.0.0", prefix: 8, family: "ipv4" });
    assert.deepEqual(parseCidr("2001:db8::/32"),   { address: "2001:db8::", prefix: 32, family: "ipv6" });
    assert.deepEqual(parseCidr("203.0.113.5"),     { address: "203.0.113.5", prefix: 32, family: "ipv4" });
    assert.deepEqual(parseCidr("::1"),             { address: "::1", prefix: 128, family: "ipv6" });
    assert.deepEqual(parseCidr(" 192.168.0.0/16 "), { address: "192.168.0.0", prefix: 16, family: "ipv4" });
  });

  it("범위 밖 접두 길이, 숫자가 아닌 접두, 주소가 아닌 값, 영역 표기는 null이다", () => {
    for (const bad of ["10.0.0.0/33", "2001:db8::/129", "10.0.0.0/-1", "10.0.0.0/8a", "10.0.0.0/", "/8",
      "10.0.0", "example.com/24", "", "fe80::1%eth0/64", "10.0.0.0/08", null, 42]) {
      assert.equal(parseCidr(bad), null, String(bad));
    }
  });
});

describe("요청 주소 정규화", () => {
  it("IPv4 매핑 IPv6 주소는 IPv4로 본다", () => {
    assert.deepEqual(normalizeClientAddress("::ffff:10.1.2.3"), { address: "10.1.2.3", family: "ipv4" });
    assert.deepEqual(normalizeClientAddress("::FFFF:10.1.2.3"), { address: "10.1.2.3", family: "ipv4" });
    assert.deepEqual(normalizeClientAddress("10.1.2.3"),        { address: "10.1.2.3", family: "ipv4" });
    assert.deepEqual(normalizeClientAddress("2001:db8::1"),     { address: "2001:db8::1", family: "ipv6" });
  });

  it("판정할 수 없는 주소는 null이다", () => {
    for (const bad of ["unknown", "", null, undefined, "fe80::1%eth0", "10.0.0.256"]) {
      assert.equal(normalizeClientAddress(bad), null, String(bad));
    }
  });
});

describe("키 허용 대역 판정", () => {
  it("목록이 없는 키는 주소와 무관하게 통과한다", () => {
    assert.deepEqual(checkKeyAddress(null, "unknown"),       { allowed: true, reason: "no_list" });
    assert.deepEqual(checkKeyAddress(undefined, "10.0.0.1"), { allowed: true, reason: "no_list" });
  });

  it("IPv4 대역 안의 주소, 매핑 표기 주소는 통과한다", () => {
    const list = ["10.0.0.0/8", "203.0.113.5"];
    assert.equal(checkKeyAddress(list, "10.200.1.1").allowed, true);
    assert.equal(checkKeyAddress(list, "::ffff:10.200.1.1").allowed, true);
    assert.equal(checkKeyAddress(list, "::ffff:a01:203").allowed, true);
    assert.equal(checkKeyAddress(list, "203.0.113.5").allowed, true);
  });

  it("대역 밖 주소는 not_in_list로 거부한다", () => {
    const list = ["10.0.0.0/8"];
    assert.deepEqual(checkKeyAddress(list, "11.0.0.1"), { allowed: false, reason: "not_in_list" });
    assert.deepEqual(checkKeyAddress(list, "2001:db8::1"), { allowed: false, reason: "not_in_list" });
    assert.deepEqual(checkKeyAddress(["203.0.113.5"], "203.0.113.6"), { allowed: false, reason: "not_in_list" });
  });

  it("IPv6 대역을 판정한다", () => {
    const list = ["2001:db8::/32"];
    assert.equal(checkKeyAddress(list, "2001:db8:1::5").allowed, true);
    assert.equal(checkKeyAddress(list, "2001:db9::5").allowed, false);
    assert.equal(checkKeyAddress(list, "10.0.0.1").allowed, false);
  });

  it("IPv4 매핑 IPv6 대역은 IPv4 요청 주소에도 적용된다", () => {
    assert.equal(checkKeyAddress(["::ffff:10.0.0.0/104"], "10.1.2.3").allowed, true);
  });

  it("빈 목록은 모든 주소를 거부한다", () => {
    assert.deepEqual(checkKeyAddress([], "10.0.0.1"), { allowed: false, reason: "not_in_list" });
  });

  it("항목 하나라도 잘못된 목록은 어떤 주소도 통과시키지 않는다", () => {
    assert.deepEqual(checkKeyAddress(["10.0.0.0/8", "garbage"], "10.0.0.1"), { allowed: false, reason: "malformed_list" });
    assert.deepEqual(checkKeyAddress("10.0.0.0/8", "10.0.0.1"),              { allowed: false, reason: "malformed_list" });
    assert.deepEqual(checkKeyAddress([null], "10.0.0.1"),                    { allowed: false, reason: "malformed_list" });
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
    assert.deepEqual(validateCidrList([" 10.0.0.0/8", "2001:db8::/32 "]), ["10.0.0.0/8", "2001:db8::/32"]);
    assert.deepEqual(validateCidrList(["203.0.113.5"]), ["203.0.113.5/32"]);
    assert.equal(validateCidrList(null), null);
    assert.deepEqual(validateCidrList([]), []);
  });

  it("배열이 아닌 값, 잘못된 항목, 상한 초과, 중복은 오류다", () => {
    assert.throws(() => validateCidrList("10.0.0.0/8"), /allowed_cidrs/);
    assert.throws(() => validateCidrList(["10.0.0.0/33"]), /allowed_cidrs/);
    assert.throws(() => validateCidrList(["10.0.0.0/8", "10.0.0.0/8"]), /allowed_cidrs/);
    assert.throws(() => validateCidrList(Array.from({ length: MAX_ALLOWED_CIDRS + 1 }, (_, i) => `10.0.${i % 256}.${Math.floor(i / 256)}`)), /allowed_cidrs/);
  });
});
