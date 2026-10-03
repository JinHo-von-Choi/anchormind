/**
 * remember, amend, admin 기억 PATCH의 앵커 권한 적용 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 하위 계층 대역 위의 MemoryRememberer에 키 권한 조회 대역을 넣고, 기록 값의 is_anchor와
 * 응답 경고, 감사 기록 요청, master 문맥 전달을 확인한다. DB는 쓰지 않는다.
 */

import { describe, it, mock, beforeEach, afterEach, after } from "node:test";
import assert                                                from "node:assert/strict";
import { Readable }                                          from "node:stream";

const managerHolder = { instance: null };
mock.module("../../lib/memory/MemoryManager.js", {
  namedExports: { MemoryManager: { getInstance: () => managerHolder.instance } }
});

const { MemoryRememberer }      = await import("../../lib/memory/processors/MemoryRememberer.js");
const { FragmentFactory }       = await import("../../lib/memory/write/FragmentFactory.js");
const { SERVER_ANCHOR_DEPS }    = await import("../../lib/memory/write/serverAnchorDeps.js");
const { getAnchorState }        = await import("../../lib/admin/ApiKeyStore.js");
const { auditAnchorDecision }   = await import("../../lib/memory/write/anchorAudit.js");
const { handleMemory }          = await import("../../lib/admin/admin-memory.js");
const { requireCapability, masterPrincipal } = await import("../../lib/admin/AdminAuthz.js");
const { teardownTestResources } = await import("../_lifecycle.js");

after(async () => { await teardownTestResources(); });

const KEY = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** 하위 계층 대역과 앵커 조회 대역 위의 MemoryRememberer */
function makeRememberer({ existing = null, anchorState = { permissions: ["read", "write"], anchorCount: 0 } } = {}) {
  const inserted = [];
  const updated  = [];
  const lookups  = [];
  const audits   = [];
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
    policyRules     : { check: () => [] },
    getHardGate     : async () => false,
    policyGatingEnabled: false
  });
  rememberer._anchorDeps = {
    getAnchorState: async (keyId) => { lookups.push(keyId); return anchorState; },
    auditAnchor   : (event) => { audits.push(event); }
  };
  return { rememberer, inserted, updated, lookups, audits };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

const ANCHOR_INPUT = Object.freeze({ content: "운영 배포 절차는 항상 스테이징 확인 뒤 진행한다", topic: "ops", type: "procedure", isAnchor: true });

const EXISTING = Object.freeze({
  id: "frag-existing", type: "fact", topic: "ops", content: "기존 본문은 충분히 길게 적어 둔다",
  keywords: ["ops"], agent_id: "default", key_id: KEY, workspace: null, importance: 0.5, is_anchor: false
});

beforeEach(() => { process.env.MEMENTO_REMEMBER_ATOMIC = "false"; });
afterEach(() => { delete process.env.MEMENTO_ANCHOR_PERMISSION; });

describe("서버 앵커 의존성", () => {
  it("서버 앵커 의존성은 ApiKeyStore 조회와 감사 기록 함수다", () => {
    assert.equal(SERVER_ANCHOR_DEPS.getAnchorState, getAnchorState);
    assert.equal(SERVER_ANCHOR_DEPS.auditAnchor, auditAnchorDecision);
  });

  it("MemoryRememberer 기본 앵커 의존성은 서버 의존성이다", () => {
    const rememberer = new MemoryRememberer({});
    assert.equal(rememberer._anchorDeps, SERVER_ANCHOR_DEPS);
  });
});

