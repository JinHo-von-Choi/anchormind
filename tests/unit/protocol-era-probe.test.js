/**
 * 프로토콜 개정 폴백 관찰 스크립트의 순수 함수 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const { resolvePort, classifyEra } = await import("../../scripts/measure/protocol-era-probe.mjs");

describe("resolvePort", () => {
  it("인자가 없으면 18913", () => {
    assert.equal(resolvePort(undefined), 18913);
  });

  it("10000 이상 정수 포트를 받는다", () => {
    assert.equal(resolvePort("18914"), 18914);
  });

  it("서비스 포트 57332와 범위 밖, 정수 아닌 값은 거부한다", () => {
    for (const bad of ["57332", "8080", "70000", "abc", "18913.5"]) {
      assert.throws(() => resolvePort(bad), { name: "ProbeConfigError" }, bad);
    }
  });
});

describe("classifyEra", () => {
  it("400과 구현 정의 구간 코드 -32000은 legacy", () => {
    assert.equal(classifyEra({ status: 400, body: { error: { code: -32000 } } }), "legacy");
  });

  it("빈 본문이나 JSON-RPC가 아닌 4xx는 legacy", () => {
    assert.equal(classifyEra({ status: 400, body: null }), "legacy");
    assert.equal(classifyEra({ status: 405, body: { unparsed: "" } }), "legacy");
  });

  it("개정 정의 오류 -32020, -32021, -32022는 modern", () => {
    for (const code of [-32020, -32021, -32022]) {
      assert.equal(classifyEra({ status: 400, body: { error: { code } } }), "modern");
    }
  });

  it("404와 -32601은 modern, 404와 -32000은 legacy", () => {
    assert.equal(classifyEra({ status: 404, body: { error: { code: -32601 } } }), "modern");
    assert.equal(classifyEra({ status: 404, body: { error: { code: -32000 } } }), "legacy");
  });

  it("2xx 응답은 modern", () => {
    assert.equal(classifyEra({ status: 200, body: { result: {} } }), "modern");
  });
});
