/**
 * 의미 쓰기 진입점별 관문 적용 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 진입점마다 같은 민감 정보 입력 표를 넣고, 하위 계층 대역이 받은 기록 값에 원문이 남지
 * 않고 마스킹 표식이 들어갔는지 본다. 진입점 고유의 관문 동작(절삭, 정책 경고, 거부, 스위치)도
 * 함께 확인한다.
 */

import { describe, it, mock, beforeEach, afterEach, after } from "node:test";
import assert                                                from "node:assert/strict";
import { Readable }                                          from "node:stream";

/** admin 처리기와 AutoReflect가 불러오는 MemoryManager를 대역으로 바꾼다. */
const managerHolder = { instance: null };
mock.module("../../lib/memory/MemoryManager.js", {
  namedExports: { MemoryManager: { getInstance: () => managerHolder.instance } }
});

/** AutoReflect의 세션 활동 기록과 요약 생성기를 대역으로 바꾼다. */
const geminiHolder = { result: null };
mock.module("../../lib/memory/processors/SessionActivityTracker.js", {
  namedExports: {
    SessionActivityTracker: {
      getActivity   : async () => ({
        toolCalls   : { recall: 4 },
        fragments   : [],
        startedAt   : "2026-10-03T00:00:00.000Z",
        lastActivity: "2026-10-03T00:10:00.000Z"
      }),
      markReflected: async () => {}
    }
  }
});
mock.module("../../lib/gemini.js", {
  namedExports: {
    isGeminiCLIAvailable: async () => true,
    geminiCLIJson       : async () => geminiHolder.result
  }
});
mock.module("../../lib/memory/embedding/MorphemeIndex.js", {
  namedExports: {
    MorphemeIndex: class {
      async tokenize(t)               { return String(t).split(/\s+/).slice(0, 5); }
      async getOrRegisterEmbeddings() { return []; }
    }
  }
});
mock.module("../../lib/memory/processors/EpisodeContinuityService.js", {
  namedExports: { linkEpisodeMilestone: async () => null }
});

const { MemoryRememberer }       = await import("../../lib/memory/processors/MemoryRememberer.js");
const { FragmentFactory }        = await import("../../lib/memory/write/FragmentFactory.js");
const { BatchRememberProcessor } = await import("../../lib/memory/write/BatchRememberProcessor.js");
const { ReflectProcessor }       = await import("../../lib/memory/processors/ReflectProcessor.js");
const { WriteGate }              = await import("../../lib/memory/write/WriteGate.js");
const { autoReflect }            = await import("../../lib/memory/processors/AutoReflect.js");
const { handleMemory }           = await import("../../lib/admin/admin-memory.js");
const { teardownTestResources }  = await import("../_lifecycle.js");

after(async () => { await teardownTestResources(); });

/** 민감 정보 입력 표: [이름, 본문, 원문 조각, 표식] */
const MASKING_TABLE = [
  ["이메일",   "담당자 메일은 ops-team@example.com 으로 보낸다",   "ops-team@example.com",   "[REDACTED_EMAIL]"],
  ["비밀번호", "DB 접속은 password: s3cr3t-pass 로 설정했다",     "s3cr3t-pass",            "[REDACTED_PWD]"],
  ["휴대전화", "장애 연락처는 010-9876-5432 로 전화한다",          "010-9876-5432",          "[REDACTED_PHONE]"],
  ["API 키",   `배포 키 sk-${"Z".repeat(36)} 를 환경에 둔다`,     `sk-${"Z".repeat(36)}`,   "[REDACTED_API_KEY]"]
];

function assertMasked(stored, secret, marker) {
  assert.equal(typeof stored, "string", "기록된 본문이 없다");
  assert.ok(!stored.includes(secret), `원문이 남았다: ${stored}`);
  assert.ok(stored.includes(marker), `표식이 없다: ${stored}`);
}

