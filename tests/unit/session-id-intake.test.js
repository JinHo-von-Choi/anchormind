/**
 * MCP 세션 ID 수신 경로와 형식 처리 시험.
 * 실제 handleMcpPost, handleMcpGet, handleMcpDelete를 로컬 HTTP 서버에 물려 호출하고,
 * lib 전체와 server.js의 로거 호출이 세션 ID 전체를 싣지 않는지 구문 트리로 검사한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert                                     from "node:assert/strict";
import http                                       from "node:http";
import { readFileSync, readdirSync, statSync }    from "node:fs";
import path                                       from "node:path";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const { handleMcpPost, handleMcpGet, handleMcpDelete }       = await import("../../lib/handlers/mcp-handler.js");
const espree                                                 = await import("espree");
const { ACCESS_KEY }                                         = await import("../../lib/config.js");
const { readSessionId, isServerIssuedSessionId }             = await import("../../lib/session-id.js");
const { sessionRef }                                         = await import("../../lib/logging/session-ref.js");
const ROOT                                                   = path.resolve(import.meta.dirname, "../..");

const allowAll = { allow: () => true };
let server;
let base;

before(async () => {
  assert.ok(ACCESS_KEY, ".env.test에 MEMENTO_ACCESS_KEY가 있어야 한다");
  server = http.createServer((req, res) => {
    if (req.method === "DELETE") return handleMcpDelete(req, res);
    if (req.method === "GET")    return handleMcpGet(req, res);
    return handleMcpPost(req, res, process.hrtime.bigint(), allowAll);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));
afterEach(() => { delete process.env.MEMENTO_SESSION_ID_POLICY; });

const LIST         = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const JSON_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };

async function initialize() {
  const res = await fetch(`${base}/mcp`, {
    method : "POST",
    headers: { ...JSON_HEADERS, authorization: `Bearer ${ACCESS_KEY}` },
    body   : JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })
  });
  assert.equal(res.status, 200);
  return res.headers.get("mcp-session-id");
}

async function postFull(query, headers) {
  return fetch(`${base}/mcp${query}`, { method: "POST", headers: { ...JSON_HEADERS, ...headers }, body: LIST });
}

async function post(query, headers) {
  return (await postFull(query, headers)).status;
}

/** SSE 스트림을 열어 상태와 헤더만 확인하고 곧바로 닫는다. */
async function openSse(query, headers) {
  const ctrl = new AbortController();
  const res  = await fetch(`${base}/mcp${query}`, { method: "GET", headers, signal: ctrl.signal });
  const info = { status: res.status, contentType: res.headers.get("content-type") };
  ctrl.abort();
  return info;
}

async function closeSession(sid) {
  const res = await fetch(`${base}/mcp`, { method: "DELETE", headers: { authorization: `Bearer ${ACCESS_KEY}`, "mcp-session-id": sid } });
  assert.equal(res.status, 200);
}

