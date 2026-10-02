/**
 * 프록시 hop 미설정 진단 시험. 이 파일의 프로세스는 TRUST_PROXY_HOPS를 설정하지 않는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";

delete process.env.TRUST_PROXY_HOPS;
process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";

const { resolveClientIp, getProxyDiagnostic, proxyHealthFlags, recommendedSettingsGap } = await import("../../lib/http/helpers.js");

describe("TRUST_PROXY_HOPS 미설정 진단", () => {
  it("헤더가 없으면 소켓 주소를 쓰고 진단 표식을 남기지 않는다", () => {
    assert.equal(getProxyDiagnostic().forwardedSeenWithoutHops, false);
    assert.equal(resolveClientIp({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }), "127.0.0.1");
    assert.equal(getProxyDiagnostic().forwardedSeenWithoutHops, false);
    assert.deepEqual(proxyHealthFlags(), []);
  });

  it("X-Forwarded-For를 받으면 첫 항목을 쓰고 진단 표식을 남긴다", () => {
    const ip = resolveClientIp({ headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" }, socket: { remoteAddress: "127.0.0.1" } });
    assert.equal(ip, "6.6.6.6");
    assert.deepEqual(getProxyDiagnostic(), { hopsConfigured: false, forwardedSeenWithoutHops: true });
    assert.deepEqual(proxyHealthFlags(), ["trust_proxy_hops_unset"]);
  });
});

describe("recommendedSettingsGap", () => {
  it("권장 묶음이 모두 설정되면 빈 목록", () => {
    assert.deepEqual(recommendedSettingsGap({
      TRUST_PROXY_HOPS: "1", MEMENTO_CORS_MODE: "allowlist", MEMENTO_FRAME_OPTIONS: "deny",
      MEMENTO_OAUTH_REDIRECT_CHECK: "enforce", MEMENTO_SSE_QUERY_KEY: "deny", MEMENTO_TOOL_ARGS_VALIDATION: "enforce"
    }), []);
  });

  it("빈 환경에서는 여섯 항목 이름만 돌려주고 값은 싣지 않는다", () => {
    const gap = recommendedSettingsGap({});
    assert.equal(gap.length, 6);
    assert.equal(gap[0], "TRUST_PROXY_HOPS");
  });
});