describe("remember 앵커 지정", () => {
  it("anchor 권한이 없는 키의 요청은 일반 파편으로 저장하고 경고와 감사를 남긴다", async () => {
    const { rememberer, inserted, lookups, audits } = makeRememberer();
    const result = await rememberer.remember({ ...ANCHOR_INPUT, _keyId: KEY });
    await settle();
    assert.equal(inserted[0].is_anchor, false);
    assert.ok(result.validation_warnings.includes("anchorPermissionRequired"));
    assert.deepEqual(lookups, [KEY]);
    assert.deepEqual(audits.map(a => [a.entry, a.outcome, a.reason, a.keyId]), [["remember", "downgraded", "permission", KEY]]);
  });

  it("anchor 권한이 있는 키는 앵커로 저장한다", async () => {
    const { rememberer, inserted, audits } = makeRememberer({ anchorState: { permissions: ["write", "anchor"], anchorCount: 1 } });
    await rememberer.remember({ ...ANCHOR_INPUT, _keyId: KEY });
    await settle();
    assert.equal(inserted[0].is_anchor, true);
    assert.deepEqual(audits.map(a => a.outcome), ["granted"]);
  });

  it("서버가 주입한 master 문맥은 대상 키가 있어도 조회 없이 허용한다", async () => {
    const { rememberer, inserted, lookups } = makeRememberer();
    await rememberer.remember({ ...ANCHOR_INPUT, _keyId: KEY, _isMaster: true });
    assert.equal(inserted[0].is_anchor, true);
    assert.deepEqual(lookups, []);
  });

  it("off이면 write 권한만으로 앵커를 저장하고 조회하지 않는다", async () => {
    process.env.MEMENTO_ANCHOR_PERMISSION = "off";
    const { rememberer, inserted, lookups } = makeRememberer();
    await rememberer.remember({ ...ANCHOR_INPUT, _keyId: KEY });
    assert.equal(inserted[0].is_anchor, true);
    assert.deepEqual(lookups, []);
  });

  it("enforce이면 저장하지 않고 거부한다", async () => {
    process.env.MEMENTO_ANCHOR_PERMISSION = "enforce";
    const { rememberer, inserted } = makeRememberer();
    await assert.rejects(
      () => rememberer.remember({ ...ANCHOR_INPUT, _keyId: KEY }),
      (err) => err.name === "SymbolicPolicyViolationError" && err.violations.includes("anchorPermissionRequired")
    );
    assert.equal(inserted.length, 0);
  });
});

describe("amend 앵커 지정", () => {
  it("anchor 권한이 없는 키는 is_anchor만 빼고 나머지 변경을 반영한다", async () => {
    const { rememberer, updated } = makeRememberer({ existing: { ...EXISTING } });
    const result = await rememberer.amend({ id: EXISTING.id, isAnchor: true, importance: 0.7, _keyId: KEY });
    assert.equal(result.updated, true);
    assert.equal(Object.hasOwn(updated[0], "is_anchor"), false);
    assert.equal(updated[0].importance, 0.7);
    assert.deepEqual(result.validation_warnings, ["anchorPermissionRequired", "review.anchor_unauthorized"]);
  });

  it("앵커 표시를 내리는 amend는 권한 조회 없이 반영하고 cleared로 감사한다", async () => {
    const { rememberer, updated, lookups, audits } = makeRememberer({ existing: { ...EXISTING, is_anchor: true } });
    await rememberer.amend({ id: EXISTING.id, isAnchor: false, _keyId: KEY });
    await settle();
    assert.equal(updated[0].is_anchor, false);
    assert.deepEqual(lookups, []);
    assert.deepEqual(audits.map(a => a.outcome), ["cleared"]);
  });
});

describe("admin 기억 PATCH", () => {
  function jsonReq(method, body) {
    const req   = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method  = method;
    req.headers = { "content-type": "application/json" };
    return req;
  }
  function fakeRes() {
    const chunks = [];
    return { statusCode: 0, setHeader() {}, write(c) { chunks.push(c); }, end(b) { if (b) chunks.push(b); }, get body() { return chunks.join(""); } };
  }

  it("관리 콘솔의 앵커 지정은 master 문맥으로 처리해 키 권한을 조회하지 않는다", async () => {
    const { rememberer, updated, lookups } = makeRememberer({ existing: { ...EXISTING } });
    managerHolder.instance = { amend: (p) => rememberer.amend(p) };
    const res = fakeRes();
    const req = jsonReq("PATCH", { is_anchor: true });
    requireCapability(req, fakeRes(), { principal: masterPrincipal(), cap: "mem.write" });
    await handleMemory(req, res,
      new URL(`http://localhost/v1/internal/model/nothing/memory/fragments/${EXISTING.id}?key_ids=${KEY}`));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(updated[0].is_anchor, true);
    assert.deepEqual(lookups, []);
  });
});
