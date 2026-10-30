/**
 * CLI 원격 MCP 클라이언트 — Streamable HTTP JSON-RPC 2.0
 *
 * 외부 의존성 없음. node:https / node:http 표준 모듈만 사용.
 * 프로토콜 흐름:
 *   1. POST /mcp  initialize 요청  → MCP-Session-Id 헤더 추출
 *   2. POST /mcp  tools/call 요청  → result.content[0].text JSON 파싱 반환
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 */

import { request as httpRequest }  from "node:http";
import { request as httpsRequest } from "node:https";

let _idCounter = 1;

/**
 * 다음 JSON-RPC id 발급.
 * @returns {number}
 */
function nextId() {
  return _idCounter++;
}

/**
 * URL을 파싱하여 { protocol, hostname, port, path } 반환.
 * @param {string} rawUrl
 * @returns {{ protocol: string, hostname: string, port: number, path: string }}
 */
function parseUrl(rawUrl) {
  const u        = new URL(rawUrl);
  const protocol = u.protocol; // "https:" | "http:"
  const hostname = u.hostname;
  const port     = u.port ? parseInt(u.port, 10) : (protocol === "https:" ? 443 : 80);
  const path     = u.pathname + u.search;
  return { protocol, hostname, port, path };
}

/**
 * 단일 HTTP/HTTPS POST 요청 실행.
 *
 * @param {{ protocol: string, hostname: string, port: number, path: string }} parsed
 * @param {object} headers
 * @param {string} body
 * @param {number} timeoutMs
 * @returns {Promise<{ statusCode: number, headers: object, body: string }>}
 */
function doPost(parsed, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const fn = parsed.protocol === "https:" ? httpsRequest : httpRequest;

    const req = fn(
      {
        hostname : parsed.hostname,
        port     : parsed.port,
        path     : parsed.path,
        method   : "POST",
        headers  : {
          ...headers,
          "Content-Type"   : "application/json",
          "Content-Length" : Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end",  () => {
          resolve({
            statusCode : res.statusCode,
            headers    : res.headers,
            body       : Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`MCP request timed out after ${timeoutMs}ms`));
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * McpClient — CLI 원격 MCP 호출을 담당하는 경량 클라이언트.
 *
 * 사용 패턴:
 *   const client = new McpClient(url, apiKey, { timeoutMs: 30000 });
 *   const result = await client.call("recall", { query: "nginx" });
 */
export class McpClient {
  /**
   * @param {string} url        - MCP 서버 엔드포인트 (예: https://memento.anchormind.net/mcp)
   * @param {string} apiKey     - Bearer 토큰
   * @param {{ timeoutMs?: number }} [options]
   */
  constructor(url, apiKey, options = {}) {
    this._parsed    = parseUrl(url);
    this._apiKey    = apiKey;
    this._timeoutMs = options.timeoutMs ?? 30_000;
    this._sessionId = null;
  }

  /**
   * initialize 핸드셰이크를 수행하고 세션 ID를 캐시한다.
   * 이미 세션이 있으면 즉시 반환한다.
   */
  async _ensureSession() {
    if (this._sessionId) return;

    const body = JSON.stringify({
      jsonrpc : "2.0",
      id      : nextId(),
      method  : "initialize",
      params  : {
        protocolVersion : "2025-03-26",
        clientInfo      : { name: "memento-mcp-cli", version: "1.0.0" },
        capabilities    : {},
      },
    });

    const headers = this._buildHeaders(null);
    const resp    = await doPost(this._parsed, headers, body, this._timeoutMs);

    if (resp.statusCode !== 200 && resp.statusCode !== 202) {
      throw new Error(
        `MCP initialize failed (HTTP ${resp.statusCode}): ${resp.body.slice(0, 200)}`
      );
    }

    const sessionId = resp.headers["mcp-session-id"];
    if (!sessionId) {
      throw new Error("MCP server did not return MCP-Session-Id after initialize");
    }

    this._sessionId = sessionId;
  }

  /**
   * 공통 요청 헤더 구성.
   * @param {string|null} sessionId
   * @returns {object}
   */
  _buildHeaders(sessionId) {
    const h = {
      "Authorization"       : `Bearer ${this._apiKey}`,
      "MCP-Protocol-Version": "2025-03-26",
      "Accept"              : "application/json, text/event-stream",
    };
    if (sessionId) {
      h["MCP-Session-Id"] = sessionId;
    }
    return h;
  }

  /**
   * 원격 MCP 도구를 호출하고 파싱된 결과를 반환한다.
   *
   * @param {string} toolName  - MCP 도구 이름 (예: "recall", "remember")
   * @param {object} toolArgs  - 도구 파라미터
   * @returns {Promise<object>} - content[0].text를 JSON 파싱한 결과
   */
  async call(toolName, toolArgs) {
    await this._ensureSession();

    const body = JSON.stringify({
      jsonrpc : "2.0",
      id      : nextId(),
      method  : "tools/call",
      params  : {
        name      : toolName,
        arguments : toolArgs,
      },
    });

    const headers = this._buildHeaders(this._sessionId);
    const resp    = await doPost(this._parsed, headers, body, this._timeoutMs);

    if (resp.statusCode !== 200 && resp.statusCode !== 202) {
      throw new Error(
        `MCP tools/call failed (HTTP ${resp.statusCode}): ${resp.body.slice(0, 200)}`
      );
    }

    let rpc;
    try {
      rpc = JSON.parse(resp.body);
    } catch {
      throw new Error(`MCP response is not valid JSON: ${resp.body.slice(0, 200)}`);
    }

    if (rpc.error) {
      throw new Error(`MCP error (${rpc.error.code}): ${rpc.error.message}`);
    }

    const content = rpc.result?.content;
    if (!Array.isArray(content) || content.length === 0) {
      throw new Error("MCP response missing result.content array");
    }

    const first = content[0];

    /** isError=true 이면 텍스트를 에러 메시지로 throw */
    if (rpc.result?.isError === true || first?.isError === true) {
      throw new Error(`MCP tool error: ${first?.text ?? JSON.stringify(first)}`);
    }

    /** content[0].text 가 없으면 raw 반환 */
    if (first?.text === undefined) {
      return first;
    }

    /** JSON이면 파싱, 아니면 { text } 형태로 감싸서 반환 */
    try {
      return JSON.parse(first.text);
    // iron-laws: ignore[IL-301] 본문이 JSON이 아니면 원문 텍스트를 그대로 돌려준다
    } catch {
      return { text: first.text };
    }
  }
}

/**
 * 편의 함수 — 세션 없는 일회성 호출용.
 *
 * @param {string} url
 * @param {string} key
 * @param {string} toolName
 * @param {object} args
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<object>}
 */
export async function callRemoteTool(url, key, toolName, args, options = {}) {
  const client = new McpClient(url, key, options);
  return client.call(toolName, args);
}
