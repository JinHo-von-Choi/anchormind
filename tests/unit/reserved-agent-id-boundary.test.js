/**
 * 예약 agentId(system, admin) 입력 경계 시험.
 * 실제 assertAuthenticatedAgentScope와 handleToolsCall을 호출한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, afterEach } from "node:test";
import assert                      from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const { assertAuthenticatedAgentScope, isReservedAgentId } = await import("../../lib/memory/read/AgentScope.js");
const { handleToolsCall }                                  = await import("../../lib/jsonrpc.js");

afterEach(() => { delete process.env.MEMENTO_RESERVED_AGENT_IDS; });

const KEY_SESSION = {
  authenticated: true, isMaster: false, keyId: "7a1e0000-0000-4000-8000-000000000001",
  groupKeyIds: ["7a1e0000-0000-4000-8000-000000000001"], permissions: ["read", "write"],
  defaultWorkspace: null, mode: null, sessionId: null
};

describe("isReservedAgentId", () => {
  it("DB 계층 정제 후 system 또는 admin이 되는 값을 예약어로 본다", () => {
    for (const v of ["system", "admin", "SYSTEM", "sy.stem", "ad min", "sys/tem"]) assert.equal(isReservedAgentId(v), true, v);
    for (const v of ["default", "systems", "agent-system", undefined, 7]) assert.equal(isReservedAgentId(v), false, String(v));
  });
});

describe("assertAuthenticatedAgentScope", () => {
  it("기본(warn)은 예약 agentId를 기록만 하고 통과시킨다", () => {
    assert.equal(assertAuthenticatedAgentScope({ agentId: "sy.stem", _keyId: "k" }).agentId, "sy.stem");
  });

  it("enforce는 API 키의 예약 agentId를 FORBIDDEN으로 거부한다", () => {
    process.env.MEMENTO_RESERVED_AGENT_IDS = "enforce";
    assert.throws(() => assertAuthenticatedAgentScope({ agentId: "admin", _keyId: "k" }), (e) => e.code === "FORBIDDEN");
  });

  it("마스터는 enforce에서도 예약 agentId를 쓴다", () => {
    process.env.MEMENTO_RESERVED_AGENT_IDS = "enforce";
    assert.equal(assertAuthenticatedAgentScope({ agentId: "system", _isMaster: true }).agentId, "system");
  });
});

describe("tools/call 경계", () => {
  it("enforce에서 API 키 세션의 recall(agentId=sy.stem)은 처리기 전에 -32001로 거부된다", async () => {
    process.env.MEMENTO_RESERVED_AGENT_IDS = "enforce";
    await assert.rejects(
      () => handleToolsCall({ name: "recall", arguments: { text: "q", agentId: "sy.stem" } }, KEY_SESSION),
      (e) => e.code === -32001
    );
  });
});
