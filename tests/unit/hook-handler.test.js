/**
 * 훅 HTTP 처리기 동작 시험(stub 의존성)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 처리기를 로컬 HTTP 서버에 올리고 인증, 컨텍스트 조회, outbox 기록을 stub으로 바꿔 상태 코드, 응답 형식,
 * 검사 순서, outbox 이벤트 내용, 지표를 본다. 응답 시간은 stub 기준으로 잰다.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert                                     from "node:assert/strict";
import http                                       from "node:http";

import { createHookHandler }                      from "../../lib/handlers/hook-handler.js";
import { DualRateLimiter }                        from "../../lib/rate-limiter.js";
import { hookCallsTotal }                         from "../../lib/hooks/hook-metrics.js";
import { HOOK_LIMITS, HOOK_REFLECT_TOPIC, hookIdempotencyKey } from "../../lib/hooks/hook-contract.js";
import { OutboxValidationError }                  from "../../lib/outbox/Outbox.js";

const SID    = "0b8f6c4e-1d2a-4c51-9a77-3f1e2d4c5b6a";
const SECRET = `ghp_${"A1b2C3d4E5".repeat(4)}`;

/** 호출 기록이 남는 stub 의존성 */
function makeDeps(overrides = {}) {
  const calls = { authenticate: 0, context: [], enqueue: [], allowedWorkspaces: [] };
  const deps  = {
    enabled              : () => true,
    authenticate         : async () => { calls.authenticate++; return { valid: true, keyId: "key-1", groupKeyIds: ["key-1"], permissions: ["read", "write"], defaultWorkspace: "dflt" }; },
    authUnavailableStatus: () => 401,
    allowedWorkspaces    : async (keyId) => { calls.allowedWorkspaces.push(keyId); return ["Memento-MCP"]; },
    context              : async (args) => { calls.context.push(args); return { success: true, injectionText: "[CORE MEMORY]\n- 기억 줄" }; },
    enqueue              : async (event) => { calls.enqueue.push(event); return { id: "41" }; },
    scanMode             : () => "mask",
    now                  : () => new Date("2026-10-03T00:00:00Z"),
    ...overrides
  };
  return { deps, calls };
}

let server;
let baseUrl;
let current;

