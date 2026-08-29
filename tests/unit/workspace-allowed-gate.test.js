/**
 * workspace 허가 집합(allowed_workspaces) 검증 + fragmentHasWorkspace 게이트 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-08-15
 *
 * 3개 관심사:
 * 1. ApiKeyStore.getAllowedWorkspaces / checkWorkspaceAllowed 순수 로직
 * 2. MemoryRememberer._runPolicyGate — workspaceNotAllowed는 hard gate 대상에서 항상 제외
 * 3. MemoryRememberer._runPolicyGate — fragmentHasWorkspace는 MEMENTO_WORKSPACE_GATE=true일 때만 hard gate 대상
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert                              from "node:assert/strict";

const mockQuery = mock.fn();
const mockPool  = { query: mockQuery };

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool     : () => mockPool,
    getBatchPool       : () => mockPool,
    queryWithAgentVector: async () => ({ rows: [] }),
    withTransaction     : async (pool, fn) => fn(mockPool),
    getPoolStats        : () => ({})
  }
});
mock.module("../../lib/logger.js", {
  namedExports: { logWarn: mock.fn(), logError: mock.fn() }
});

const {
  getAllowedWorkspaces,
  checkWorkspaceAllowed,
  WORKSPACE_LOOKUP_FAILED,
  invalidateAllowedWorkspacesCache
} = await import("../../lib/admin/ApiKeyStore.js");

describe("ApiKeyStore.getAllowedWorkspaces", () => {

  beforeEach(() => {
    mockQuery.mock.resetCalls();
  });

  it("keyId=null → DB 조회 없이 null 반환 (제한 없음)", async () => {
    const result = await getAllowedWorkspaces(null);
    assert.strictEqual(result, null);
    assert.strictEqual(mockQuery.mock.callCount(), 0);
  });

  it("allowed_workspaces가 NULL인 키 → null 반환", async () => {
    invalidateAllowedWorkspacesCache("key-null-allow");
    mockQuery.mock.mockImplementationOnce(() => Promise.resolve({ rows: [{ allowed_workspaces: null }] }));

    const result = await getAllowedWorkspaces("key-null-allow");
    assert.strictEqual(result, null);
  });

  it("allowed_workspaces 배열이 있는 키 → 배열 반환", async () => {
    invalidateAllowedWorkspacesCache("key-with-allow");
    mockQuery.mock.mockImplementationOnce(() => Promise.resolve({ rows: [{ allowed_workspaces: ["memento-mcp", "docs-mcp"] }] }));

    const result = await getAllowedWorkspaces("key-with-allow");
    assert.deepStrictEqual(result, ["memento-mcp", "docs-mcp"]);
  });

  it("DB 오류는 무제한 허용과 구분되는 표식을 반환한다", async () => {
    /**
     * null은 "허용 집합 미지정", 즉 제한 없음이라는 확정 판정이다. 조회 실패를
     * 같은 값으로 돌려주면 DB가 흔들릴 때마다 격리가 조용히 풀린다.
     */
    invalidateAllowedWorkspacesCache("key-db-error");
    mockQuery.mock.mockImplementationOnce(() => Promise.reject(new Error("connection lost")));

    const result = await getAllowedWorkspaces("key-db-error");
    assert.strictEqual(result, WORKSPACE_LOOKUP_FAILED);
    assert.notStrictEqual(result, null);
  });

  it("조회 실패 상태에서 workspace 주장은 위반으로 판정된다", async () => {
    invalidateAllowedWorkspacesCache("key-db-error-2");
    mockQuery.mock.mockImplementationOnce(() => Promise.reject(new Error("connection lost")));

    const v = await checkWorkspaceAllowed("key-db-error-2", "some-workspace");
    assert.ok(v, "위반이 반환되지 않았다");
    assert.strictEqual(v.rule, "workspaceLookupFailed");
    assert.strictEqual(v.severity, "high");
  });

  it("workspace 미기입은 조회 실패와 무관하게 통과한다", async () => {
    invalidateAllowedWorkspacesCache("key-db-error-3");
    mockQuery.mock.mockImplementationOnce(() => Promise.reject(new Error("connection lost")));

    assert.strictEqual(await checkWorkspaceAllowed("key-db-error-3", null), null);
  });

});

describe("ApiKeyStore.checkWorkspaceAllowed", () => {

  beforeEach(() => {
    mockQuery.mock.resetCalls();
  });

  it("workspace 미기입 → 통과(null), DB 조회 없음", async () => {
    const result = await checkWorkspaceAllowed("key-x", null);
    assert.strictEqual(result, null);
    assert.strictEqual(mockQuery.mock.callCount(), 0);
  });

  it("allowed_workspaces NULL(무제한) → 통과", async () => {
    invalidateAllowedWorkspacesCache("key-unlimited");
    mockQuery.mock.mockImplementationOnce(() => Promise.resolve({ rows: [{ allowed_workspaces: null }] }));

    const result = await checkWorkspaceAllowed("key-unlimited", "any-project");
    assert.strictEqual(result, null);
  });

  it("workspace가 허가 집합 내부 → 통과", async () => {
    invalidateAllowedWorkspacesCache("key-scoped");
    mockQuery.mock.mockImplementationOnce(() => Promise.resolve({ rows: [{ allowed_workspaces: ["memento-mcp"] }] }));

    const result = await checkWorkspaceAllowed("key-scoped", "memento-mcp");
    assert.strictEqual(result, null);
  });

  it("workspace가 허가 집합 밖 → workspaceNotAllowed 경고 반환(저장 거부 아님)", async () => {
    invalidateAllowedWorkspacesCache("key-scoped-2");
    mockQuery.mock.mockImplementationOnce(() => Promise.resolve({ rows: [{ allowed_workspaces: ["memento-mcp"] }] }));

    const result = await checkWorkspaceAllowed("key-scoped-2", "other-project");
    assert.ok(result, "위반 객체가 반환되어야 한다");
    assert.strictEqual(result.rule, "workspaceNotAllowed");
    assert.strictEqual(result.severity, "medium");
    assert.strictEqual(typeof result.ruleVersion, "string");
  });

  it("allowed_workspaces 빈 배열 → 어떤 workspace 주장도 허가 집합 밖으로 판정", async () => {
    invalidateAllowedWorkspacesCache("key-empty-allow");
    mockQuery.mock.mockImplementationOnce(() => Promise.resolve({ rows: [{ allowed_workspaces: [] }] }));

    const result = await checkWorkspaceAllowed("key-empty-allow", "any-project");
    assert.ok(result, "빈 배열은 workspace 주장을 전면 차단해야 한다");
    assert.strictEqual(result.rule, "workspaceNotAllowed");
  });

});

