#!/usr/bin/env node
/**
 * 프로토콜 개정 폴백 관찰 스크립트
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 이 저장소의 handleMcpPost를 같은 프로세스의 임시 HTTP 서버(127.0.0.1, 기본 포트 18913)에
 * 물리고, MCP 2026-07-28 방식을 먼저 시도하는 클라이언트의 순서를 그대로 보낸다.
 *
 *   1. 세션 없이 현대식 tools/list와 server/discover를 보낸다(MCP-Protocol-Version, Mcp-Method
 *      헤더와 params._meta 버전).
 *   2. 응답 본문을 개정 규격의 판정 규칙으로 읽는다. 400 본문의 오류 코드가 -32020, -32021,
 *      -32022이면 현대식 서버, 그 밖이면 레거시 서버로 보고 initialize로 돌아간다.
 *   3. 레거시로 판정되면 initialize 후 세션 ID로 tools/list를 보낸다.
 *   4. memento_modern_protocol_attempts_total 값을 함께 낸다.
 *
 * 결과는 JSON 한 개로 표준 출력에 낸다. 기대값과 대조하지 않는다. 운영 포트와 외부 주소에는
 * 접속하지 않는다. Redis는 꺼야 한다.
 *
 * lib/config.js는 불러올 때 DOTENV_CONFIG_PATH(없으면 .env)의 설정 파일을 읽는다. 이 스크립트는
 * DOTENV_CONFIG_PATH가 없는 파일이거나 임시 디렉터리(os.tmpdir()) 아래의 파일일 때만 실행하고,
 * 그 밖이면 설정을 읽기 전에 종료 코드 2로 멈춘다. 임시 서버의 마스터 키는 실행마다 새로 만든
 * 무작위 값이다(MEMENTO_ACCESS_KEY를 이 프로세스 안에서만 덮어쓴다).
 *
 * 사용:
 *   DOTENV_CONFIG_PATH=/nonexistent/.env MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
 *     node scripts/measure/protocol-era-probe.mjs [--port 18913]
 */

import crypto         from "node:crypto";
import { existsSync } from "node:fs";
import http           from "node:http";
import os             from "node:os";
import path           from "node:path";

import { parseArgs }                                           from "../../lib/cli/parseArgs.js";
import { DEFAULT_PROTOCOL_VERSION, PROTOCOL_VERSION_META_KEY } from "../../lib/protocol-versions.js";

const DEFAULT_PORT     = 18913;
const FORBIDDEN_PORTS  = new Set([57332]);
const MODERN_VERSION   = "2026-07-28";
const MODERN_ERRORS    = new Set([-32020, -32021, -32022]);
const SCHEMA           = "protocol-era-probe/v1";

/** 실행 조건 오류 */
class ProbeConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProbeConfigError";
  }
}

/**
 * DOTENV_CONFIG_PATH 값을 검증한다. 없는 파일이거나 임시 디렉터리 아래면 통과한다.
 *
 * @param {string|undefined} value
 * @param {{ exists?: (p: string) => boolean, tmpRoot?: string }} [opts]
 * @returns {string} 절대 경로
 */
export function checkDotenvPath(value, { exists = existsSync, tmpRoot = os.tmpdir() } = {}) {
  if (!value) throw new ProbeConfigError("DOTENV_CONFIG_PATH must be set to a nonexistent file or a file under the temp directory");
  const abs     = path.resolve(value);
  const rel     = path.relative(path.resolve(tmpRoot), abs);
  const inTemp  = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  if (inTemp || !exists(abs)) return abs;
  throw new ProbeConfigError(`DOTENV_CONFIG_PATH points to an existing settings file outside the temp directory: ${value}`);
}

/**
 * 설정 경로를 확인한 뒤 서버 모듈을 불러온다. 마스터 키는 무작위 값으로 둔다.
 */
async function loadRuntime(env) {
  checkDotenvPath(env.DOTENV_CONFIG_PATH);
  env.MEMENTO_ACCESS_KEY = crypto.randomBytes(24).toString("hex");
  const { ACCESS_KEY, REDIS_ENABLED }   = await import("../../lib/config.js");
  if (REDIS_ENABLED) throw new ProbeConfigError("REDIS_ENABLED must be false for the probe");
  const { handleMcpPost }               = await import("../../lib/handlers/mcp-handler.js");
  const { modernProtocolAttemptsTotal } = await import("../../lib/metrics.js");
  return { ACCESS_KEY, handleMcpPost, modernProtocolAttemptsTotal };
}

