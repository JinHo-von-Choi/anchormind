/**
 * 로그 마스킹이 규칙 표를 쓰는 동작 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 로그용 기존 항목의 결과는 그대로이고, 저장 경로와 공용인 토큰 규칙이 로그에도 적용되는지 본다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { redactString } from "../../lib/logger.js";

const rep = (ch, n) => ch.repeat(n);

describe("로그 마스킹의 기존 항목", () => {
  it("Authorization 헤더, 값만 있는 Bearer, 쿠키, mmcp_ 키, OAuth 파라미터를 같은 표식으로 가린다", () => {
    assert.ok(redactString("Authorization: Bearer abc.def").includes("Authorization: Bearer ****"));
    assert.equal(redactString("Bearer abc123"), "Bearer ****");
    assert.ok(redactString("Cookie: mmcp_session=abcdef; x=1").includes("mmcp_session=****;"));
    assert.ok(redactString("key mmcp_AbCd1234").includes("mmcp_****"));
    assert.ok(redactString('{"code":"xyz"}').includes('"code":"****"'));
    assert.ok(redactString('{"refresh_token":"xyz"}').includes('"refresh_token":"****"'));
    assert.ok(redactString('{"access_token":"xyz"}').includes('"access_token":"****"'));
  });

  it("민감하지 않은 문자열은 바꾸지 않는다", () => {
    const text = "서버 시작 port=57332 tools=18 workspace=default";
    assert.equal(redactString(text), text);
  });
});

describe("로그 마스킹의 공용 토큰 규칙", () => {
  const cases = [
    ["Anthropic 키", `sk-ant-api03-${rep("A1b2", 20)}`, "sk-ant-****"],
    ["OpenAI 프로젝트 키", `sk-proj-${rep("a1B2", 14)}`, "sk-proj-****"],
    ["GitHub 토큰", `ghp_${rep("a1", 18)}`, "[REDACTED_TOKEN]"],
    ["AWS 액세스 키", `AKIA${rep("A1", 8)}`, "[REDACTED_API_KEY]"],
    ["Slack 토큰", `xoxb-${rep("1", 12)}-${rep("aB", 12)}`, "[REDACTED_TOKEN]"],
    ["JWT", `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.${rep("s", 22)}`, "[REDACTED_TOKEN]"],
    ["PEM 개인 키", `-----BEGIN RSA PRIVATE KEY-----\n${rep("MIIE", 20)}\n-----END RSA PRIVATE KEY-----`, "[REDACTED_PRIVATE_KEY]"]
  ];

  for (const [label, secret, marker] of cases) {
    it(`${label}를 로그에서도 가린다`, () => {
      const out = redactString(`요청 처리 중 ${secret} 확인`);
      assert.ok(out.includes(marker), out);
      assert.ok(!out.includes(secret.slice(0, 30)), out);
    });
  }

  it("저장 경로 전용 규칙(이메일, 전화번호, 카드 번호, 주민등록번호)은 로그에 적용하지 않는다", () => {
    const text = "ops@example.com 010-1234-5678 4111111111111111 900101-1234567 1759468800000";
    assert.equal(redactString(text), text);
  });

  it("긴 입력에서도 시간이 선형으로 늘어난다", () => {
    for (const text of [rep("eyJ", 70_000), rep("-----BEGIN PRIVATE KEY-----", 8_000), rep("sk-ant-", 30_000), rep("AKIA", 50_000)]) {
      const started = performance.now();
      redactString(text);
      assert.ok(performance.now() - started < 1500);
    }
  });
});
