/**
 * 쓰기 경로의 출처 기록 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 쓰기 관문이 생성 후보에 출처 세 값을 싣는지, 스위치가 꺼지면 싣지 않는지, 갱신과 verified 지정이
 * 등급을 바꾸지 않는지, remember와 일괄 저장이 서버 관측 문맥을 관문에 넘기고 기록 문장에 열을
 * 덧붙이는지, 도구 호출 문맥이 클라이언트가 보낸 관측 값을 버리고 세션 값을 싣는지 대역 위에서 본다.
 */

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert                                         from "node:assert/strict";

import { WriteGate, WriteInputError, provenanceStep } from "../../lib/memory/write/WriteGate.js";
import { MemoryRememberer, amendChanges }            from "../../lib/memory/processors/MemoryRememberer.js";
import { FragmentFactory }                           from "../../lib/memory/write/FragmentFactory.js";
import { BatchRememberProcessor }                    from "../../lib/memory/write/BatchRememberProcessor.js";
import { applyTrustedToolContext }                   from "../../lib/jsonrpc.js";
import { injectSessionContext }                      from "../../lib/handlers/mcp-handler.js";
import { teardownTestResources }                     from "../_lifecycle.js";

after(async () => { await teardownTestResources(); });

const CONTENT = "배포 스크립트는 운영 반영 전에 스테이징에서 먼저 확인한다";

/** 대역 의존성 위의 관문 */
function gate({ provenance = true, enabled = true } = {}) {
  return new WriteGate({
    policyGatingEnabled: false,
    enabled            : () => enabled,
    provenance         : () => provenance,
    sensitiveScanMode  : () => "mask"
  });
}

/** 생성 요청 하나를 관문에 통과시킨다. */
async function create(g, { entry = "remember", fields = {}, provenance } = {}) {
  const { draft } = await g.check({
    entry,
    op    : "create",
    fields: { content: CONTENT, topic: "ops", type: "procedure", ...fields },
    ctx   : { keyId: "key-1", agentId: "default", ...(provenance ? { provenance } : {}) },
    build : (input) => new FragmentFactory().create(input, { contentPrepared: true })
  });
  return draft;
}

describe("관문의 출처 기록", () => {
  it("주장 출처, 관측 클라이언트, 키 상한으로 정한 등급을 싣는다", async () => {
    const draft = await create(gate(), {
      fields    : { origin: "user_stated" },
      provenance: { clientName: "claude-code", trustCap: 3 }
    });
    assert.equal(draft.origin, "user_stated");
    assert.equal(draft.observed_client, "claude-code/remember");
    assert.equal(draft.trust_tier, 3);
  });

  it("trusted_origin이 없는 키는 user_stated 주장도 2로 상한한다", async () => {
    const draft = await create(gate(), {
      fields    : { origin: "user_stated" },
      provenance: { clientName: "claude-code", trustCap: 2 }
    });
    assert.equal(draft.trust_tier, 2);
  });

  it("external_content 주장은 1이다", async () => {
    const draft = await create(gate(), { fields: { origin: "external_content" }, provenance: { trustCap: 3 } });
    assert.equal(draft.trust_tier, 1);
    assert.equal(draft.observed_client, "unknown/remember");
  });

  it("주장과 문맥이 없으면 출처 null, 등급 2다", async () => {
    const draft = await create(gate());
    assert.equal(draft.origin, null);
    assert.equal(draft.trust_tier, 2);
  });

  it("허용 밖의 origin은 -32602로 거부한다", async () => {
    await assert.rejects(
      () => create(gate(), { fields: { origin: "system" } }),
      (err) => err instanceof WriteInputError && err.code === -32602 && /origin must be one of/.test(err.message)
    );
  });

  it("주장을 받지 않는 진입점은 origin 인자를 보지 않는다", async () => {
    const draft = await create(gate(), { entry: "reflect", fields: { origin: "system" }, provenance: { clientName: "cursor", trustCap: 3 } });
    assert.equal(draft.origin, null);
    assert.equal(draft.observed_client, "cursor/reflect");
    assert.equal(draft.trust_tier, 2);
  });

  it("서버 진입점은 정해진 출처와 internal 관측 표기를 쓴다", async () => {
    const draft = await create(gate(), { entry: "consolidate_split", fields: { origin: "user_stated" } });
    assert.equal(draft.origin, "consolidation");
    assert.equal(draft.observed_client, "internal/consolidate_split");
  });

  it("관문 스위치가 꺼져도 출처 스위치를 따른다", async () => {
    const draft = await create(gate({ enabled: false }), { fields: { origin: "tool_output" } });
    assert.equal(draft.origin, "tool_output");
    assert.equal(draft.trust_tier, 2);
  });

  it("MEMENTO_PROVENANCE=off이면 세 값을 싣지 않고 origin 인자를 보지 않는다", async () => {
    const draft = await create(gate({ provenance: false }), { fields: { origin: "system" }, provenance: { trustCap: 3 } });
    for (const key of ["origin", "observed_client", "trust_tier"]) {
      assert.equal(Object.hasOwn(draft, key), false, key);
    }
  });

  it("verified 주장은 같은 입력의 observed와 등급이 같다", async () => {
    const ctx      = { clientName: "c", trustCap: 3 };
    const observed = await create(gate(), { fields: { origin: "agent_inferred", assertionStatus: "observed" }, provenance: ctx });
    const verified = await create(gate(), { fields: { origin: "agent_inferred", assertionStatus: "verified" }, provenance: ctx });
    assert.equal(verified.assertion_status, "verified");
    assert.equal(verified.trust_tier, observed.trust_tier);
  });
});

