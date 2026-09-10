import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const captured = [];
const warnings = [];
mock.module("../../lib/logger.js", {
  namedExports: { logWarn: message => warnings.push(message) }
});
const pool = {
  query: async (sql, params) => {
    captured.push({ sql, params });
    return { rows: [] };
  }
};

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => pool,
    queryWithAgentVector: async (agentId, sql, params) => {
      captured.push({ agentId, sql, params });
      return { rows: [] };
    }
  }
});
mock.module("../../lib/tools/embedding.js", {
  namedExports: { vectorToSql: value => JSON.stringify(value) }
});

const {
  resolveAgentScope,
  isFragmentInAgentScope,
  assertMasterPeerScope,
  assertAuthenticatedAgentScope
} = await import("../../lib/memory/read/AgentScope.js");
const { FragmentReader } = await import("../../lib/memory/read/FragmentReader.js");
const { fetchLinkedFragments } = await import("../../lib/memory/read/LinkedFragmentLoader.js");
const { fetchCausalLinks, fetchSessionNeighbors } = await import("../../lib/memory/read/StitchSourceLoader.js");
const { classifyAnchors } = await import("../../lib/memory/admin/AnchorScopeInventory.js");
const { legacyUnboundAgentScopeTotal } = await import("../../lib/metrics.js");

describe("effective agent scope", () => {
  it("embedded peer 조회는 master trust가 없으면 I/O 전에 거부한다", async () => {
    captured.length = 0;
    assert.throws(() => resolveAgentScope({ includePeerAgents: true }), /master-key only/);
    await assert.rejects(new FragmentReader().getById("fragment-a", "agent-a", null, [], {
      includePeerAgents: true
    }), /master-key only/);
    assert.equal(captured.length, 0);
    const trusted = resolveAgentScope({ includePeerAgents: true, _isMaster: true });
    assert.equal(resolveAgentScope(trusted).includePeerAgents, true);
  });

  it("agentId는 서버에서도 128자 경계를 검증한다", () => {
    assert.equal(resolveAgentScope({ agentId: "a".repeat(128) }).agentId.length, 128);
    assert.throws(() => resolveAgentScope({ agentId: "a".repeat(129) }), { code: "INVALID_PARAMS" });
  });

  it("유예 경로를 실제 사용하는 non-master non-default 요청만 경고와 카운터를 남긴다", async () => {
    const before = (await legacyUnboundAgentScopeTotal.get()).values[0].value;
    warnings.length = 0;
    assertAuthenticatedAgentScope({ agentId: "default" });
    assertAuthenticatedAgentScope({ agentId: "private", _isMaster: true });
    assert.throws(() => assertAuthenticatedAgentScope({ agentId: "private" }, { allowLegacyUnbound: false }));
    assert.throws(() => assertAuthenticatedAgentScope({ agentId: "private", includePeerAgents: true }));
    assert.equal(warnings.length, 0);
    assert.equal((await legacyUnboundAgentScopeTotal.get()).values[0].value, before);
    assertAuthenticatedAgentScope({ agentId: "private" });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /MEMENTO_ALLOW_LEGACY_UNBOUND_AGENT_SCOPE=false/);
    assert.doesNotMatch(warnings[0], /private/);
    assert.equal((await legacyUnboundAgentScopeTotal.get()).values[0].value, before + 1);
  });
  it("agentId 생략은 default-only이다", () => {
    const scope = resolveAgentScope({});
    assert.equal(scope.auditLabel, "default-only");
    assert.deepEqual(scope.agentIds, ["default"]);
    assert.equal(isFragmentInAgentScope({ agent_id: "default" }, scope), true);
    assert.equal(isFragmentInAgentScope({ agent_id: "agent-a" }, scope), false);
  });

  it("specific agent는 own + default이고 metadata 누락은 fail-closed이다", () => {
    const scope = resolveAgentScope({ agentId: "agent-a" });
    assert.deepEqual(scope.agentIds, ["agent-a", "default"]);
    assert.equal(isFragmentInAgentScope({ agent_id: "agent-a" }, scope), true);
    assert.equal(isFragmentInAgentScope({ agent_id: "default" }, scope), true);
    assert.equal(isFragmentInAgentScope({ agent_id: "agent-b" }, scope), false);
    assert.equal(isFragmentInAgentScope({}, scope), false);
  });

  it("peer-agent 권한표는 master만 허용한다", () => {
    assert.doesNotThrow(() => assertMasterPeerScope({ includePeerAgents: true, _isMaster: true }));
    assert.throws(
      () => assertMasterPeerScope({ includePeerAgents: true, _isMaster: false }),
      /master-key only/
    );
    assert.throws(
      () => assertMasterPeerScope({ includePeerAgents: true, _keyId: null }),
      /master-key only/
    );
    assert.doesNotThrow(() => assertMasterPeerScope({ includePeerAgents: false, _isMaster: false }));
  });

  it("peer-agent도 agent metadata가 없는 cache row를 fail-closed한다", () => {
    const scope = resolveAgentScope({ agentId: "agent-a", includePeerAgents: true, _isMaster: true });
    assert.equal(isFragmentInAgentScope({ agent_id: "agent-b" }, scope), true);
    assert.equal(isFragmentInAgentScope({ agent_id: "default" }, scope), true);
    assert.equal(isFragmentInAgentScope({ agent_id: null }, scope), false);
    assert.equal(isFragmentInAgentScope({}, scope), false);
  });

  it("legacy unbound agent 유예는 기본 허용이고 명시적 false는 거부한다", () => {
    const params = { agentId: "agent-a", _isMaster: false };
    assert.doesNotThrow(() => assertAuthenticatedAgentScope(params));
    assert.throws(() => assertAuthenticatedAgentScope(params, { allowLegacyUnbound: false }), /not authorized/);
    assert.doesNotThrow(() => assertAuthenticatedAgentScope(params, { allowLegacyUnbound: true }));
  });

  it("audit label은 줄바꿈과 구분자를 제거한다", () => {
    const scope = resolveAgentScope({ agentId: "agent-a\nforged|record" });
    assert.equal(scope.auditLabel, "specific+default");
    assert.doesNotMatch(scope.auditLabel, /agent-a|[\r\n|;]/);
  });
});

