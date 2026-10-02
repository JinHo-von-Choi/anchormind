/**
 * OAUTH_ACCESS_TOKEN_TTL_SECONDS 설정 시험. 갱신 토큰 수명은 세션 수명 기준을 유지한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { it } from "node:test";
import assert from "node:assert/strict";

process.env.OAUTH_ACCESS_TOKEN_TTL_SECONDS = "3600";
delete process.env.SESSION_TTL_MINUTES;
process.env.DOTENV_CONFIG_PATH ??= ".env.test";

const { OAUTH_TOKEN_TTL_SECONDS, OAUTH_REFRESH_TTL_SECONDS } = await import("../../lib/config.js");

it("접근 토큰만 짧아지고 갱신 토큰은 세션 수명의 2배를 유지한다", () => {
  assert.equal(OAUTH_TOKEN_TTL_SECONDS, 3600);
  assert.equal(OAUTH_REFRESH_TTL_SECONDS, 43200 * 60 * 2);
});
