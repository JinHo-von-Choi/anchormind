/**
 * tools/call 인자 경계 시험.
 * 실제 handleToolsCall을 호출하고 MemoryManager만 대체해 처리기가 받은 인자를 본다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */
import { describe, it, beforeEach, mock } from "node:test";
import assert                             from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";
process.env.MEMENTO_TOOL_ARGS_VALIDATION    = "enforce";
process.env.MEMENTO_TOOL_ARGS_ALLOW_UNKNOWN = "true";

const KEY_ID = "7a1e0000-0000-4000-8000-000000000002";

/** 처리기가 MemoryManager에 넘긴 인자 */
const seen = { forget: [], reflect: [] };

const realManager = await import("../../lib/memory/MemoryManager.js");
mock.module("../../lib/memory/MemoryManager.js", {
  namedExports: {
    ...realManager,
    MemoryManager: {
      getInstance: () => ({
        forget : async (args) => { seen.forget.push(args); return { deleted: 0 }; },
        reflect: async (args) => { seen.reflect.push(args); return { fragments: [], count: 0, breakdown: {} }; }
      })
    }
  }
});

const { handleToolsCall } = await import("../../lib/jsonrpc.js");

function session() {
  return {
    authenticated: true, keyId: KEY_ID, groupKeyIds: [KEY_ID], permissions: ["read", "write"],
    defaultWorkspace: null, mode: null, sessionId: "e9509944-0482-4e7e-9a69-78cfb07b2f5b", isMaster: false
  };
}

function resultOf(response) {
  return JSON.parse(response.content[0].text);
}

describe("tools/call 인자 경계", () => {
  beforeEach(() => {
    seen.forget.length  = 0;
    seen.reflect.length = 0;
  });

  it("스키마에 없는 인자는 처리기에 닿지 않고 ignored_args로 알린다", async () => {
    const response = await handleToolsCall({ name: "forget", arguments: { id: "frag-1", bogusFlag: true } }, session());
    assert.equal(seen.forget.length, 1);
    assert.equal(Object.hasOwn(seen.forget[0], "bogusFlag"), false);
    assert.equal(seen.forget[0].id, "frag-1");
    assert.deepEqual(resultOf(response)._meta.ignored_args, ["bogusFlag"]);
  });

  it("클라이언트가 보낸 _ 접두 인자는 이름과 관계없이 지워지고 서버 값이 들어간다", async () => {
    await handleToolsCall({ name: "forget", arguments: { id: "frag-1", _keyId: "other", _internalSwitch: true } }, session());
    assert.equal(seen.forget[0]._keyId, KEY_ID);
    assert.equal(Object.hasOwn(seen.forget[0], "_internalSwitch"), false);
  });

  it("미리보기를 지원하지 않는 도구는 dryRun 요청을 실행하지 않고 거부한다", async () => {
    const response = await handleToolsCall({ name: "reflect", arguments: { summary: ["사실 하나"], dryRun: true } }, session());
    assert.equal(seen.reflect.length, 0);
    assert.equal(resultOf(response).success, false);
    assert.match(resultOf(response).error, /dryRun/);
  });
});