/** 요청마다 쓸 처리기와 요청 한도를 바꾼다. */
function use(deps, limiter = new DualRateLimiter({ windowMs: 60_000, perIp: 1000, perKey: 1000 })) {
  current = { handler: createHookHandler(deps), limiter };
}

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    current.handler(req, res, { rateLimiter: current.limiter, pathname: url.pathname }).catch((err) => {
      res.statusCode = 599;
      res.end(String(err));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

/** POST 요청을 보내고 상태, 본문 텍스트, 헤더를 돌려준다. */
async function post(path, body, { headers = {}, raw = null } = {}) {
  const res  = await fetch(`${baseUrl}${path}`, {
    method : "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test", ...headers },
    body   : raw ?? JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null, headers: res.headers };
}

/** memento_hook_calls_total의 한 시계열 값 */
async function callCount(client, event, outcome) {
  const metric = await hookCallsTotal.get();
  return metric.values.find(v => v.labels.client === client && v.labels.event === event && v.labels.outcome === outcome)?.value ?? 0;
}

describe("경로와 스위치", () => {
  it("스위치가 off이면 인증 전에 404다", async () => {
    const { deps, calls } = makeDeps({ enabled: () => false });
    use(deps);
    const r = await post("/hooks/claude-code/SessionStart", {});
    assert.equal(r.status, 404);
    assert.equal(calls.authenticate, 0);
  });

  it("허용 목록 밖의 클라이언트와 이벤트는 404이고 지표 라벨은 other다", async () => {
    const { deps, calls } = makeDeps();
    use(deps);
    const before = await callCount("other", "other", "not_found");
    for (const path of ["/hooks/cursor/Stop", "/hooks/codex/PreToolUse", "/hooks/codex"]) {
      assert.equal((await post(path, {})).status, 404, path);
    }
    assert.equal(calls.authenticate, 0);
    assert.equal(await callCount("other", "other", "not_found") - before, 3);
  });
});

describe("헤더와 본문 상한", () => {
  beforeEach(() => use(makeDeps().deps));

  it("JSON이 아닌 Content-Type은 인증 전에 415다", async () => {
    const { deps, calls } = makeDeps();
    use(deps);
    const r = await post("/hooks/codex/Stop", {}, { headers: { "Content-Type": "text/plain" } });
    assert.equal(r.status, 415);
    assert.equal(calls.authenticate, 0);
  });

  it("헤더 합계가 상한을 넘으면 431이다", async () => {
    const r = await post("/hooks/codex/SessionStart", {}, { headers: { "X-Pad": "a".repeat(HOOK_LIMITS.headerMaxBytes) } });
    assert.equal(r.status, 431);
  });

  it("본문 크기, JSON 문법, 중첩 깊이를 검사한다", async () => {
    const big = await post("/hooks/codex/Stop", null, { raw: JSON.stringify({ pad: "x".repeat(HOOK_LIMITS.bodyMaxBytes) }) });
    assert.equal(big.status, 413);
    assert.equal((await post("/hooks/codex/Stop", null, { raw: "{bad" })).status, 400);
    let deep = {};
    for (let i = 0; i < HOOK_LIMITS.jsonMaxDepth + 1; i++) deep = { a: deep };
    const r = await post("/hooks/codex/SessionStart", deep);
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "json_too_deep");
  });

  it("발췌가 64 KB를 넘으면 413이고 응답은 본문을 되돌려 보내지 않는다", async () => {
    const excerpt = `[assistant]\n${"y".repeat(HOOK_LIMITS.excerptMaxBytes)}`;
    const r = await post("/hooks/codex/Stop", { session_id: SID, excerpt });
    assert.equal(r.status, 413);
    assert.deepEqual(r.json, { error: "excerpt_too_large" });
  });

  it("발췌가 없으면 422다(http 훅 단독 회고는 받지 않는다)", async () => {
    const r = await post("/hooks/claude-code/SessionEnd", { session_id: SID, hook_event_name: "SessionEnd", transcript_path: "/t.jsonl" });
    assert.equal(r.status, 422);
    assert.equal(r.json.error, "excerpt_required");
  });
});

describe("인증, 권한, 요청 한도", () => {
  it("인증 실패는 401이고 인증 저장소 장애는 설정이 503이면 503이다", async () => {
    use(makeDeps({ authenticate: async () => ({ valid: false, error: "Invalid" }) }).deps);
    const r = await post("/hooks/claude-code/SessionStart", {});
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("www-authenticate"), "Bearer");

    use(makeDeps({ authenticate: async () => ({ valid: false, unavailable: true }), authUnavailableStatus: () => 503 }).deps);
    assert.equal((await post("/hooks/claude-code/SessionStart", {})).status, 503);
  });

  it("read 권한만 있는 키는 SessionStart는 되고 Stop은 403이다", async () => {
    const auth = async () => ({ valid: true, keyId: "ro", permissions: ["read"] });
    const { deps, calls } = makeDeps({ authenticate: auth });
    use(deps);
    assert.equal((await post("/hooks/codex/SessionStart", {})).status, 200);
    assert.equal((await post("/hooks/codex/Stop", { session_id: SID, excerpt: "[assistant]\n끝" })).status, 403);
    assert.equal(calls.enqueue.length, 0);
  });

  it("IP 한도는 인증 전에, 키 한도는 인증 뒤에 적용한다", async () => {
    const ip = makeDeps();
    use(ip.deps, new DualRateLimiter({ windowMs: 60_000, perIp: 1, perKey: 100 }));
    assert.equal((await post("/hooks/codex/SessionStart", {})).status, 200);
    const limited = await post("/hooks/codex/SessionStart", {});
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get("retry-after"));
    assert.equal(ip.calls.authenticate, 1);

    const key = makeDeps();
    use(key.deps, new DualRateLimiter({ windowMs: 60_000, perIp: 100, perKey: 1 }));
    assert.equal((await post("/hooks/codex/SessionStart", {})).status, 200);
    assert.equal((await post("/hooks/codex/SessionStart", {})).status, 429);
    assert.equal(key.calls.authenticate, 2);
  });
});

describe("SessionStart", () => {
  it("context를 하네스 형식으로 돌려주고 허가된 workspace 후보와 클라이언트 예산을 넘긴다", async () => {
    const { deps, calls } = makeDeps();
    use(deps);
    const before = await callCount("claude-code", "SessionStart", "context");
    const r = await post("/hooks/claude-code/SessionStart", {
      session_id: SID, hook_event_name: "SessionStart", source: "compact", cwd: "/home/u/memento-mcp", transcript_path: "/x"
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "[CORE MEMORY]\n- 기억 줄" } });
    const args = calls.context[0];
    assert.equal(args.workspace, "Memento-MCP");
    assert.equal(args.tokenBudget, 2000);
    assert.equal(args._keyId, "key-1");
    assert.equal(args._defaultWorkspace, "dflt");
    assert.equal(args._isMaster, false);
    assert.equal(await callCount("claude-code", "SessionStart", "context") - before, 1);
  });

  it("후보가 허가 집합 밖이면 workspace를 넘기지 않아 키 기본 workspace를 쓴다", async () => {
    const { deps, calls } = makeDeps();
    use(deps);
    await post("/hooks/codex/SessionStart", { cwd: "/srv/other" });
    assert.equal("workspace" in calls.context[0], false);
    assert.equal(calls.context[0].tokenBudget, 1500);
  });

  it("마스터 키는 allowed_workspaces를 조회하지 않는다", async () => {
    const { deps, calls } = makeDeps({ authenticate: async () => ({ valid: true, keyId: null, isMaster: true }) });
    use(deps);
    assert.equal((await post("/hooks/codex/SessionStart", { cwd: "/home/u/memento-mcp" })).status, 200);
    assert.equal(calls.allowedWorkspaces.length, 0);
    assert.equal(calls.context[0]._isMaster, true);
  });

  it("context 실패는 500이고 응답에 내부 정보가 없다", async () => {
    use(makeDeps({ context: async () => { throw new Error("db host 10.0.0.5 down"); } }).deps);
    const r = await post("/hooks/codex/SessionStart", {});
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: "server_error" });
  });
});

