/**
 * 읽기 진입점의 workspace 허가 관문 적용 범위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 1. 구조: 읽기 권한 도구는 모두 허가 도구 표(WORKSPACE_READ_TOOLS) 또는 근거가 있는 제외 표에 있고,
 *    workspace나 allWorkspaces 인자를 받는 읽기 도구는 제외될 수 없다. tools/call과 resources/read는
 *    처리기 호출 전에 authorizeWorkspaceRead를 부르며, 도구 처리기와 리소스 판독을 부르는 곳은 그 둘뿐이다.
 * 2. 동작(처리기와 allowed_workspaces 조회는 대역): enforce에서 범위 밖 요청은 처리기에 닿지 않고 -32001로
 *    끝난다. warn과 off는 처리기를 그대로 부르고, 범위가 없는 키는 enforce에서도 그대로 부른다.
 */

import { describe, it, before, beforeEach, mock } from "node:test";
import assert                                     from "node:assert/strict";
import { readFileSync, readdirSync }              from "node:fs";
import path                                       from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

function listJs(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(full));
    else if (e.name.endsWith(".js")) out.push(full);
  }
  return out;
}

process.env.MEMENTO_TOOL_ARGS_VALIDATION = "off";

/** 키별 allowed_workspaces 대역 */
const ALLOWED = { "key-limited": ["ws-a"], "key-open": null };

const realKeys = await import("../../lib/admin/ApiKeyStore.js");
mock.module("../../lib/admin/ApiKeyStore.js", {
  namedExports: { ...realKeys, getAllowedWorkspaces: async (keyId) => ALLOWED[keyId] ?? null }
});

/** 도구 처리기 대역: 호출된 도구 이름을 남기고 빈 성공을 돌려준다 */
const handlerCalls = [];
const realTools    = await import("../../lib/tools/index.js");
const stubbedTools = {};
for (const [name, value] of Object.entries(realTools)) {
  stubbedTools[name] = name.startsWith("tool_") && typeof value === "function"
    ? async () => { handlerCalls.push(name); return { success: true, fragments: [] }; }
    : value;
}
mock.module("../../lib/tools/index.js", { namedExports: stubbedTools });

const resourceCalls = [];
const realResources = await import("../../lib/tools/resources.js");
mock.module("../../lib/tools/resources.js", {
  namedExports: {
    ...realResources,
    readResource: async (uri) => { resourceCalls.push(uri); return { contents: [] }; }
  }
});

const { handleToolsCall, handleResourcesRead } = await import("../../lib/jsonrpc.js");
const { TOOL_PERMISSIONS }                     = await import("../../lib/rbac.js");
const { TOOL_REGISTRY }                        = await import("../../lib/tool-registry.js");
const { getToolsDefinition }                   = realTools;
const {
  WORKSPACE_READ_TOOLS, WORKSPACE_READ_EXEMPT, WorkspaceReadDeniedError
} = await import("../../lib/memory/read/workspace-read-policy.js");

function session(keyId) {
  return {
    authenticated: true, keyId, groupKeyIds: [keyId], permissions: ["read", "write"],
    defaultWorkspace: null, mode: null, sessionId: "sess-coverage", isMaster: false
  };
}

/** 도구별 최소 인자. memory_stats는 workspace 인자가 없고 대상이 전체 workspace다. */
function argsFor(tool, workspace) {
  const base = tool === "memory_stats" ? {} : { workspace };
  if (tool === "graph_explore")       return { ...base, startId: "frag-1" };
  if (tool === "fragment_history")    return { ...base, id: "frag-1" };
  if (tool === "reconstruct_history") return { ...base, caseId: "case-1" };
  if (tool === "recall")              return { ...base, keywords: ["k"] };
  return base;
}

/** API 키가 부를 수 있는 허가 도구. master 전용 도구(memory_stats)는 RBAC가 먼저 거부한다. */
const KEY_GATED_TOOLS = Object.keys(WORKSPACE_READ_TOOLS)
  .filter(name => TOOL_REGISTRY.get(name)?.meta?.requiresMaster !== true);