/** 하위 계층 대역 위의 MemoryRememberer */
function makeRememberer({ existing = null, policyRules = { check: () => [] }, policyGatingEnabled = false, getHardGate = async () => false } = {}) {
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
    index           : { index: async () => {}, deindex: async () => {}, addToWorkingMemory: async () => {} },
    factory         : new FragmentFactory(),
    quotaChecker    : { check: async () => {}, getUsage: async () => ({ limit: null, current: 0, remaining: null, resetAt: null }) },
    postProcessor   : { run: async () => {} },
    conflictResolver: { detectConflicts: async () => [], autoLinkOnRemember: async () => {}, supersede: async () => {} },
    caseEventStore  : null,
    policyRules,
    getHardGate,
    policyGatingEnabled
  });
  return { rememberer, inserted, updated };
}

const EXISTING = Object.freeze({
  id: "frag-existing", type: "fact", topic: "ops", content: "기존 본문은 충분히 길게 적어 둔다",
  keywords: ["ops"], agent_id: "default", key_id: null, workspace: null, importance: 0.5
});

beforeEach(() => { process.env.MEMENTO_REMEMBER_ATOMIC = "false"; });
afterEach(() => { delete process.env.MEMENTO_WRITE_GATE; });

describe("MCP remember", () => {
  for (const [label, content, secret, marker] of MASKING_TABLE) {
    it(`${label} 원문을 마스킹해 기록한다`, async () => {
      const { rememberer, inserted } = makeRememberer();
      await rememberer.remember({ content, topic: "ops", type: "fact" });
      assertMasked(inserted[0]?.content, secret, marker);
    });
  }
});

describe("MCP amend", () => {
  for (const [label, content, secret, marker] of MASKING_TABLE) {
    it(`${label} 원문을 마스킹해 갱신한다`, async () => {
      const { rememberer, updated } = makeRememberer({ existing: { ...EXISTING } });
      const result = await rememberer.amend({ id: EXISTING.id, content });
      assert.equal(result.updated, true);
      assertMasked(updated[0]?.content, secret, marker);
    });
  }

  it("본문을 유형별 저장 상한으로 자른다", async () => {
    const { rememberer, updated } = makeRememberer({ existing: { ...EXISTING } });
    await rememberer.amend({ id: EXISTING.id, content: "가".repeat(500) });
    assert.equal(updated[0].content, `${"가".repeat(300)}...`);
  });

  it("dryRun은 관문을 거친 예상 본문을 돌려주고 갱신하지 않는다", async () => {
    const { rememberer, updated } = makeRememberer({ existing: { ...EXISTING } });
    const [, content, secret, marker] = MASKING_TABLE[0];
    const result = await rememberer.amend({ id: EXISTING.id, content, dryRun: true });
    assertMasked(result.simulated.would_be_fragment.content, secret, marker);
    assert.equal(updated.length, 0);
  });

  it("이번 변경으로 생긴 정책 위반을 validation_warnings로 알린다", async () => {
    const policyRules = { check: (f) => (f.type === "decision" ? [{ rule: "decisionHasRationale", severity: "medium" }] : []) };
    const { rememberer } = makeRememberer({ existing: { ...EXISTING }, policyRules, policyGatingEnabled: true });
    const result = await rememberer.amend({ id: EXISTING.id, type: "decision" });
    assert.equal(result.updated, true);
    assert.deepEqual(result.validation_warnings, ["decisionHasRationale"]);
  });

  it("hard gate 키에서 정책 위반이면 갱신을 거부한다", async () => {
    const policyRules = { check: (f) => (f.type === "decision" ? [{ rule: "decisionHasRationale", severity: "medium" }] : []) };
    const { rememberer, updated } = makeRememberer({
      existing: { ...EXISTING, key_id: "key-1" }, policyRules, policyGatingEnabled: true, getHardGate: async () => true
    });
    await assert.rejects(
      () => rememberer.amend({ id: EXISTING.id, type: "decision", _keyId: "key-1" }),
      (err) => err.name === "SymbolicPolicyViolationError"
    );
    assert.equal(updated.length, 0);
  });

  it("위반이 없으면 응답 형태가 그대로다", async () => {
    const { rememberer } = makeRememberer({ existing: { ...EXISTING } });
    const result = await rememberer.amend({ id: EXISTING.id, importance: 0.6 });
    assert.deepEqual(Object.keys(result).sort(), ["fragment", "updated"]);
  });

  it("MEMENTO_WRITE_GATE=off이면 마스킹과 절삭 없이 갱신한다", async () => {
    process.env.MEMENTO_WRITE_GATE = "off";
    const { rememberer, updated } = makeRememberer({ existing: { ...EXISTING } });
    const [, content] = MASKING_TABLE[0];
    await rememberer.amend({ id: EXISTING.id, content });
    assert.equal(updated[0].content, content);
  });
});

