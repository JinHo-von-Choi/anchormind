/**
 * 클라이언트 IP 판정 시험: X-Forwarded-For에서 고른 항목이 IPv4/IPv6 주소 형식이 아니면 소켓 주소를 쓴다.
 * 실제 getClientIp를 hop 설정별로 호출한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";

const { getClientIp } = await import("../../lib/http/helpers.js");

const SOCKET = "10.0.0.1";
const reqWith = (xff) => ({ headers: xff === undefined ? {} : { "x-forwarded-for": xff }, socket: { remoteAddress: SOCKET } });

const HOPS_MODES = [["미설정", undefined], ["1", 1], ["2", 2], ["5", 5]];

describe("getClientIp 값 검증", () => {
  for (const [label, hops] of HOPS_MODES) {
    describe(`hops=${label}`, () => {
      it("IPv4 주소를 그대로 돌려준다", () => {
        assert.equal(getClientIp(reqWith("203.0.113.9"), hops), "203.0.113.9");
      });

      it("IPv6 주소와 IPv4 매핑 형식을 그대로 돌려준다", () => {
        assert.equal(getClientIp(reqWith("2001:db8::1"), hops), "2001:db8::1");
        assert.equal(getClientIp(reqWith("::ffff:203.0.113.9"), hops), "::ffff:203.0.113.9");
      });

      it("8KB 문자열은 소켓 주소로 대체하고 값을 돌려주지 않는다", () => {
        const long = "9".repeat(8192);
        const ip   = getClientIp(reqWith(long), hops);
        assert.equal(ip, SOCKET);
      });

      it("공백, |, ;, 개행이 섞인 값은 소켓 주소로 대체한다", () => {
        for (const bad of ["1.2.3.4 evil", "1.2.3.4|x", "1.2.3.4;x", "1.2.3.4\nx", "1.2.3.4\r\nHost: x", "a b"]) {
          assert.equal(getClientIp(reqWith(bad), hops), SOCKET, JSON.stringify(bad));
        }
      });

      it("unknown과 비주소 토큰은 소켓 주소로 대체한다", () => {
        for (const bad of ["unknown", "_hidden", "localhost", "example.com", "999.1.1.1", "1.2.3"]) {
          assert.equal(getClientIp(reqWith(bad), hops), SOCKET, bad);
        }
      });

      it("포트 접미사가 붙은 값은 소켓 주소로 대체한다", () => {
        for (const bad of ["203.0.113.9:8080", "[2001:db8::1]:443"]) {
          assert.equal(getClientIp(reqWith(bad), hops), SOCKET, bad);
        }
      });

      it("빈 값은 소켓 주소를 쓴다", () => {
        assert.equal(getClientIp(reqWith(""), hops), SOCKET);
        assert.equal(getClientIp(reqWith(" , "), hops), SOCKET);
      });
    });
  }

  it("hops=0은 헤더를 무시하고 소켓 주소를 쓴다", () => {
    assert.equal(getClientIp(reqWith("203.0.113.9"), 0), SOCKET);
    assert.equal(getClientIp(reqWith("bad value"), 0), SOCKET);
  });

  it("선택된 항목만 검사한다", () => {
    assert.equal(getClientIp(reqWith("bad value, 203.0.113.9"), 1), "203.0.113.9");
    assert.equal(getClientIp(reqWith("203.0.113.9, bad value"), 1), SOCKET);
    assert.equal(getClientIp(reqWith("203.0.113.9, bad value"), undefined), "203.0.113.9");
    assert.equal(getClientIp(reqWith("bad value, 203.0.113.9"), undefined), SOCKET);
  });

  it("소켓 주소도 없으면 unknown이다", () => {
    assert.equal(getClientIp({ headers: { "x-forwarded-for": "bad value" }, socket: {} }, 1), "unknown");
  });

  it("45자 IPv6 최대 길이 표기는 허용한다", () => {
    const full = "ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255";
    assert.equal(full.length, 45);
    assert.equal(getClientIp(reqWith(full), 1), full);
  });

  it("45자를 넘는 값은 주소 형식이어도 대체한다", () => {
    const zoned = "fe80::1%" + "e".repeat(40);
    assert.equal(getClientIp(reqWith(zoned), 1), SOCKET);
  });
});
