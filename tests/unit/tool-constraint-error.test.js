/**
 * 저장소 CHECK 제약 위반 도구 결과의 인자 오류 안내 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 도구가 CHECK 제약 위반으로 실패하면 결과는 isError 그대로 두고, 오류 문구를
 * 파라미터 이름과 허용 값 목록으로 바꾼다. 다른 실패와 성공 결과는 그대로다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert                             from "node:assert/strict";
import pg                                 from "pg";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

let thrown = null;

const fakeManager = {
  remember    : async () => { throw thrown; },
  amend       : async () => { throw thrown; },
  link        : async () => { throw thrown; },
  toolFeedback: async () => { throw thrown; },
  forget      : async () => { throw thrown; }
};

const realManager = await import("../../lib/memory/MemoryManager.js");
mock.module("../../lib/memory/MemoryManager.js", {
  namedExports: { ...realManager, MemoryManager: { getInstance: () => fakeManager } }
});
const realUtils = await import("../../lib/utils.js");
mock.module("../../lib/utils.js", {
  namedExports: { ...realUtils, logAudit: async () => {} }
});

const { handleToolsCall }                         = await import("../../lib/jsonrpc.js");
const { toolErrorMessage, toolErrorResponse }     = await import("../../lib/tools/tool-error.js");

const MASTER = {
  authenticated: true, isMaster: true, keyId: null, groupKeyIds: null, permissions: null,
  defaultWorkspace: null, mode: null, sessionId: null
};

function checkViolation(table, constraint) {
  const e = new pg.DatabaseError(
    `new row for relation "${table}" violates check constraint "${constraint}"`, 0, "error"
  );
  e.code       = "23514";
  e.constraint = constraint;
  return e;
}

async function call(name, args) {
  const r = await handleToolsCall({ name, arguments: args }, MASTER);
  return { isError: r.isError, text: r.content[0].text, payload: JSON.parse(r.content[0].text) };
}

beforeEach(() => { thrown = null; });

describe("toolErrorMessage 제약 위반 안내", () => {
  it("remember type 위반은 허용 값 목록 안내가 된다", () => {
    const msg = toolErrorMessage(checkViolation("fragments", "fragments_type_check"), "remember");
    assert.equal(msg,
      "Invalid arguments for remember: type: must be one of fact|decision|error|preference|procedure|relation|episode");
  });

  it("amend 는 amend 스키마의 enum 을 쓴다", () => {
    const msg = toolErrorMessage(checkViolation("fragments", "fragments_assertion_status_check"), "amend");
    assert.equal(msg, "Invalid arguments for amend: assertionStatus: must be one of observed|inferred|verified|rejected");
  });

  it("목록에 없는 제약 이름은 고정 문구다", () => {
    const msg = toolErrorMessage(checkViolation("fragments", "fragments_importance_check"), "remember");
    assert.equal(msg, "Internal error");
  });

  it("toolErrorResponse 는 제약 위반에만 INVALID_ARGUMENT 코드를 싣는다", () => {
    const bad = toolErrorResponse(checkViolation("fragment_links", "fragment_links_relation_type_check"), "link");
    assert.deepEqual(bad, {
      success: false,
      error  : "Invalid arguments for link: relationType: must be one of related|caused_by|resolved_by|part_of|contradicts",
      code   : "INVALID_ARGUMENT"
    });
    assert.deepEqual(toolErrorResponse(new TypeError("x"), "link"), { success: false, error: "Internal error" });
  });
});

describe("handleToolsCall 제약 위반 응답", () => {
  const cases = [
    ["remember",      { content: "본문", topic: "t", type: "fact" },                  "fragments",      "fragments_type_check",                 /type: must be one of fact\|/],
    ["remember",      { content: "본문", topic: "t", type: "fact" },                  "fragments",      "fragments_resolution_status_check",    /resolutionStatus: must be one of open\|resolved\|abandoned/],
    ["amend",         { id: "frag-0000000000000000", type: "fact" },                 "fragments",      "fragments_type_check",                 /type: must be one of fact\|/],
    ["link",          { fromId: "frag-a", toId: "frag-b", relationType: "related" },  "fragment_links", "fragment_links_relation_type_check",   /relationType: must be one of related\|/],
    ["tool_feedback", { tool_name: "recall", relevant: true, sufficient: true },      "tool_feedback",  "tool_feedback_trigger_type_check",     /trigger_type: must be one of sampled\|voluntary/]
  ];

  for (const [tool, args, table, constraint, expected] of cases) {
    it(`${tool}: ${constraint} 위반은 isError 결과에 허용 값 안내가 실린다`, async () => {
      thrown = checkViolation(table, constraint);
      const { isError, text, payload } = await call(tool, args);
      assert.equal(isError, true);
      assert.equal(payload.success, false);
      assert.equal(payload.code, "INVALID_ARGUMENT");
      assert.match(payload.error, new RegExp(`^Invalid arguments for ${tool}: `));
      assert.match(payload.error, expected);
      assert.doesNotMatch(text, /violates check constraint|_check/);
    });
  }

  it("제약 위반이 아닌 DB 오류는 고정 문구를 유지한다", async () => {
    thrown = Object.assign(new pg.DatabaseError("duplicate key", 0, "error"), { code: "23505", constraint: "uq_frag" });
    const { payload } = await call("remember", { content: "본문", topic: "t", type: "fact" });
    assert.equal(payload.error, "Internal error");
    assert.equal(payload.code, undefined);
  });
});