/** admin 처리기 시험용 응답과 요청 */
function fakeRes() {
  const chunks = [];
  return {
    statusCode: 0,
    setHeader() {},
    write(c) { chunks.push(c); },
    end(body) { if (body) chunks.push(body); },
    get body() { return chunks.join(""); }
  };
}
function jsonReq(method, body) {
  const req   = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method  = method;
  req.headers = { "content-type": "application/json" };
  return req;
}
const ADMIN_BASE = "/v1/internal/model/nothing";

describe("admin 기억 PATCH", () => {
  for (const [label, content, secret, marker] of MASKING_TABLE) {
    it(`${label} 원문을 마스킹해 갱신한다`, async () => {
      const { rememberer, updated } = makeRememberer({ existing: { ...EXISTING } });
      managerHolder.instance = { amend: (p) => rememberer.amend(p) };
      const res = fakeRes();
      await handleMemory(jsonReq("PATCH", { content }), res,
        new URL(`http://localhost${ADMIN_BASE}/memory/fragments/${EXISTING.id}`));
      assert.equal(res.statusCode, 200, res.body);
      assertMasked(updated[0]?.content, secret, marker);
    });
  }
});

/** 관문에 넘어온 진입점 이름을 기록하는 관문 */
class RecordingGate extends WriteGate {
  constructor(entries, deps) {
    super(deps);
    this.entries = entries;
  }
  async check(request) {
    this.entries.push(request.entry);
    return super.check(request);
  }
}

/** 다중 행 INSERT의 본문 열(행마다 24열 중 둘째)을 모으는 일괄 저장 풀 */
function makeBatchPool(contents) {
  const COLS = 24;
  return {
    connect: async () => ({
      query: async (sql, params) => {
        if (typeof sql !== "string" || !sql.includes("INSERT INTO")) return { rows: [] };
        const rows = [];
        for (let i = 0; i < params.length; i += COLS) {
          contents.push(params[i + 1]);
          rows.push({ id: params[i] });
        }
        return { rows };
      },
      release() {}
    })
  };
}

function makeBatchProcessor(contents, writeGate) {
  const proc = new BatchRememberProcessor({
    store  : {},
    index  : { index: async () => {} },
    factory: new FragmentFactory(),
    ...(writeGate ? { writeGate } : {})
  });
  proc.setPool(makeBatchPool(contents));
  return proc;
}

const decisionRule = { check: (f) => (f.type === "decision" ? [{ rule: "decisionHasRationale", severity: "medium" }] : []) };

describe("MCP batch_remember", () => {
  it("항목마다 민감 정보를 마스킹해 기록한다", async () => {
    const contents = [];
    const proc     = makeBatchProcessor(contents);
    const result   = await proc.process({
      fragments: MASKING_TABLE.map(([, content]) => ({ content, type: "fact", topic: "ops" }))
    });
    assert.equal(result.inserted, MASKING_TABLE.length);
    MASKING_TABLE.forEach(([, , secret, marker], i) => assertMasked(contents[i], secret, marker));
  });

  it("항목별 정책 경고를 결과에 싣고 다른 항목은 그대로 저장한다", async () => {
    const contents = [];
    const proc     = makeBatchProcessor(contents, () => new WriteGate({ policyRules: decisionRule, policyGatingEnabled: true }));
    const result   = await proc.process({
      fragments: [
        { content: "Redis 캐시 레이어를 도입하기로 했다", type: "decision", topic: "ops" },
        { content: "Redis 포트는 6380으로 운영한다",       type: "fact",     topic: "ops" }
      ]
    });
    assert.deepEqual(result.results[0].validation_warnings, ["decisionHasRationale"]);
    assert.equal(result.results[1].validation_warnings, undefined);
    assert.equal(result.inserted, 2);
  });

  it("hard gate 키의 위반 항목만 거부한다", async () => {
    const contents = [];
    const proc     = makeBatchProcessor(contents, () => new WriteGate({
      policyRules: decisionRule, policyGatingEnabled: true, getHardGate: async () => true
    }));
    const result = await proc.process({
      _keyId   : "key-1",
      fragments: [
        { content: "Redis 캐시 레이어를 도입하기로 했다", type: "decision", topic: "ops" },
        { content: "Redis 포트는 6380으로 운영한다",       type: "fact",     topic: "ops" }
      ]
    });
    assert.equal(result.results[0].success, false);
    assert.match(result.results[0].error, /policy_violation: decisionHasRationale/);
    assert.equal(result.results[1].success, true);
    assert.equal(contents.length, 1);
  });

  it("MEMENTO_WRITE_GATE=off이면 기존처럼 마스킹만 하고 정책 경고는 없다", async () => {
    process.env.MEMENTO_WRITE_GATE = "off";
    const contents = [];
    const proc     = makeBatchProcessor(contents, () => new WriteGate({ policyRules: decisionRule, policyGatingEnabled: true }));
    const [, content, secret, marker] = MASKING_TABLE[0];
    const result = await proc.process({ fragments: [{ content, type: "decision", topic: "ops" }] });
    assertMasked(contents[0], secret, marker);
    assert.equal(result.results[0].validation_warnings, undefined);
  });
});