describe("source/linked/stitch hydration", () => {
  it("source 조회는 agent + key-group + workspace를 동시에 적용한다", async () => {
    captured.length = 0;
    const reader = new FragmentReader();
    await reader.searchBySource(
      "learning_extraction", "agent-a", ["key-a", "key-b"], 5, "workspace-a"
    );
    const call = captured.at(-1);
    assert.match(call.sql, /\(agent_id = \$2 OR agent_id = 'default'\)/);
    assert.match(call.sql, /key_id = ANY\(\$3::text\[\]\)/);
    assert.match(call.sql, /workspace = \$4/);
  });

  it("linked preview는 agent/key/workspace 범위를 적용한다", async () => {
    captured.length = 0;
    await fetchLinkedFragments(["fragment-a"], {
      agentId: "agent-a", keyId: "key-a", groupKeyIds: ["key-a"], workspace: "workspace-a"
    });
    const call = captured.at(-1);
    assert.match(call.sql, /f\.agent_id = \$2/);
    assert.match(call.sql, /f\.key_id/);
    assert.match(call.sql, /f\.workspace/);
  });

  it("causal/session hydration은 peer 모드에서도 key/workspace를 유지한다", async () => {
    captured.length = 0;
    const scope = {
      agentId: "agent-a", includePeerAgents: true, _isMaster: true,
      keyId: "key-a", groupKeyIds: ["key-a"], workspace: "workspace-a"
    };
    await fetchCausalLinks(["fragment-a"], scope);
    await fetchSessionNeighbors([
      { id: "fragment-a", session_id: "session-a", created_at: "2026-01-01T00:00:00Z" }
    ], scope);
    for (const call of captured) {
      assert.match(call.sql, /peer-agent: no [a-z._]+ filter/);
      assert.match(call.sql, /f\.agent_id IS NOT NULL/);
      assert.match(call.sql, /f\.key_id/);
      assert.match(call.sql, /f\.workspace/);
    }
  });
});

describe("anchor inventory classification", () => {
  it("명시 승인 외에는 private/unconfirmed 상태를 보존한다", () => {
    const rows = [
      { id: "anchor-shared", agent_id: "agent-a" },
      { id: "anchor-private", agent_id: "agent-a" },
      { id: "anchor-unknown", agent_id: "agent-b" }
    ];
    const result = classifyAnchors(rows, {
      shared: new Set(["anchor-shared"]), private: new Set(["anchor-private"])
    });
    assert.deepEqual(result.map(item => item.category), ["shared", "private", "unconfirmed"]);
  });

  it("같은 anchor의 shared/private 중복 분류를 거부한다", () => {
    assert.throws(
      () => classifyAnchors([{ id: "anchor-a", agent_id: "agent-a" }], {
        shared: new Set(["anchor-a"]), private: new Set(["anchor-a"])
      }),
      /classification conflict/
    );
  });
});