describe("쿼리스트링 세션 ID", () => {
  it("기본(warn)은 쿼리 세션 ID를 받아 처리한다", async () => {
    const sid = await initialize();
    assert.equal(await post(`?sessionId=${sid}`, {}), 200);
  });

  it("enforce는 400으로 거부한다", async () => {
    const sid = await initialize();
    process.env.MEMENTO_SESSION_ID_POLICY = "enforce";
    assert.equal(await post(`?sessionId=${sid}`, {}), 400);
  });

  it("enforce는 mcp-session-id 쿼리 이름도 거부한다", async () => {
    const sid = await initialize();
    process.env.MEMENTO_SESSION_ID_POLICY = "enforce";
    assert.equal(await post(`?mcp-session-id=${sid}`, {}), 400);
  });

  it("enforce에서도 헤더로 보낸 세션 ID는 그대로 쓴다", async () => {
    const sid = await initialize();
    process.env.MEMENTO_SESSION_ID_POLICY = "enforce";
    assert.equal(await post("", { "mcp-session-id": sid }), 200);
  });

  it("enforce에서 헤더와 쿼리가 함께 오면 헤더를 쓰고 거부하지 않는다", async () => {
    const sid = await initialize();
    process.env.MEMENTO_SESSION_ID_POLICY = "enforce";
    assert.equal(await post(`?sessionId=other`, { "mcp-session-id": sid }), 200);
  });

  it("enforce는 DELETE의 쿼리 세션 ID도 거부한다", async () => {
    const sid = await initialize();
    process.env.MEMENTO_SESSION_ID_POLICY = "enforce";
    const res = await fetch(`${base}/mcp?sessionId=${sid}`, { method: "DELETE", headers: { authorization: `Bearer ${ACCESS_KEY}` } });
    assert.equal(res.status, 400);
  });

  it("기본(warn)은 GET의 쿼리 세션 ID로 SSE 스트림을 연다", async () => {
    const sid  = await initialize();
    const info = await openSse(`?sessionId=${sid}`, {});
    assert.equal(info.status, 200);
    assert.match(info.contentType, /text\/event-stream/);
    await closeSession(sid);
  });

  it("enforce는 GET의 쿼리 세션 ID를 400으로 거부한다", async () => {
    const sid = await initialize();
    process.env.MEMENTO_SESSION_ID_POLICY = "enforce";
    const info = await openSse(`?sessionId=${sid}`, {});
    assert.equal(info.status, 400);
    delete process.env.MEMENTO_SESSION_ID_POLICY;
    await closeSession(sid);
  });

  it("enforce에서도 GET의 헤더 세션 ID로 SSE 스트림을 연다", async () => {
    const sid = await initialize();
    process.env.MEMENTO_SESSION_ID_POLICY = "enforce";
    const info = await openSse("", { "mcp-session-id": sid });
    assert.equal(info.status, 200);
    delete process.env.MEMENTO_SESSION_ID_POLICY;
    await closeSession(sid);
  });

  it("기본(warn)은 DELETE의 쿼리 세션 ID로 세션을 종료한다", async () => {
    const sid = await initialize();
    const res = await fetch(`${base}/mcp?sessionId=${sid}`, { method: "DELETE", headers: { authorization: `Bearer ${ACCESS_KEY}` } });
    assert.equal(res.status, 200);
  });
});

describe("서버가 발급하지 않은 형식의 세션 ID 복구", () => {
  it("기본(warn)은 인증이 유효하면 같은 ID로 복구한다", async () => {
    const res = await postFull("", { "mcp-session-id": "chosen-by-client-0001", authorization: `Bearer ${ACCESS_KEY}` });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("mcp-session-id"), "chosen-by-client-0001");
  });

  it("enforce는 복구하지 않고 404로 응답한다", async () => {
    process.env.MEMENTO_SESSION_ID_POLICY = "enforce";
    assert.equal(await post("", { "mcp-session-id": "chosen-by-client-0002", authorization: `Bearer ${ACCESS_KEY}` }), 404);
  });

  it("enforce에서도 UUID 형식의 미등록 세션은 복구한다", async () => {
    process.env.MEMENTO_SESSION_ID_POLICY = "enforce";
    const stale = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
    assert.equal(await post("", { "mcp-session-id": stale, authorization: `Bearer ${ACCESS_KEY}` }), 200);
  });
});

describe("세션 ID 읽기와 표기", () => {
  it("헤더가 쿼리보다 우선하고 수신 경로를 돌려준다", () => {
    const fromHeader = readSessionId({ headers: { "mcp-session-id": "h" }, url: "/mcp?sessionId=q" });
    const fromQuery  = readSessionId({ headers: {}, url: "/mcp?sessionId=q" });
    const none       = readSessionId({ headers: {}, url: "/mcp" });
    assert.deepEqual(fromHeader, { sessionId: "h", source: "header" });
    assert.deepEqual(fromQuery,  { sessionId: "q", source: "query" });
    assert.deepEqual(none,       { sessionId: null, source: null });
  });

  it("UUID 형식만 서버 발급 형식으로 판정한다", () => {
    assert.equal(isServerIssuedSessionId("3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b"), true);
    assert.equal(isServerIssuedSessionId("chosen-by-client-0001"), false);
    assert.equal(isServerIssuedSessionId(""), false);
  });

  it("표기는 앞 8자만 남긴다", () => {
    assert.equal(sessionRef("3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b"), "3f2a1b4c...");
    assert.equal(sessionRef(null), "none");
  });
});