/** reflect 처리기 */
function makeReflectProcessor({ batchRememberProcessor = null, inserted = [], writeGate } = {}) {
  return new ReflectProcessor({
    store        : { insert: async (f) => { inserted.push(f); return f.id ?? "frag-x"; } },
    index        : { index: async () => {}, evictWorkingMemoryItems: async () => 0 },
    factory      : new FragmentFactory(),
    sessionLinker: { consolidateSessionFragments: async () => null, autoLinkSessionFragments: async () => ({ linkSuggestions: [] }) },
    remember     : async () => ({ id: null }),
    batchRememberProcessor,
    ...(writeGate ? { writeGate } : {})
  });
}

describe("reflect 파생 파편", () => {
  it("일괄 저장 경로는 reflect 진입점으로 관문을 거쳐 마스킹해 기록한다", async () => {
    const contents = [];
    const entries  = [];
    const proc     = makeBatchProcessor(contents, () => new RecordingGate(entries));
    const reflect  = makeReflectProcessor({ batchRememberProcessor: proc });
    await reflect.process({ summary: MASKING_TABLE.map(([, content]) => content), agentId: "a1" });
    MASKING_TABLE.forEach(([, , secret, marker], i) => assertMasked(contents[i], secret, marker));
    assert.ok(entries.length > 0 && entries.every(e => e === "reflect"), JSON.stringify(entries));
  });

  it("개별 저장 경로도 항목마다 관문을 거쳐 마스킹해 기록한다", async () => {
    const inserted = [];
    const entries  = [];
    const reflect  = makeReflectProcessor({ inserted, writeGate: () => new RecordingGate(entries) });
    await reflect.process({ decisions: MASKING_TABLE.map(([, content]) => content), agentId: "a1" });
    assert.equal(inserted.length, MASKING_TABLE.length);
    for (const [, , secret, marker] of MASKING_TABLE) {
      assert.ok(inserted.some(f => f.content.includes(marker) && !f.content.includes(secret)), marker);
    }
    assert.equal(entries.length, MASKING_TABLE.length);
  });
});

describe("AutoReflect", () => {
  it("요약 결과를 auto_reflect 진입점으로 관문에 통과시켜 마스킹해 기록한다", async () => {
    const contents = [];
    const entries  = [];
    const proc     = makeBatchProcessor(contents, () => new RecordingGate(entries));
    const reflect  = makeReflectProcessor({ batchRememberProcessor: proc });
    managerHolder.instance = { reflect: (p, opts) => reflect.process(p, opts) };
    geminiHolder.result    = { summary: MASKING_TABLE.map(([, content]) => content), decisions: [], errors_resolved: [], new_procedures: [], open_questions: [] };

    const result = await autoReflect("sess-auto-1", "a1");
    assert.equal(result.count, MASKING_TABLE.length);
    MASKING_TABLE.forEach(([, , secret, marker], i) => assertMasked(contents[i], secret, marker));
    assert.ok(entries.length > 0 && entries.every(e => e === "auto_reflect"), JSON.stringify(entries));
  });
});
