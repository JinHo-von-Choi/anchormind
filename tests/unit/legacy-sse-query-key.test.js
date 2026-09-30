/**
 * Legacy SSE 쿼리 인증 처리 방식 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
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

const { handleLegacySseGet, legacySseQueryKeyMode } = await import("../../lib/handlers/sse-handler.js");
const { ACCESS_KEY }                                = await import("../../lib/config.js");
const ROOT                                          = path.resolve(import.meta.dirname, "../..");

let server;
let base;

before(async () => {
  assert.ok(ACCESS_KEY, ".env.test에 MEMENTO_ACCESS_KEY가 있어야 한다");
  server = http.createServer((req, res) => { handleLegacySseGet(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  delete process.env.MEMENTO_SSE_QUERY_KEY;
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
});

/**
 * 모드를 지정해 /sse를 열고 상태와 Content-Type을 확인한 뒤 연결을 끊는다.
 */
async function open(mode, key) {
  if (mode) process.env.MEMENTO_SSE_QUERY_KEY = mode;
  else delete process.env.MEMENTO_SSE_QUERY_KEY;

  const ac  = new AbortController();
  const qs  = key === undefined ? "" : `?accessKey=${encodeURIComponent(key)}`;
  const res = await fetch(`${base}/sse${qs}`, { signal: ac.signal });
  const out = { status: res.status, type: res.headers.get("content-type") || "" };
  if (res.status !== 200) out.body = await res.text();
  ac.abort();
  return out;
}

describe("legacySseQueryKeyMode", () => {
  it("deny일 때만 deny, 나머지는 allow", () => {
    const cases = [[undefined, "allow"], ["deny", "deny"], ["DENY", "allow"], ["off", "allow"]];
    for (const [value, expected] of cases) {
      if (value === undefined) delete process.env.MEMENTO_SSE_QUERY_KEY;
      else process.env.MEMENTO_SSE_QUERY_KEY = value;
      assert.equal(legacySseQueryKeyMode(), expected);
    }
    delete process.env.MEMENTO_SSE_QUERY_KEY;
  });
});

describe("GET /sse 쿼리 키", () => {
  it("기본(allow)은 현행대로 스트림을 연다", async () => {
    const r = await open(null, ACCESS_KEY);
    assert.equal(r.status, 200);
    assert.match(r.type, /^text\/event-stream/);
  });

  it("deny는 쿼리 키를 받지 않고 헤더 사용을 안내한다", async () => {
    const r = await open("deny", ACCESS_KEY);
    assert.equal(r.status, 401);
    assert.match(r.body, /Authorization header/);
  });

  it("키가 없으면 두 모드 모두 401", async () => {
    for (const mode of [null, "deny"]) {
      assert.equal((await open(mode)).status, 401);
    }
  });
});

describe("sse-handler 로그 구조", () => {
  it("로그 호출에 요청 URL이나 쿼리 키 값을 싣지 않는다", () => {
    const src = readFileSync(path.join(ROOT, "lib/handlers/sse-handler.js"), "utf8");
    assert.doesNotMatch(src, /log(?:Info|Warn|Error)\([^;]*(?:req\.url|url\.search\b|rawKey|accessKey\b)/);
  });
});