describe("갱신은 등급을 바꾸지 않는다", () => {
  const base = Object.freeze({
    id: "f1", type: "fact", topic: "ops", content: CONTENT, keywords: ["ops"], trust_tier: 1, origin: "external_content"
  });

  it("amend 인자는 출처 열을 바꿀 수 없다", () => {
    const changes = amendChanges({
      assertionStatus: "verified", trust_tier: 3, trustTier: 3, origin: "user_stated", observed_client: "x"
    });
    assert.deepEqual(changes, { assertion_status: "verified" });
  });

  it("같은 세션의 verified 지정을 관문에 통과시켜도 바뀐 열에 등급이 없다", async () => {
    const result = await gate().check({
      entry : "amend",
      op    : "update",
      fields: { assertion_status: "verified" },
      base,
      ctx   : { keyId: "key-1", agentId: "default", provenance: { clientName: "c", trustCap: 3 } }
    });
    assert.deepEqual(Object.keys(result.fields), ["assertion_status"]);
    assert.equal(result.draft.trust_tier, 1);
  });

  it("provenanceStep은 갱신 상태를 그대로 돌려준다", () => {
    const state = { entry: "amend", op: "update", fields: {}, draft: { ...base }, ctx: {} };
    assert.equal(provenanceStep(state, { provenanceEnabled: () => true }), state);
  });

  it("amend 경로가 저장소에 넘긴 갱신 값에 등급이 없다", async () => {
    const { rememberer, updated } = makeRememberer({ existing: { ...base, agent_id: "default", key_id: null, session_id: "s1" } });
    const result = await rememberer.amend({ id: "f1", assertionStatus: "verified", _sessionId: "s1", _isMaster: true });
    assert.equal(result.updated, true);
    assert.equal(updated.length, 1);
    for (const key of ["trust_tier", "origin", "observed_client"]) assert.equal(Object.hasOwn(updated[0], key), false, key);
  });
});

/** 하위 계층 대역 위의 MemoryRememberer */
function makeRememberer({ existing = null } = {}) {
  const inserted = [];
  const updated  = [];
  const store = {
    findByIdempotencyKey            : async () => null,
    findCaseIdBySessionTopic        : async () => null,
    findErrorFragmentsBySessionTopic: async () => [],
    getDuplicateState               : async () => null,
    insert                          : async (f) => { inserted.push(f); return f.id; },
    updateTtlTier                   : async () => true,
    getById                         : async () => existing,
    update                          : async (id, updates) => { updated.push(updates); return { ...existing, ...updates }; }
  };
  const rememberer = new MemoryRememberer({
    store,
    index           : { index: async () => {}, deindex: async () => {}, addToWorkingMemory: async () => true },
    factory         : new FragmentFactory(),
    quotaChecker    : { check: async () => {}, getUsage: async () => ({ limit: null, current: 0, remaining: null, resetAt: null }) },
    postProcessor   : { run: async () => {} },
    conflictResolver: { detectConflicts: async () => [], autoLinkOnRemember: async () => {}, supersede: async () => {} },
    caseEventStore  : null,
    policyRules     : { check: () => [] },
    getHardGate     : async () => false,
    policyGatingEnabled: false
  });
  return { rememberer, inserted, updated };
}

describe("remember 진입점", () => {
  beforeEach(() => { process.env.MEMENTO_REMEMBER_ATOMIC = "false"; });
  afterEach(() => {
    delete process.env.MEMENTO_REMEMBER_ATOMIC;
    delete process.env.MEMENTO_PROVENANCE;
  });

  it("세션 문맥의 클라이언트 이름과 키 권한으로 출처를 기록한다", async () => {
    const { rememberer, inserted } = makeRememberer();
    await rememberer.remember({
      content: CONTENT, topic: "ops", type: "fact", origin: "user_stated",
      _clientName: "claude-code", _isMaster: false, _permissions: ["read", "write", "trusted_origin"]
    });
    assert.equal(inserted[0].origin, "user_stated");
    assert.equal(inserted[0].observed_client, "claude-code/remember");
    assert.equal(inserted[0].trust_tier, 3);
  });

  it("마스터 키는 상한 3, 일반 키는 상한 2다", async () => {
    const master = makeRememberer();
    await master.rememberer.remember({ content: CONTENT, topic: "ops", type: "fact", origin: "user_stated", _isMaster: true });
    assert.equal(master.inserted[0].trust_tier, 3);

    const plain = makeRememberer();
    await plain.rememberer.remember({
      content: CONTENT, topic: "ops", type: "fact", origin: "user_stated", _isMaster: false, _permissions: ["read", "write"]
    });
    assert.equal(plain.inserted[0].trust_tier, 2);
  });

  it("scope=session 작업 기억 파편에도 출처가 실린다", async () => {
    const stored = [];
    const { rememberer } = makeRememberer();
    rememberer.index.addToWorkingMemory = async (sid, f) => { stored.push(f); return true; };
    await rememberer.remember({
      content: CONTENT, topic: "ops", type: "fact", scope: "session", sessionId: "s1",
      origin: "tool_output", _clientName: "cursor"
    });
    assert.equal(stored[0].origin, "tool_output");
    assert.equal(stored[0].observed_client, "cursor/remember");
  });

  it("MEMENTO_PROVENANCE=off이면 기록 값에 출처 열이 없다", async () => {
    process.env.MEMENTO_PROVENANCE = "off";
    const { rememberer, inserted } = makeRememberer();
    await rememberer.remember({ content: CONTENT, topic: "ops", type: "fact", origin: "user_stated", _isMaster: true });
    for (const key of ["origin", "observed_client", "trust_tier"]) assert.equal(Object.hasOwn(inserted[0], key), false, key);
  });
});

