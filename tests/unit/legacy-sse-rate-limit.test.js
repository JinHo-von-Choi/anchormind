/**
 * Legacy SSE 세션 생성 경로의 IP 기준 제한 단위 시험.
 * 실제 처리기와 DualRateLimiter를 사용하고 인증 계층만 대체한다.
 * server.js는 import 시 바로 기동하므로 호출부 연결은 소스로 확인한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const realAuth = await import("../../lib/auth.js");
mock.module("../../lib/auth.js", {
  namedExports: { ...realAuth, validateAuthentication: async () => ({ valid: false }) }
});

const { handleLegacySseGet }   = await import("../../lib/handlers/sse-handler.js");
const { DualRateLimiter }      = await import("../../lib/rate-limiter.js");
const { RATE_LIMIT_WINDOW_MS } = await import("../../lib/config.js");

const SRC = readFileSync(path.resolve(import.meta.dirname, "../../server.js"), "utf8");

const LIMIT = 3;

let server;
let base;
let limiter;

before(async () => {
  limiter = new DualRateLimiter({ windowMs: 60_000, perIp: LIMIT, perKey: 100 });
  server  = http.createServer((req, res) => { handleLegacySseGet(req, res, limiter); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  limiter.destroy();
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
});

describe("GET /sse IP 기준 제한", () => {
  it("한도 안의 잘못된 키 요청은 401, 한도를 넘으면 429와 Retry-After를 반환한다", async () => {
    const statuses = [];
    let last;
    for (let i = 0; i < LIMIT + 2; i++) {
      last = await fetch(`${base}/sse?accessKey=wrong`);
      statuses.push(last.status);
      await last.text();
    }
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
    assert.equal(last.headers.get("retry-after"), String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)));
  });

  it("limiter를 넘기지 않으면 제한 없이 기존 인증 판정만 수행한다", async () => {
    const bare = http.createServer((req, res) => { handleLegacySseGet(req, res); });
    await new Promise((resolve) => bare.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${bare.address().port}/sse?accessKey=wrong`;
    try {
      for (let i = 0; i < LIMIT + 2; i++) {
        const res = await fetch(url);
        await res.text();
        assert.equal(res.status, 401);
      }
    } finally {
      bare.closeAllConnections();
      await new Promise((resolve) => bare.close(resolve));
    }
  });

  it("server.js의 GET /sse 분기는 rateLimiter를 처리기에 전달한다", () => {
    assert.match(SRC, /handleLegacySseGet\(req, res, rateLimiter\)/);
  });
});
