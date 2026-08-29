/**
 * 단위 테스트: lib/cli/_mcpClient.js
 *
 * mock HTTP 서버(node:http)를 임의 포트에 띄워서 McpClient 왕복 검증.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 */

import { describe, it, before, after } from "node:test";
import assert   from "node:assert/strict";
import http     from "node:http";
import { McpClient, callRemoteTool } from "../../lib/cli/_mcpClient.js";

/* ------------------------------------------------------------------ */
/* mock 서버 헬퍼                                                       */
/* ------------------------------------------------------------------ */

/**
 * 단순 JSON-RPC mock 서버.
 * initialize 요청 → 고정 세션 ID 반환.
 * tools/call 요청 → handler(toolName, toolArgs) 위임.
 *
 * @param {(toolName: string, args: object) => object} handler
 * @returns {{ server: http.Server, url: string, close: () => Promise<void> }}
 */
function createMockServer(handler) {
  let _resolve, _reject;
  const ready = new Promise((res, rej) => { _resolve = res; _reject = rej; });

  const FIXED_SESSION_ID = "test-session-abc123";

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", async () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "bad json" }));
        return;
      }

      res.setHeader("Content-Type", "application/json");
      res.setHeader("MCP-Session-Id", FIXED_SESSION_ID);

      if (body.method === "initialize") {
        res.writeHead(200);
        res.end(JSON.stringify({
          jsonrpc : "2.0",
          id      : body.id,
          result  : {
            protocolVersion : "2025-03-26",
            serverInfo      : { name: "mock-server", version: "0.0.1" },
          },
        }));
        return;
      }

      if (body.method === "tools/call") {
        const toolName = body.params?.name;
        const toolArgs = body.params?.arguments ?? {};
        let payload;
        try {
          payload = handler(toolName, toolArgs);
        } catch (err) {
          res.writeHead(200);
          res.end(JSON.stringify({
            jsonrpc : "2.0",
            id      : body.id,
            result  : { isError: true, content: [{ type: "text", text: err.message }] },
          }));
          return;
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          jsonrpc : "2.0",
          id      : body.id,
          result  : {
            content: [{ type: "text", text: JSON.stringify(payload) }],
          },
        }));
        return;
      }

      res.writeHead(400);
      res.end(JSON.stringify({ error: "unknown method" }));
    });
  });

  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    _resolve(`http://127.0.0.1:${port}/mcp`);
  });
  server.on("error", _reject);

  return {
    ready,
    close() {
      return new Promise((res, rej) => server.close(err => (err ? rej(err) : res())));
    },
  };
}

/* ------------------------------------------------------------------ */
/* 테스트                                                               */
/* ------------------------------------------------------------------ */

describe("McpClient", () => {
  describe("URL 파싱", () => {
    it("https URL로 McpClient 인스턴스 생성 성공", () => {
      const client = new McpClient("https://memento.anchormind.net/mcp", "key-abc");
      assert.ok(client instanceof McpClient);
    });

    it("http URL로 McpClient 인스턴스 생성 성공", () => {
      const client = new McpClient("http://localhost:57332/mcp", "key-xyz");
      assert.ok(client instanceof McpClient);
    });

    it("잘못된 URL이면 즉시 오류", () => {
      assert.throws(() => new McpClient("not-a-url", "key"), /Invalid URL/);
    });
  });

  describe("헤더 구성", () => {
    it("_buildHeaders에 Authorization Bearer 포함", () => {
      const client  = new McpClient("https://example.com/mcp", "test-api-key");
      const headers = client._buildHeaders(null);
      assert.strictEqual(headers["Authorization"], "Bearer test-api-key");
    });

    it("_buildHeaders에 MCP-Protocol-Version 포함", () => {
      const client  = new McpClient("https://example.com/mcp", "test-api-key");
      const headers = client._buildHeaders(null);
      assert.ok(headers["MCP-Protocol-Version"]);
    });

    it("sessionId 지정 시 MCP-Session-Id 헤더 포함", () => {
      const client  = new McpClient("https://example.com/mcp", "key");
      const headers = client._buildHeaders("sid-123");
      assert.strictEqual(headers["MCP-Session-Id"], "sid-123");
    });

    it("sessionId null이면 MCP-Session-Id 헤더 없음", () => {
      const client  = new McpClient("https://example.com/mcp", "key");
      const headers = client._buildHeaders(null);
      assert.ok(!("MCP-Session-Id" in headers));
    });
  });

  describe("타임아웃 기본값", () => {
    it("timeoutMs 미지정 시 30000으로 설정", () => {
      const client = new McpClient("https://example.com/mcp", "key");
      assert.strictEqual(client._timeoutMs, 30_000);
    });

    it("timeoutMs 지정 시 해당 값으로 설정", () => {
      const client = new McpClient("https://example.com/mcp", "key", { timeoutMs: 5000 });
      assert.strictEqual(client._timeoutMs, 5000);
    });
  });

  describe("mock 서버 왕복 (HTTP)", () => {
    let url;
    let closeServer;

    before(async () => {
      const mock = createMockServer((toolName, _toolArgs) => {
        if (toolName === "recall") {
          return {
            fragments : [
              { id: "frag-1", content: "nginx port 80", topic: "infra", type: "fact" },
            ],
            count    : 1,
            hasMore  : false,
          };
        }
        if (toolName === "memory_stats") {
          return { total: 42, active: 38 };
        }
        throw new Error(`Unknown tool: ${toolName}`);
      });
      url         = await mock.ready;
      closeServer = mock.close.bind(mock);
    });

    after(() => closeServer());

    it("initialize → tools/call recall 왕복 성공", async () => {
      const client = new McpClient(url, "test-key");
      const result = await client.call("recall", { query: "nginx", limit: 5 });

      assert.ok(Array.isArray(result.fragments), "fragments 배열 있어야 함");
      assert.strictEqual(result.fragments.length, 1);
      assert.strictEqual(result.fragments[0].id, "frag-1");
    });

    it("세션 ID가 첫 호출 후 캐시됨", async () => {
      const client = new McpClient(url, "test-key");
      assert.strictEqual(client._sessionId, null);

      await client.call("recall", { query: "test" });
      assert.strictEqual(client._sessionId, "test-session-abc123");
    });

    it("동일 클라이언트로 두 번째 호출은 initialize 없이 세션 재사용", async () => {
      const client = new McpClient(url, "test-key");
      await client.call("recall", { query: "first" });
      const sid1 = client._sessionId;

      await client.call("memory_stats", {});
      assert.strictEqual(client._sessionId, sid1, "세션 ID 변경 없어야 함");
    });

    it("callRemoteTool 편의 함수 동작", async () => {
      const result = await callRemoteTool(url, "test-key", "memory_stats", {});
      assert.strictEqual(result.total, 42);
    });

    it("도구 오류(isError=true)는 Error로 throw", async () => {
      const client = new McpClient(url, "test-key");
      await assert.rejects(
        () => client.call("nonexistent_tool", {}),
        /Unknown tool/
      );
    });
  });
});