const READ_TOOL_NAMES = getToolsDefinition(null, true)
  .map(d => d.name)
  .filter(name => TOOL_PERMISSIONS[name] === "read");

describe("구조: 읽기 도구 분류", () => {
  it("읽기 권한 도구는 모두 허가 도구 표나 제외 표 한쪽에만 있다", () => {
    for (const name of READ_TOOL_NAMES) {
      const gated  = Object.hasOwn(WORKSPACE_READ_TOOLS, name);
      const exempt = Object.hasOwn(WORKSPACE_READ_EXEMPT, name);
      assert.ok(gated !== exempt, `${name}: 허가 표=${gated}, 제외 표=${exempt}`);
    }
  });

  it("workspace 인자를 받는 읽기 도구는 허가 도구 표에 있다", () => {
    const withWorkspace = getToolsDefinition(null, true).filter(d =>
      TOOL_PERMISSIONS[d.name] === "read" &&
      ["workspace", "allWorkspaces"].some(p => Object.hasOwn(d.inputSchema?.properties ?? {}, p)));
    assert.ok(withWorkspace.length >= 6);
    for (const d of withWorkspace) {
      assert.ok(Object.hasOwn(WORKSPACE_READ_TOOLS, d.name), `${d.name}이 허가 관문을 거치지 않는다`);
    }
  });

  it("API 키가 부를 수 있는 허가 도구는 요청 workspace 대상이다", () => {
    assert.ok(KEY_GATED_TOOLS.length >= 6);
    for (const name of KEY_GATED_TOOLS) assert.equal(WORKSPACE_READ_TOOLS[name], "request", name);
  });

  it("허가 도구 표와 제외 표에는 등록된 읽기 도구만 있다", () => {
    for (const name of [...Object.keys(WORKSPACE_READ_TOOLS), ...Object.keys(WORKSPACE_READ_EXEMPT)]) {
      assert.ok(READ_TOOL_NAMES.includes(name), `${name}은 등록된 읽기 도구가 아니다`);
    }
  });
});

describe("구조: 관문 호출 위치", () => {
  const src = read("lib/jsonrpc.js");

  /** 함수 선언부터 다음 최상위 export 직전까지 */
  function bodyOf(fn) {
    const start = src.indexOf(`export async function ${fn}(`);
    assert.ok(start >= 0, `${fn} 정의가 없다`);
    const next = src.indexOf("\nexport ", start + 1);
    return src.slice(start, next < 0 ? undefined : next);
  }

  it("tools/call은 처리기 호출 전에 관문을 부른다", () => {
    const body = bodyOf("handleToolsCall");
    const gate = body.indexOf("await authorizeWorkspaceRead(name, args)");
    const call = body.indexOf("entry.handler(args)");
    assert.ok(gate >= 0 && call > gate);
  });

  it("resources/read는 리소스 판독 전에 관문을 부른다", () => {
    const body = bodyOf("handleResourcesRead");
    const gate = body.indexOf("await authorizeWorkspaceRead(RESOURCE_READ_SURFACE, trustedParams)");
    const call = body.indexOf("readResourceContent(");
    assert.ok(gate >= 0 && call > gate);
  });

  it("도구 처리기와 리소스 판독을 부르는 운영 코드는 jsonrpc.js 한 곳이다", () => {
    const offenders = listJs(path.join(ROOT, "lib"))
      .map(f => [path.relative(ROOT, f).split(path.sep).join("/"), readFileSync(f, "utf8")])
      .filter(([rel]) => rel !== "lib/jsonrpc.js" && rel !== "lib/tools/resources.js")
      .filter(([, text]) =>
        (/from\s+["'][./]*tool-registry\.js["']/.test(text) && /\.handler\(/.test(text)) ||
        /import\s*\{[^}]*\breadResource\b[^}]*\}\s*from\s+["'][./]*(tools\/)?resources\.js["']/.test(text))
      .map(([rel]) => rel);
    assert.deepEqual(offenders, []);
  });

  it("클라이언트가 보낸 허가 범위 인자는 신뢰 문맥 주입 전에 지워진다", () => {
    const start = src.indexOf("export function applyTrustedToolContext(");
    const body  = src.slice(start, src.indexOf("\n}\n", start));
    assert.match(body, /"_workspaceReadRange"\s*\n?\s*\]\) delete args\[key\]/);
  });
});

