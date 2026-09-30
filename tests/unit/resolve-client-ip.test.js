import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.TRUST_PROXY_HOPS = "1";
const { resolveClientIp } = await import("../../lib/http/helpers.js");

describe("resolveClientIp (TRUST_PROXY_HOPS=1)", () => {
  it("첫 항목 대신 프록시가 덧붙인 마지막 항목을 채택한다", () => {
    const req = { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" }, socket: { remoteAddress: "127.0.0.1" } };
    assert.equal(resolveClientIp(req), "203.0.113.9");
  });

  it("헤더가 없으면 소켓 주소로 판정한다", () => {
    const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
    assert.equal(resolveClientIp(req), "127.0.0.1");
  });
});
