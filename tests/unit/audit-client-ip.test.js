/**
 * 도구 감사 기록의 클라이언트 주소 시험.
 * 실제 handleMcpPost 경로가 만든 세션 문맥으로 도구를 호출하고, 신뢰 프록시 설정에서
 * 소켓 주소가 아니라 전달된 클라이언트 주소가 감사 줄에 남는지 확인한다.
 * MemoryManager와 ApiKeyStore만 대체한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert                                            from "node:assert/strict";
import http                                              from "node:http";
import fs                                                from "node:fs";
import os                                                from "node:os";
import path                                              from "node:path";

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memento-audit-ip-"));
process.env.LOG_DIR                   = LOG_DIR;
process.env.TRUST_PROXY_HOPS          = "1";
process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const KEY_ID = "7a1e0000-0000-4000-8000-000000000002";

const realManager = await import("../../lib/memory/MemoryManager.js");
mock.module("../../lib/memory/MemoryManager.js", {
  namedExports: { ...realManager, MemoryManager: { getInstance: () => ({ forget: async () => ({ deleted: 0 }) }) } }
});
const realKeys = await import("../../lib/admin/ApiKeyStore.js");
mock.module("../../lib/admin/ApiKeyStore.js", {
  namedExports: {
    ...realKeys,
    getKeyAuthState: async () => ({ exists: true, status: "active", permissions: ["read", "write"] }),
    getGroupKeyIds : async (keyId) => [keyId]
  }
});

const { handleMcpPost }           = await import("../../lib/handlers/mcp-handler.js");
const { createStreamableSession } = await import("../../lib/sessions.js");

const allowAll = { allow: () => true };
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => handleMcpPost(req, res, process.hrtime.bigint(), allowAll));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => setTimeout(r, 100));
  fs.rmSync(LOG_DIR, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  for (const f of fs.readdirSync(LOG_DIR)) fs.rmSync(path.join(LOG_DIR, f));
});

function auditLines() {
  return fs.readdirSync(LOG_DIR)
    .filter((f) => f.startsWith("audit-"))
    .flatMap((f) => fs.readFileSync(path.join(LOG_DIR, f), "utf8").split("\n").filter(Boolean));
}

async function callForget(headers = {}) {
  const sid = await createStreamableSession(true, KEY_ID, [KEY_ID], ["read", "write"], null, null, false);
  const res = await fetch(`${base}/mcp`, {
    method : "POST",
    headers: { "content-type": "application/json", "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18", ...headers },
    body   : JSON.stringify({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params : { name: "forget", arguments: { id: "frag-0000000000000000" } }
    })
  });
  assert.equal(res.status, 200);
  await res.json();
  return { sid, line: auditLines().find((l) => l.includes("| forget |")) };
}

describe("도구 감사 기록의 클라이언트 주소", () => {
  it("신뢰 프록시 설정에서는 전달된 클라이언트 주소를 남긴다", async () => {
    const { sid, line } = await callForget({ "x-forwarded-for": "203.0.113.9" });
    assert.ok(line, "forget 감사 줄이 있어야 한다");
    assert.match(line, /ip=203\.0\.113\.9(;|$)/);
    assert.doesNotMatch(line, /ip=127\.0\.0\.1/);
    assert.doesNotMatch(line, new RegExp(sid));
  });

  it("전달 헤더가 없으면 소켓 주소를 남긴다", async () => {
    const { line } = await callForget();
    assert.match(line, /ip=(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)/);
  });
});