describe("Stop과 SessionEnd", () => {
  it("발췌를 가려 outbox에 기록하고 100 ms 안에 202로 응답한다", async () => {
    const { deps, calls } = makeDeps();
    use(deps);
    const excerpt = `[user]\n토큰은 ${SECRET} 이다\n\n[assistant]\n배포를 마쳤다`;
    const body    = { session_id: SID, hook_event_name: "Stop", cwd: "/home/u/memento-mcp", git_remote: "https://u:pw@github.com/o/memento-mcp.git", excerpt };

    const started = performance.now();
    const r       = await post("/hooks/claude-code/Stop", body);
    const elapsed = performance.now() - started;

    assert.equal(r.status, 202);
    assert.deepEqual(r.json, { accepted: true });
    assert.ok(elapsed < 100, `202 응답까지 ${elapsed.toFixed(1)} ms`);
    assert.equal(calls.context.length, 0);
    assert.equal(calls.enqueue.length, 1);

    const event = calls.enqueue[0];
    assert.equal(event.topic, HOOK_REFLECT_TOPIC);
    assert.equal(event.aggregateId, hookIdempotencyKey({ keyId: "key-1", client: "claude-code", sessionId: SID, event: "Stop" }));
    assert.equal(event.payload.workspace, "Memento-MCP");
    assert.equal(event.payload.sessionId, SID);
    assert.equal(event.payload.keyId, "key-1");
    assert.ok(!JSON.stringify(event).includes(SECRET), "outbox payload에 비밀 원문이 있다");
    assert.ok(!JSON.stringify(event).includes("pw@"), "outbox payload에 원격 자격 증명이 있다");
    assert.ok(event.payload.sensitiveRules.length > 0);
    assert.ok(event.payload.excerpt.includes("배포를 마쳤다"));
    assert.equal(event.payload.excerptBytes, Buffer.byteLength(event.payload.excerpt, "utf8"));
    assert.ok(!r.text.includes("배포"), "응답이 발췌를 되돌려 보낸다");
  });

  it("MEMENTO_SENSITIVE_SCAN=reject이면 비밀이 든 발췌를 422로 거부하고 기록하지 않는다", async () => {
    const { deps, calls } = makeDeps({ scanMode: () => "reject" });
    use(deps);
    const r = await post("/hooks/codex/SessionEnd", { session_id: SID, excerpt: `[assistant]\n${SECRET}` });
    assert.equal(r.status, 422);
    assert.equal(r.json.error, "sensitive_content");
    assert.ok(!r.text.includes(SECRET));
    assert.equal(calls.enqueue.length, 0);
  });

  it("outbox가 꺼져 기록하지 않으면 503, payload 직렬화 상한 초과는 413이다", async () => {
    use(makeDeps({ enqueue: async () => null }).deps);
    assert.equal((await post("/hooks/codex/Stop", { session_id: SID, excerpt: "[assistant]\n끝냈다" })).status, 503);

    use(makeDeps({ enqueue: async () => { throw new OutboxValidationError("payload", "too big"); } }).deps);
    assert.equal((await post("/hooks/codex/Stop", { session_id: SID, excerpt: "[assistant]\n끝냈다" })).status, 413);
  });

  it("같은 세션과 이벤트의 재전송은 같은 aggregateId를 갖는다", async () => {
    const { deps, calls } = makeDeps();
    use(deps);
    const body = { session_id: SID, excerpt: "[assistant]\n완료" };
    await post("/hooks/codex/SessionEnd", body);
    await post("/hooks/codex/SessionEnd", body);
    await post("/hooks/codex/Stop", body);
    assert.equal(calls.enqueue[0].aggregateId, calls.enqueue[1].aggregateId);
    assert.notEqual(calls.enqueue[0].aggregateId, calls.enqueue[2].aggregateId);
  });
});