/**
 * 로거 호출 인자에서 세션 ID 전체가 실리는 지점을 찾는 구문 트리 검사.
 * sessionRef(...)와 앞 8자 절단(slice, substring, substr의 (0, 8))은 안전한 표기로 본다.
 */
const LOGGER_FUNCTIONS = new Set(["logInfo", "logWarn", "logError", "logDebug"]);
const LOGGER_METHODS   = new Set(["info", "warn", "error", "debug", "log"]);
const SESSION_ID_NAME  = /^(sid|[a-z]*Sid|[a-zA-Z]*SessionId|sessionId|session_id)$/;

/**
 * 허용 목록. 항목마다 파일, 소스 조각, 사유가 필요하다. 소스 조각이 더 이상 로거 호출에
 * 나타나지 않으면 시험이 실패해 낡은 항목이 남지 않는다.
 * SSE endpoint 이벤트(sseWrite)는 로거 호출이 아니므로 목록에 없다.
 *
 * @type {Array<{ file: string, snippet: string, reason: string }>}
 */
const RAW_SESSION_ID_ALLOWLIST = [
  {
    file   : "lib/cli/session.js",
    snippet: "",
    reason : "CLI 명령이 운영자 터미널에 보여 주는 출력이며 운영자가 지정하거나 조회한 ID를 그대로 보여 준다"
  }
];

function listJsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) listJsFiles(full, out);
    else if (full.endsWith(".js")) out.push(full);
  }
  return out;
}

function isTruncatedRef(node) {
  if (node.type === "ChainExpression") return isTruncatedRef(node.expression);
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee.type === "Identifier") return callee.name === "sessionRef";
  if (callee.type !== "MemberExpression") return false;
  const [from, to] = node.arguments;
  return ["slice", "substring", "substr"].includes(callee.property.name) && from?.value === 0 && to?.value === 8;
}

function collectRawSessionIds(node, hits) {
  if (!node || typeof node.type !== "string" || isTruncatedRef(node)) return;
  if (node.type === "Property" && !node.computed && node.key.name && SESSION_ID_NAME.test(node.key.name)) {
    if (!isTruncatedRef(node.value)) hits.push(node);
    return;
  }
  if (node.type === "Property" && !node.computed) {
    collectRawSessionIds(node.value, hits);
    return;
  }
  if (node.type === "Identifier" && SESSION_ID_NAME.test(node.name)) hits.push(node);
  if (node.type === "MemberExpression" && !node.computed && SESSION_ID_NAME.test(node.property.name)) hits.push(node);
  if (node.type === "MemberExpression" && node.computed && /session-?id/i.test(String(node.property.value ?? ""))) hits.push(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "range") continue;
    if (Array.isArray(value)) value.forEach((child) => collectRawSessionIds(child, hits));
    else if (value && typeof value.type === "string") collectRawSessionIds(value, hits);
  }
}

/**
 * 로거 호출 판정: logInfo류 함수, console.<메서드>, 그리고 객체 사슬이 logger로 끝나는
 * 호출(logger.info, this.logger.warn, deps.logger.error 등).
 */
function isLoggerCallee(callee) {
  if (callee.type === "Identifier") return LOGGER_FUNCTIONS.has(callee.name);
  if (callee.type !== "MemberExpression") return false;
  const owner = callee.object;
  if (owner.type === "Identifier" && owner.name === "console") return true;
  const ownerName = owner.type === "Identifier" ? owner.name : owner.property?.name;
  return ownerName === "logger" && LOGGER_METHODS.has(callee.property.name);
}

