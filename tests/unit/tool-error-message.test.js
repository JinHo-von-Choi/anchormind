/**
 * 도구 응답 오류 문구 시험.
 * 실제 handleToolsCall과 도구 처리기를 호출하고 MemoryManager와 감사 기록만 대체한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert                             from "node:assert/strict";
import { readFileSync }                   from "node:fs";
import path                               from "node:path";
import pg                                 from "pg";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const ROOT   = path.resolve(import.meta.dirname, "../..");
let   thrown = null;

const fakeManager = {
  remember: async () => { throw thrown; },
  forget  : async () => { throw thrown; }
};

const realManager = await import("../../lib/memory/MemoryManager.js");
mock.module("../../lib/memory/MemoryManager.js", {
  namedExports: { ...realManager, MemoryManager: { getInstance: () => fakeManager } }
});
const realUtils = await import("../../lib/utils.js");
mock.module("../../lib/utils.js", {
  namedExports: { ...realUtils, logAudit: async () => {} }
});

const { handleToolsCall }  = await import("../../lib/jsonrpc.js");
const { toolErrorMessage } = await import("../../lib/tools/tool-error.js");

const MASTER = {
  authenticated: true, isMaster: true, keyId: null, groupKeyIds: null, permissions: null,
  defaultWorkspace: null, mode: null, sessionId: null
};

function pgError() {
  const e = new pg.DatabaseError('duplicate key value violates unique constraint "uq_frag_hash_master"', 0, "error");
  e.code       = "23505";
  e.constraint = "uq_frag_hash_master";
  return e;
}

async function callText(name, args) {
  const r = await handleToolsCall({ name, arguments: args }, MASTER);
  return { isError: r.isError, payload: JSON.parse(r.content[0].text) };
}

beforeEach(() => { thrown = null; });

describe("도구 응답의 오류 문구", () => {
  it("remember에서 난 DB 오류의 원문은 응답에 실리지 않는다", async () => {
    thrown = pgError();
    const { isError, payload } = await callText("remember", { content: "c", topic: "t", type: "fact" });
    assert.equal(isError, true);
    assert.equal(payload.error, "Internal error");
    assert.equal(payload.code, undefined);
    assert.doesNotMatch(JSON.stringify(payload), /uq_frag|violates|duplicate key/);
  });

  it("withAudit 경로(forget)의 실행 오류 원문은 응답에 실리지 않는다", async () => {
    thrown = new TypeError("Cannot read properties of undefined (reading 'rows')");
    const { payload } = await callText("forget", { id: "frag-0000000000000000" });
    assert.equal(payload.error, "Internal error");
  });

  it("처리기가 의도해 던진 업무 오류 문구는 그대로 전달한다", async () => {
    thrown = new Error("content length 5000 exceeds max 4000");
    const { payload } = await callText("remember", { content: "c", topic: "t", type: "fact" });
    assert.equal(payload.error, "content length 5000 exceeds max 4000");
  });
});

describe("toolErrorMessage", () => {
  it("운영체제 호출 오류와 SQLSTATE 코드는 고정 문구로 바꾼다", () => {
    const sys = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { errno: -111, syscall: "connect" });
    assert.equal(toolErrorMessage(sys), "Internal error");
    assert.equal(toolErrorMessage(Object.assign(new Error("relation missing"), { code: "42P01" })), "Internal error");
    assert.equal(toolErrorMessage("not an error"), "Internal error");
  });
});

describe("도구 모듈 구조", () => {
  it("lib/tools 응답 객체에 err.message를 직접 싣지 않는다", () => {
    for (const file of ["lib/tools/memory.js", "lib/tools/reconstruct.js"]) {
      const src = readFileSync(path.join(ROOT, file), "utf8");
      assert.doesNotMatch(src, /(?:return|const resp =) \{ success: false, error: err\.message/, file);
    }
  });
});