describe("일괄 저장 기록 문장", () => {
  /** INSERT 문장과 인자를 모으는 대역 연결 */
  function fakeClient() {
    const statements = [];
    return {
      statements,
      query: async (sql, params = []) => {
        statements.push({ sql, params });
        const rows = (sql.match(/\(\$\d+/g) ?? []).map((_, i) => ({ id: `id-${i}` }));
        return { rows };
      }
    };
  }

  const processor = new BatchRememberProcessor({ store: {}, index: { index: async () => {} }, factory: new FragmentFactory() });
  const row = (extra = {}, index = 0) => ({
    index,
    fragment: { id: "f", content: CONTENT, topic: "ops", type: "fact", keywords: [], content_hash: "h", ...extra }
  });

  it("출처 값이 있으면 세 열을 덧붙이고 행마다 27개 값을 묶는다", async () => {
    const client = fakeClient();
    const chunk  = [row({ origin: "user_stated", observed_client: "c/batch_remember", trust_tier: 2 }), row({}, 1)];
    await processor._insertChunk(client, chunk, [{}, {}], { agentId: "default", keyId: null, conflictSql: "" });
    const { sql, params } = client.statements[0];
    assert.match(sql, /embedding, origin, observed_client, trust_tier\)/);
    assert.equal(params.length, 54);
    assert.deepEqual(params.slice(24, 27), ["user_stated", "c/batch_remember", 2]);
    assert.deepEqual(params.slice(51, 54), [null, null, null]);
    assert.match(sql, /\$27::smallint\)/);
    assert.match(sql, /\$28,/);
  });

  it("출처 값이 없으면 열과 값이 늘지 않는다", async () => {
    const client = fakeClient();
    await processor._insertChunk(client, [row(), row({}, 1)], [{}, {}], { agentId: "default", keyId: null, conflictSql: "" });
    const { sql, params } = client.statements[0];
    assert.doesNotMatch(sql, /origin|trust_tier/);
    assert.equal(params.length, 48);
  });

  it("관문 단계에 서버 관측 문맥을 넘긴다", async () => {
    const seen = [];
    const spy  = new BatchRememberProcessor({
      store    : {},
      index    : { index: async () => {} },
      factory  : new FragmentFactory(),
      writeGate: () => ({ check: async (req) => { seen.push(req.ctx.provenance); return { draft: { id: "x" }, warnings: [] }; } })
    });
    await spy._validateAndBuild([{ content: CONTENT, topic: "ops", type: "fact" }], {
      agentId: "default", keyId: null, workspace: null, provenance: { clientName: "cursor", trustCap: 2 }
    });
    assert.deepEqual(seen, [{ clientName: "cursor", trustCap: 2 }]);
  });
});

describe("도구 호출 문맥", () => {
  const session = {
    authenticated: true, keyId: "k1", groupKeyIds: null, permissions: ["read", "write"], defaultWorkspace: null,
    mode: null, sessionId: "s1", isMaster: false, clientName: "claude-code"
  };

  it("클라이언트가 보낸 _clientName과 _provenance를 버리고 세션 값을 싣는다", () => {
    const args = applyTrustedToolContext({
      name     : "remember",
      arguments: { content: "x", _clientName: "forged", _provenance: { trustCap: 3 } }
    }, session);
    assert.equal(args._clientName, "claude-code");
    assert.equal(Object.hasOwn(args, "_provenance"), false);
  });

  it("세션에 이름이 없으면 null이다", () => {
    const args = applyTrustedToolContext({ name: "remember", arguments: {} }, { ...session, clientName: undefined });
    assert.equal(args._clientName, null);
  });

  it("HTTP 경로의 인자 주입도 두 필드를 지운다", () => {
    const msg = { method: "tools/call", params: { arguments: { _clientName: "forged", _provenance: {} } } };
    injectSessionContext(msg, { sessionId: "s1" });
    assert.equal(Object.hasOwn(msg.params.arguments, "_clientName"), false);
    assert.equal(Object.hasOwn(msg.params.arguments, "_provenance"), false);
  });
});