describe("동작: tools/call과 resources/read", () => {
  let base;
  before(async () => {
    const { workspaceReadAuthzTotal } = await import("../../lib/memory/read/read-authz-metrics.js");
    base = async (surface, outcome) => {
      const { values } = await workspaceReadAuthzTotal.get();
      return values.filter(v => v.labels.surface === surface && v.labels.outcome === outcome)
        .reduce((n, v) => n + v.value, 0);
    };
  });
  beforeEach(() => { handlerCalls.length = 0; resourceCalls.length = 0; });

  it("enforce: 범위 밖 요청은 처리기에 닿지 않고 -32001로 끝난다", async () => {
    process.env.MEMENTO_WORKSPACE_READ_AUTHZ = "enforce";
    for (const tool of KEY_GATED_TOOLS) {
      await assert.rejects(
        handleToolsCall({ name: tool, arguments: argsFor(tool, "ws-b") }, session("key-limited")),
        (err) => err instanceof WorkspaceReadDeniedError && err.code === -32001,
        tool
      );
    }
    await assert.rejects(
      handleResourcesRead({ uri: "memory://topics", workspace: "ws-b" }, session("key-limited")),
      (err) => err instanceof WorkspaceReadDeniedError
    );
    assert.deepEqual(handlerCalls, []);
    assert.deepEqual(resourceCalls, []);
  });

  it("enforce: 범위 안 요청과 범위가 없는 키는 처리기를 부른다", async () => {
    process.env.MEMENTO_WORKSPACE_READ_AUTHZ = "enforce";
    await handleToolsCall({ name: "recall", arguments: argsFor("recall", "ws-a") }, session("key-limited"));
    for (const tool of KEY_GATED_TOOLS) {
      await handleToolsCall({ name: tool, arguments: argsFor(tool, "ws-b") }, session("key-open"));
    }
    await handleResourcesRead({ uri: "memory://topics", workspace: "ws-b" }, session("key-open"));
    assert.equal(handlerCalls.length, 1 + KEY_GATED_TOOLS.length);
    assert.deepEqual(resourceCalls, ["memory://topics"]);
  });

  it("warn: 범위 밖 요청도 처리기를 부르고 would_deny를 센다", async () => {
    process.env.MEMENTO_WORKSPACE_READ_AUTHZ = "warn";
    const before = await base("recall", "would_deny");
    for (const tool of KEY_GATED_TOOLS) {
      await handleToolsCall({ name: tool, arguments: argsFor(tool, "ws-b") }, session("key-limited"));
    }
    await handleResourcesRead({ uri: "memory://stats", workspace: "ws-b" }, session("key-limited"));
    assert.equal(handlerCalls.length, KEY_GATED_TOOLS.length);
    assert.deepEqual(resourceCalls, ["memory://stats"]);
    assert.equal(await base("recall", "would_deny"), before + 1);
  });

  it("off: 범위 밖 요청도 처리기를 부르고 세지 않는다", async () => {
    process.env.MEMENTO_WORKSPACE_READ_AUTHZ = "off";
    const before = await base("recall", "would_deny");
    for (const tool of KEY_GATED_TOOLS) {
      await handleToolsCall({ name: tool, arguments: argsFor(tool, "ws-b") }, session("key-limited"));
    }
    assert.equal(handlerCalls.length, KEY_GATED_TOOLS.length);
    assert.equal(await base("recall", "would_deny"), before);
  });
});
