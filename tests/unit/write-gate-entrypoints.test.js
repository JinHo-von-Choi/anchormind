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

/** admin 가져오기가 불러오는 FragmentWriter를 기록 대역으로 바꾼다. */
const writerHolder = { inserted: [], idFor: (f) => f.id };
mock.module("../../lib/memory/write/FragmentWriter.js", {
  namedExports: {
    FragmentWriter: class {
      async insertDetailed(f) {
        writerHolder.inserted.push(f);
        const id = writerHolder.idFor(f);
        return { id, created: id === f.id };
      }
      async restoreVersion() {}
    }
  }
});

const { MemoryRememberer }       = await import("../../lib/memory/processors/MemoryRememberer.js");
const { FragmentFactory }        = await import("../../lib/memory/write/FragmentFactory.js");
const { BatchRememberProcessor } = await import("../../lib/memory/write/BatchRememberProcessor.js");
const { ReflectProcessor }       = await import("../../lib/memory/processors/ReflectProcessor.js");
const { WriteGate, WriteInputError } = await import("../../lib/memory/write/WriteGate.js");
const { autoReflect }            = await import("../../lib/memory/processors/AutoReflect.js");
const { handleMemory }           = await import("../../lib/admin/admin-memory.js");
const { handleImport }           = await import("../../lib/admin/admin-export.js");
const { importRows }             = await import("../../lib/cli/import.js");
const { rememberLocal }          = await import("../../lib/cli/remember.js");
const { importProfile, IMPORT_DEFAULTS, buildImportFragment } = await import("../../lib/memory/write/FragmentImporter.js");
const { loadImportRuntime }      = await import("../../lib/memory/transfer/importRuntime.js");
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