function findLoggerCalls(node, calls) {
  if (!node || typeof node.type !== "string") return;
  if (node.type === "CallExpression") {
    const callee = node.callee;
    if (isLoggerCallee(callee)) calls.push(node);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "range") continue;
    if (Array.isArray(value)) value.forEach((child) => findLoggerCalls(child, calls));
    else if (value && typeof value.type === "string") findLoggerCalls(value, calls);
  }
}

/** 로거 호출 인자에 세션 ID 전체가 실린 지점을 "파일:줄 소스" 문자열로 돌려준다. */
function scanRawSessionIdLogs(source, file) {
  const ast   = espree.parse(source, { ecmaVersion: "latest", sourceType: "module", loc: true });
  const lines = source.split("\n");
  const calls = [];
  findLoggerCalls(ast, calls);
  const found = [];
  for (const call of calls) {
    const hits = [];
    call.arguments.forEach((arg) => collectRawSessionIds(arg, hits));
    for (const hit of hits) found.push({ file, line: hit.loc.start.line, text: lines[hit.loc.start.line - 1].trim() });
  }
  return found;
}

describe("세션 ID 로그 구조", () => {
  const scanned = [...listJsFiles(path.join(ROOT, "lib")), path.join(ROOT, "server.js")];

  it("lib 전체와 server.js의 로거 호출에 세션 ID 전체를 싣지 않는다", () => {
    const offenders = [];
    for (const file of scanned) {
      const rel = path.relative(ROOT, file);
      for (const hit of scanRawSessionIdLogs(readFileSync(file, "utf8"), rel)) {
        const allowed = RAW_SESSION_ID_ALLOWLIST.some((e) => e.file === rel && hit.text.includes(e.snippet));
        if (!allowed) offenders.push(`${hit.file}:${hit.line} ${hit.text}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("검사기가 전체 ID를 싣는 호출과 절단된 호출을 구분한다", () => {
    const raw = [
      "logError('x', err, { sessionId });",
      "logInfo(`ok ${sessionId}`);",
      "logWarn('x', { sid: req.headers['mcp-session-id'] });",
      "logger.info('x', { id: session.sessionId });",
      "console.log(`x ${sessionId}`);",
      "console.error('x', { sessionId });",
      "console.warn('a' + sessionId);",
      "this.logger.info(`${sessionId}`);",
      "deps.logger.error('x', { sid });"
    ];
    for (const src of raw) assert.ok(scanRawSessionIdLogs(src, "t.js").length > 0, src);
    const safe = [
      "logError('x', err, { sessionId: sessionId.substring(0, 8) });",
      "logInfo(`ok ${sessionRef(sessionId)}`);",
      "logInfo(`ok ${sessionId?.slice(0, 8)}...`);",
      "console.log(`x ${sessionRef(sessionId)}`);",
      "this.logger.info(`${sessionRef(sessionId)}`);",
      "const a = sessionId; doSomething(sessionId);"
    ];
    for (const src of safe) assert.equal(scanRawSessionIdLogs(src, "t.js").length, 0, src);
  });

  it("허용 목록의 항목은 사유가 있고 실제 로거 호출에 남아 있다", () => {
    for (const entry of RAW_SESSION_ID_ALLOWLIST) {
      assert.ok(entry.reason && entry.reason.length > 10, `${entry.file}: 사유 필요`);
      const hits = scanRawSessionIdLogs(readFileSync(path.join(ROOT, entry.file), "utf8"), entry.file);
      assert.ok(hits.some((h) => h.text.includes(entry.snippet)), `${entry.file}: 낡은 항목 ${entry.snippet}`);
    }
  });

  it("외부 LLM 프롬프트에 세션 ID 전체를 싣지 않는다", () => {
    const src = readFileSync(path.join(ROOT, "lib/memory/processors/AutoReflect.js"), "utf8");
    assert.doesNotMatch(src, /세션 ID: \$\{sessionId\}/);
  });
});