describe("MemoryRememberer._runPolicyGate — workspace 게이트 배선", () => {

  function makeRememberer(policyRules, getHardGate) {
    const store = {
      insert                          : async () => "frag-id",
      findCaseIdBySessionTopic        : async () => null,
      findErrorFragmentsBySessionTopic: async () => [],
      links                            : { createLink: async () => {} }
    };
    const factory = {
      create(params) {
        return {
          id                  : undefined,
          type                : params.type ?? "fact",
          content             : params.content ?? "",
          topic               : params.topic ?? "test",
          keywords            : params.keywords ?? [],
          validation_warnings : [],
          key_id              : params._keyId ?? null,
          agent_id            : "default",
          workspace           : params.workspace ?? null,
          linked_to           : params.linkedTo ?? []
        };
      }
    };

    return { rememberer: null, store, factory, getHardGate, policyRules };
  }

  async function buildRememberer({ policyRules, getHardGate, _workspace }) {
    const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");
    const { store, factory }   = makeRememberer(policyRules, getHardGate);

    const rememberer = new MemoryRememberer({
      store,
      index                 : { index: async () => {}, addToWorkingMemory: async () => {} },
      factory,
      quotaChecker          : { check: async () => {}, getUsage: async () => ({ limit: null, current: 0, remaining: null, resetAt: null }) },
      postProcessor         : { run: async () => {} },
      conflictResolver      : { detectConflicts: async () => [], autoLinkOnRemember: async () => {} },
      caseEventStore        : { getByCase: async () => [] },
      policyRules,
      getHardGate,
      policyGatingEnabled   : true
    });
    return rememberer;
  }

  beforeEach(() => {
    mockQuery.mock.resetCalls();
    delete process.env.MEMENTO_WORKSPACE_GATE;
  });

  it("workspaceNotAllowed 위반은 hard gate=true여도 저장을 차단하지 않는다", async () => {
    invalidateAllowedWorkspacesCache("key-gate-1");
    mockQuery.mock.mockImplementationOnce(() => Promise.resolve({ rows: [{ allowed_workspaces: ["memento-mcp"] }] }));

    const policyRules = { check: () => [] };
    const rememberer  = await buildRememberer({ policyRules, getHardGate: async () => true });

    const result = await rememberer.remember({
      content: "다른 프로젝트 파편", type: "fact", topic: "t",
      workspace: "other-project", _keyId: "key-gate-1"
    });

    assert.ok(result.id, "workspaceNotAllowed는 저장을 차단해선 안 된다");
    assert.ok(
      result.validation_warnings?.includes("workspaceNotAllowed"),
      "validation_warnings에 workspaceNotAllowed가 노출되어야 한다"
    );
  });

  it("fragmentHasWorkspace 위반은 MEMENTO_WORKSPACE_GATE 미설정 시 hard gate에서 제외된다", async () => {
    const policyRules = {
      check: () => [{ rule: "fragmentHasWorkspace", severity: "low", detail: "no workspace", ruleVersion: "v1" }]
    };
    const rememberer = await buildRememberer({ policyRules, getHardGate: async () => true });

    const result = await rememberer.remember({
      content: "워크스페이스 없는 파편", type: "fact", topic: "t", _keyId: "key-gate-2"
    });

    assert.ok(result.id, "MEMENTO_WORKSPACE_GATE 미설정이면 저장이 허용되어야 한다");
    assert.ok(result.validation_warnings?.includes("fragmentHasWorkspace"));
  });

  it("fragmentHasWorkspace 위반은 MEMENTO_WORKSPACE_GATE=true면 hard gate로 차단된다", async () => {
    process.env.MEMENTO_WORKSPACE_GATE = "true";

    const policyRules = {
      check: () => [{ rule: "fragmentHasWorkspace", severity: "low", detail: "no workspace", ruleVersion: "v1" }]
    };
    const rememberer = await buildRememberer({ policyRules, getHardGate: async () => true });

    await assert.rejects(
      () => rememberer.remember({
        content: "워크스페이스 없는 파편", type: "fact", topic: "t", _keyId: "key-gate-3"
      }),
      (err) => {
        assert.strictEqual(err.name, "SymbolicPolicyViolationError");
        assert.ok(err.violations.includes("fragmentHasWorkspace"));
        return true;
      }
    );

    delete process.env.MEMENTO_WORKSPACE_GATE;
  });

});