describe("MCP remember 마스킹 후 품질 판정", () => {
  it("원문이 품질 기준을 통과하면 마스킹 결과가 URL만 남아도 저장한다", async () => {
    const { rememberer, inserted } = makeRememberer();
    await rememberer.remember({ content: "https://a.example/010 1234 5678", topic: "ops", type: "fact" });
    assert.equal(inserted[0]?.content, "https://a.example/[REDACTED_PHONE]");
  });
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

  it("저장 상한을 넘는 기존 행의 메타데이터만 바꾸면 본문을 건드리지 않고 거부하지 않는다", async () => {
    const legacy = { ...EXISTING, content: "가".repeat(524), type: "decision" };
    const { rememberer, updated } = makeRememberer({
      existing           : legacy,
      policyRules        : { check: (f) => (f.type === "decision" ? [{ rule: "decisionHasRationale", severity: "medium" }] : []) },
      policyGatingEnabled: true,
      getHardGate        : async () => true
    });
    const result = await rememberer.amend({ id: legacy.id, importance: 0.8, _keyId: null });
    assert.equal(result.updated, true);
    assert.equal(Object.hasOwn(updated[0], "content"), false);
    assert.deepEqual(Object.keys(updated[0]), ["importance"]);
    assert.equal(result.validation_warnings, undefined);
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

  it("MEMENTO_WRITE_GATE=off이면 마스킹만 하고 정책 경고는 없다", async () => {
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

/** 트랜잭션 client 대역. 호출 문장 첫 단어를 기록한다. */
function fakeClient(statements = []) {
  return { query: async (sql) => { statements.push(String(sql).split(/\s/)[0]); return { rows: [] }; }, release() {} };
}

/** admin 가져오기를 대역 의존성(DB 연결 없는 트랜잭션)으로 실행한다. */
async function adminImport(body, search = "") {
  const res = fakeRes();
  await handleImport(jsonReq("POST", body), res, new URL(`http://localhost${ADMIN_BASE}/import${search}`), {
    loadRuntime    : async (kind, opts) => ({ ...(await loadImportRuntime(kind, opts)), withTransaction: async (_pool, fn) => fn(fakeClient()) }),
    queueEmbeddings: async () => async (ids) => ids.length
  });
  return res;
}

describe("admin import", () => {
  beforeEach(() => {
    writerHolder.inserted = [];
    writerHolder.idFor    = (f) => f.id;
  });

  it("행마다 민감 정보를 마스킹해 기록한다", async () => {
    const res = await adminImport({ fragments: MASKING_TABLE.map(([, content]) => ({ content, topic: "ops", type: "fact" })) });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);
    assert.deepEqual([body.imported, body.duplicates, body.rejected, body.errors], [MASKING_TABLE.length, 0, 0, 0]);
    MASKING_TABLE.forEach(([, , secret, marker], i) => assertMasked(writerHolder.inserted[i]?.content, secret, marker));
  });

  it("관문이 받아들이지 않은 행은 rejected, 이미 있는 본문은 duplicates로 센다", async () => {
    writerHolder.idFor = (f) => (f.content.startsWith("이미") ? "frag-existing" : f.id);
    const res = await adminImport({ fragments: [
      { content: "짧음", topic: "ops", type: "fact" },
      { content: "이미 저장된 본문과 같은 내용이다", topic: "ops", type: "fact" },
      { content: "새로 가져오는 본문 하나를 적는다", topic: "ops", type: "fact" }
    ] });
    const body = JSON.parse(res.body);
    assert.deepEqual([body.imported, body.duplicates, body.rejected], [1, 1, 1]);
    assert.deepEqual(body.rejected_by_reason, { input_invalid: 1 });
  });

  it("행의 key_id는 읽지 않고 key_id 매개변수 없이는 마스터 범위로 기록한다", async () => {
    const res = await adminImport({ fragments: [
      { content: "다른 키 소속으로 적힌 가져오기 본문", topic: "ops", type: "fact", key_id: "key-9", is_anchor: true }
    ] });
    const body = JSON.parse(res.body);
    assert.equal(body.imported, 1);
    assert.equal(writerHolder.inserted[0].key_id, null);
    assert.equal(body.ignored.key_id, 1);
  });
});

/** CLI 가져오기 의존성 */
function cliImportDeps({ inserted = [], dryRun = false, order = [], statements = [] } = {}) {
  const gate      = new WriteGate();
  const realCheck = gate.check.bind(gate);
  gate.check      = (...a) => { order.push("gate"); return realCheck(...a); };
  const client    = fakeClient(statements);
  return {
    profile        : importProfile(IMPORT_DEFAULTS.cli, { owner: true }),
    entry          : "cli_import",
    gate,
    writer         : { insertDetailed: async (f) => { inserted.push(f); return { id: f.id, created: true }; } },
    linkStore      : { restoreLink: async () => ({ created: true }) },
    pool           : { connect: async () => client },
    withTransaction: (_pool, fn) => { order.push("transaction"); return fn(client); },
    idempotent     : false,
    dryRun,
    log            : () => {}
  };
}

describe("CLI import", () => {
  it("줄마다 민감 정보를 마스킹해 기록한다", async () => {
    const inserted = [];
    const lines    = MASKING_TABLE.map(([, content]) => JSON.stringify({ content, topic: "ops" }));
    const report   = (await importRows(lines, cliImportDeps({ inserted }))).toJSON();
    assert.equal(report.imported, MASKING_TABLE.length);
    MASKING_TABLE.forEach(([, , secret, marker], i) => assertMasked(inserted[i]?.content, secret, marker));
  });

  it("관문이 받아들이지 않은 줄은 rejected로 세고 기록하지 않는다", async () => {
    const inserted = [];
    const report   = (await importRows([JSON.stringify({ content: "짧음", topic: "ops" })], cliImportDeps({ inserted }))).toJSON();
    assert.deepEqual([report.imported, report.rejected, report.errors], [0, 1, 0]);
    assert.equal(inserted.length, 0);
  });

  it("dry-run은 행을 처리하되 트랜잭션을 되돌려 남기지 않는다", async () => {
    const statements = [];
    const report     = (await importRows([JSON.stringify({ content: MASKING_TABLE[0][1], topic: "ops" })], cliImportDeps({ dryRun: true, statements }))).toJSON();
    assert.equal(report.imported, 1);
    assert.equal(statements.at(-1), "ROLLBACK");
    assert.ok(!statements.includes("COMMIT"));
  });
});

describe("CLI remember 로컬 모드", () => {
  for (const [label, content, secret, marker] of MASKING_TABLE) {
    it(`${label} 원문을 마스킹해 기록한다`, async () => {
      const inserted = [];
      const result   = await rememberLocal(
        { content, topic: "ops", type: "fact", source: "cli", agentId: "cli" },
        {
          gate       : new WriteGate(),
          writer     : { insert: async (f) => { inserted.push(f); return f.id; } },
          transaction: (fn) => fn({}),
          entry      : "cli_remember"
        }
      );
      assert.equal(result.id, inserted[0].id);
      assertMasked(inserted[0]?.content, secret, marker);
    });
  }
});

describe("buildImportFragment", () => {
  const owner = (defaults, extra = {}) => importProfile(defaults, { owner: true, ...extra });

  it("대상 키는 프로필이 정하고 행의 key_id는 읽지 않는다", () => {
    const row = { id: "f1", content: "본문", topic: "t", key_id: "key-9", agent_id: null };
    assert.equal(buildImportFragment(row, owner(IMPORT_DEFAULTS.admin)).key_id, null);
    assert.equal(buildImportFragment(row, owner(IMPORT_DEFAULTS.cli, { keyId: "key-1" })).key_id, "key-1");
    assert.equal(buildImportFragment(row, owner(IMPORT_DEFAULTS.admin)).agent_id, "default");
    assert.equal(buildImportFragment(row, owner(IMPORT_DEFAULTS.cli)).source, "import");
  });

  it("is_anchor는 owner 프로필에서만 행의 값을 따른다", () => {
    const row = { content: "본문", topic: "t", is_anchor: true };
    assert.equal(buildImportFragment(row, importProfile(IMPORT_DEFAULTS.cli, { owner: false })).is_anchor, false);
    assert.equal(buildImportFragment(row, owner(IMPORT_DEFAULTS.cli)).is_anchor, true);
  });

  it("id가 없으면 새 id를 만든다", () => {
    const built = buildImportFragment({ content: "본문", topic: "t" }, owner(IMPORT_DEFAULTS.cli));
    assert.match(built.id, /^[0-9a-f-]{36}$/);
  });
});

describe("가져오기 행 오류 격리", () => {
  beforeEach(() => {
    writerHolder.inserted = [];
    writerHolder.idFor    = (f) => f.id;
  });

  it("admin 가져오기는 형식이 잘못된 행을 rejected로 세고 나머지를 기록한다", async () => {
    const res = await adminImport({ fragments: [
      null,
      { content: "키워드 형식이 잘못된 행이다", topic: "ops", type: "fact", keywords: [{ bad: true }] },
      { content: 12345, topic: "ops", type: "fact" },
      { content: "정상적으로 가져오는 본문 하나", topic: "ops", type: "fact" }
    ] });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);
    assert.deepEqual([body.imported, body.rejected], [1, 3]);
    assert.deepEqual(body.rejected_by_reason, { invalid_record: 1, input_invalid: 1, invalid_row: 1 });
  });

  it("admin 가져오기는 같은 id가 이미 있는 행을 id_conflict로 거부하고 응답을 끝까지 돌려준다", async () => {
    writerHolder.idFor = (f) => {
      if (f.id === "dup-id") throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
      return f.id;
    };
    const res = await adminImport({ fragments: [
      { id: "dup-id", content: "같은 id로 다른 본문을 가져온다", topic: "ops", type: "fact" },
      { id: "new-id", content: "새 id로 가져오는 본문 하나다", topic: "ops", type: "fact" }
    ] });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);
    assert.deepEqual([body.imported, body.rejected], [1, 1]);
    assert.deepEqual(body.rejected_by_reason, { id_conflict: 1 });
  });

  it("admin 가져오기는 행 값 때문에 DB가 거부한 행을 database_rejected로 세고 다음 행을 기록한다", async () => {
    writerHolder.idFor = (f) => {
      if (f.id === "bad-type") throw Object.assign(new Error("violates check constraint \"fragments_type_check\""), { code: "23514" });
      return f.id;
    };
    const res = await adminImport({ fragments: [
      { id: "bad-type", content: "허용되지 않은 유형으로 가져오는 본문", topic: "ops", type: "note" },
      { id: "ok-row",   content: "정상 유형으로 가져오는 본문 하나다",   topic: "ops", type: "fact" }
    ] });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);
    assert.deepEqual([body.imported, body.rejected], [1, 1]);
    assert.deepEqual(body.rejected_by_reason, { database_rejected: 1 });
    assert.deepEqual(writerHolder.inserted.map(f => f.id), ["bad-type", "ok-row"]);
  });

  it("admin 가져오기는 연결 오류면 지금까지의 집계를 partial에 담아 500으로 응답한다", async () => {
    writerHolder.idFor = (f) => {
      if (f.content.startsWith("연결")) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      return f.id;
    };
    const res = await adminImport({ fragments: [
      { content: "먼저 정상으로 가져온 본문 하나이다", topic: "ops", type: "fact" },
      { content: "연결이 끊긴 상태에서 가져오는 본문", topic: "ops", type: "fact" }
    ] });
    assert.equal(res.statusCode, 500);
    assert.equal(JSON.parse(res.body).partial.imported, 1);
  });

  it("CLI 가져오기는 행 값 때문에 DB가 거부한 행을 rejected로 세고 다음 행을 기록한다", async () => {
    const inserted = [];
    const deps     = cliImportDeps({ inserted });
    deps.writer    = { insertDetailed: async (f) => {
      if (f.content.startsWith("거부")) throw Object.assign(new Error("violates check constraint"), { code: "23514" });
      inserted.push(f);
      return { id: f.id, created: true };
    } };
    const report = (await importRows([
      JSON.stringify({ content: "거부될 assertion 값을 가진 본문", topic: "ops", assertion_status: "maybe" }),
      JSON.stringify({ content: "정상적으로 가져오는 본문 하나", topic: "ops" })
    ], deps)).toJSON();
    assert.deepEqual([report.imported, report.rejected], [1, 1]);
    assert.deepEqual(report.rejected_by_reason, { database_rejected: 1 });
  });

  it("CLI 가져오기는 연결 오류를 errors로 세고 다음 줄을 계속 처리한다", async () => {
    const deps  = cliImportDeps();
    let   calls = 0;
    deps.writer = { insertDetailed: async (f) => {
      if (calls++ === 0) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      return { id: f.id, created: true };
    } };
    const report = (await importRows([
      JSON.stringify({ content: "연결이 끊겨 기록하지 못하는 본문", topic: "ops" }),
      JSON.stringify({ content: "정상적으로 가져오는 본문 하나", topic: "ops" })
    ], deps)).toJSON();
    assert.deepEqual([report.imported, report.errors, report.rejected], [1, 1, 0]);
  });

  it("CLI 가져오기는 관문을 트랜잭션 전에 거치고 잘못된 행은 rejected로 센다", async () => {
    const order  = [];
    const lines  = [
      JSON.stringify({ content: "키워드 형식이 잘못된 행이다", topic: "ops", keywords: [{ bad: true }] }),
      JSON.stringify({ content: "정상적으로 가져오는 본문 하나", topic: "ops" })
    ];
    const report = (await importRows(lines, cliImportDeps({ order }))).toJSON();
    assert.deepEqual([report.imported, report.rejected], [1, 1]);
    assert.deepEqual(order, ["gate", "gate", "transaction"]);
  });
});

describe("reflect 개별 저장 경로의 관문 값", () => {
  it("관문을 거친 topic, keywords, goal, outcome, contextSummary로 기록한다", async () => {
    const inserted = [];
    const gate     = new WriteGate({
      steps: {
        sensitive: (state) => ({
          ...state,
          fields: { ...state.fields, topic: "gated-topic", goal: "gated-goal", outcome: "gated-outcome", contextSummary: "gated-summary", keywords: ["gated"] }
        })
      }
    });
    const reflect = makeReflectProcessor({ inserted, writeGate: () => gate });
    await reflect.process({ decisions: ["Redis 캐시 레이어를 도입하기로 결정했다, 근거는 조회 부하다"], agentId: "a1" });
    assert.equal(inserted.length, 1);
    const [f] = inserted;
    assert.deepEqual([f.topic, f.goal, f.outcome, f.context_summary, f.keywords], ["gated-topic", "gated-goal", "gated-outcome", "gated-summary", ["gated"]]);
  });

  it("관문이 거부한 항목은 그룹을 재시도 대상으로 남기지 않는다", async () => {
    const index    = { index: async () => {}, evictWorkingMemoryItems: mock.fn(async () => 0) };
    const reflect  = new ReflectProcessor({
      store        : { insert: async (f) => f.id },
      index,
      factory      : new FragmentFactory(),
      sessionLinker: {
        consolidateSessionFragments: async () => ([{
          workspace: null, topic: null, caseId: null, summary: "세션 통합 요약 내용 하나", decisions: [],
          errors_resolved: [], new_procedures: [], open_questions: [], sourceFragmentIds: [], wmItemIds: ["wm-1"]
        }]),
        autoLinkSessionFragments: async () => ({ linkSuggestions: [] })
      },
      remember : async () => ({ id: null }),
      writeGate: () => new WriteGate({ steps: { normalize: () => { throw new WriteInputError("Content too short: length < 10 and word count < 3"); } } })
    });
    await reflect.process({ sessionId: "sess-reject", agentId: "a1" });
    assert.equal(index.evictWorkingMemoryItems.mock.callCount(), 1, "거부된 그룹의 작업 기억도 걷어 낸다");
  });
});

/** 레거시 규칙 밖의 규칙(GitHub 토큰)과 레거시 규칙(이메일)이 함께 든 본문 */
const OFF_TOKEN   = `ghp_${"a1".repeat(18)}`;
const OFF_CONTENT = `배포 담당 ops-team@example.com 의 토큰 ${OFF_TOKEN} 을 환경 변수에 둔다`;

describe("탐지 방식 off의 저장 경로", () => {
  afterEach(() => {
    delete process.env.MEMENTO_SENSITIVE_SCAN;
    delete process.env.MEMENTO_WRITE_GATE;
  });

  /** 레거시 규칙만 적용한 결과인지 본다. */
  function assertLegacyOnly(stored) {
    assert.equal(typeof stored, "string", "기록된 본문이 없다");
    assert.ok(stored.includes("[REDACTED_EMAIL]"), stored);
    assert.ok(stored.includes(OFF_TOKEN), stored);
  }

  function assertFullyMasked(stored) {
    assert.ok(stored.includes("[REDACTED_EMAIL]"), stored);
    assert.ok(!stored.includes(OFF_TOKEN), stored);
  }

  const MODES = [
    ["MEMENTO_SENSITIVE_SCAN=off", () => { process.env.MEMENTO_SENSITIVE_SCAN = "off"; }],
    ["MEMENTO_WRITE_GATE=off",     () => { process.env.MEMENTO_WRITE_GATE = "off"; }]
  ];

  for (const [label, setMode] of MODES) {
    describe(label, () => {
      beforeEach(setMode);

      it("FragmentFactory.create는 레거시 규칙만 적용한다", () => {
        assertLegacyOnly(new FragmentFactory().create({ content: OFF_CONTENT, topic: "ops", type: "fact" }).content);
      });

      it("FragmentFactory.splitAndCreate는 레거시 규칙만 적용한다", () => {
        const parts = new FragmentFactory().splitAndCreate(OFF_CONTENT, { topic: "ops", type: "fact" });
        assert.ok(parts.length > 0);
        assertLegacyOnly(parts.map(p => p.content).join(" "));
      });

      it("세션 범위 remember는 레거시 규칙만 적용한다", async () => {
        const { rememberer } = makeRememberer();
        const stored = [];
        rememberer.index.addToWorkingMemory = async (sessionId, fragment) => { stored.push(fragment); };
        await rememberer.remember({ content: OFF_CONTENT, topic: "ops", type: "fact", scope: "session", sessionId: "sess-off-1" });
        assertLegacyOnly(stored[0]?.content);
      });

      it("reflect의 문자열 요약과 배열 요약과 범주 항목은 레거시 규칙만 적용한다", async () => {
        for (const params of [{ summary: OFF_CONTENT }, { summary: [OFF_CONTENT] }, { decisions: [OFF_CONTENT] }]) {
          const inserted = [];
          const reflect  = makeReflectProcessor({ inserted });
          await reflect.process({ ...params, agentId: "a1" });
          assert.ok(inserted.length > 0, JSON.stringify(Object.keys(params)));
          assertLegacyOnly(inserted.map(f => f.content).join(" "));
        }
      });

      it("관문을 거치는 remember도 새 규칙을 적용하지 않는다", async () => {
        const { rememberer, inserted } = makeRememberer();
        await rememberer.remember({ content: OFF_CONTENT, topic: "ops", type: "fact" });
        assertLegacyOnly(inserted[0]?.content);
      });
    });
  }

  describe("기본값(mask)", () => {
    it("같은 입력의 모든 호출자가 새 규칙까지 적용한다", async () => {
      assertFullyMasked(new FragmentFactory().create({ content: OFF_CONTENT, topic: "ops", type: "fact" }).content);
      assertFullyMasked(new FragmentFactory().splitAndCreate(OFF_CONTENT, { topic: "ops", type: "fact" }).map(p => p.content).join(" "));

      const { rememberer } = makeRememberer();
      const stored = [];
      rememberer.index.addToWorkingMemory = async (sessionId, fragment) => { stored.push(fragment); };
      await rememberer.remember({ content: OFF_CONTENT, topic: "ops", type: "fact", scope: "session", sessionId: "sess-mask-1" });
      assertFullyMasked(stored[0]?.content);

      const inserted = [];
      await makeReflectProcessor({ inserted }).process({ summary: [OFF_CONTENT], agentId: "a1" });
      assertFullyMasked(inserted.map(f => f.content).join(" "));
    });
  });
});