/**
 * 포트 인자를 검증한다.
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function resolvePort(raw) {
  const port = raw === undefined ? DEFAULT_PORT : Number(raw);
  if (!Number.isInteger(port) || port < 10000 || port > 65535) throw new ProbeConfigError(`port must be an integer in 10000..65535: ${raw}`);
  if (FORBIDDEN_PORTS.has(port)) throw new ProbeConfigError(`port ${port} is reserved for the running service`);
  return port;
}

/**
 * 개정 규격의 HTTP 하위 호환 규칙으로 응답을 판정한다.
 * 4xx 본문이 개정 정의 오류(-32020, -32021, -32022)이거나 404와 -32601(미구현 메서드)이면
 * modern, 그 밖의 4xx면 legacy, 2xx면 modern이다.
 *
 * @param {{ status: number, body: any }} res
 * @returns {"modern"|"legacy"}
 */
export function classifyEra(res) {
  if (res.status >= 200 && res.status < 300) return "modern";
  const code = res.body?.error?.code;
  if (res.status === 404 && code === -32601) return "modern";
  return MODERN_ERRORS.has(code) ? "modern" : "legacy";
}

function modernRequest(method, id) {
  return {
    headers: { "mcp-protocol-version": MODERN_VERSION, "mcp-method": method },
    body   : {
      jsonrpc: "2.0", id, method,
      params : { _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN_VERSION, "io.modelcontextprotocol/clientCapabilities": {} } }
    }
  };
}

async function send(base, { headers, body }) {
  const res  = await fetch(`${base}/mcp`, {
    method : "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body   : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    parsed = { unparsed: text.slice(0, 200), parseError: err.message };
  }
  return { status: res.status, sessionId: res.headers.get("mcp-session-id"), body: parsed };
}

/** 응답 요약. 세션 ID는 존재 여부만 낸다. */
function summarize(res) {
  return {
    status       : res.status,
    hasSessionId : Boolean(res.sessionId),
    error        : res.body?.error ?? null,
    resultKeys   : res.body?.result ? Object.keys(res.body.result).sort() : null,
    era          : classifyEra(res)
  };
}

async function legacyFallback(base, accessKey) {
  const auth = { authorization: `Bearer ${accessKey}` };
  const init = await send(base, {
    headers: auth,
    body   : { jsonrpc: "2.0", id: 10, method: "initialize",
      params: { protocolVersion: DEFAULT_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "protocol-era-probe", version: "1" } } }
  });
  const list = init.sessionId
    ? await send(base, { headers: { ...auth, "mcp-session-id": init.sessionId, "mcp-protocol-version": DEFAULT_PROTOCOL_VERSION },
      body: { jsonrpc: "2.0", id: 11, method: "tools/list", params: {} } })
    : null;
  return {
    initialize: { status: init.status, hasSessionId: Boolean(init.sessionId), protocolVersion: init.body?.result?.protocolVersion ?? null },
    toolsList : list ? { status: list.status, toolCount: list.body?.result?.tools?.length ?? null } : null
  };
}

async function attemptCounts(counter) {
  const snap = await counter.get();
  return Object.fromEntries(snap.values.map(v => [v.labels.signal, v.value]));
}

async function probe(port, rt) {
  const server = http.createServer((req, res) => rt.handleMcpPost(req, res, process.hrtime.bigint(), { allow: () => true }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    const toolsList = summarize(await send(base, modernRequest("tools/list", 1)));
    const discover  = summarize(await send(base, modernRequest("server/discover", 2)));
    const fallback  = toolsList.era === "legacy" ? await legacyFallback(base, rt.ACCESS_KEY) : null;
    return { schema: SCHEMA, target: base, modernVersion: MODERN_VERSION, modern: { toolsList, discover }, fallback, attempts: await attemptCounts(rt.modernProtocolAttemptsTotal) };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function main(argv) {
  const args   = parseArgs(argv);
  const port   = resolvePort(args.port);
  const rt     = await loadRuntime(process.env);
  const report = await probe(port, rt);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (err) => {
      process.stderr.write(`${err.name}: ${err.message}\n`);
      process.exit(err instanceof ProbeConfigError ? 2 : 1);
    }
  );
}
