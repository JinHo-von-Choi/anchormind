/**
 * 잘못된 X-Forwarded-For 항목 경고 시험: 소켓 주소로 대체될 때 고정 문구 경고가 프로세스당 한 줄만 남는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, mock } from "node:test";
import assert                 from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";

const { getClientIp }     = await import("../../lib/http/helpers.js");
const { default: logger } = await import("../../lib/logger.js");

const reqWith = (xff) => ({ headers: { "x-forwarded-for": xff }, socket: { remoteAddress: "10.0.0.1" } });

describe("잘못된 전달 주소 항목 경고", () => {
  it("유효한 주소는 경고하지 않고, 잘못된 항목은 값 없이 한 줄만 경고한다", () => {
    const lines = [];
    const spy   = mock.method(logger, "warn", (...a) => { lines.push(JSON.stringify(a)); return logger; });
    try {
      assert.equal(getClientIp(reqWith("203.0.113.9"), 1), "203.0.113.9");
      assert.equal(lines.length, 0);

      assert.equal(getClientIp(reqWith("evil-value-1"), 1), "10.0.0.1");
      assert.equal(getClientIp(reqWith("evil-value-2"), undefined), "10.0.0.1");
      assert.equal(getClientIp(reqWith("evil-value-3; x"), 2), "10.0.0.1");
    } finally {
      spy.mock.restore();
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /forwarded address entry is not a valid IP address/);
    assert.doesNotMatch(lines[0], /evil-value|10\.0\.0\.1/);
  });
});
