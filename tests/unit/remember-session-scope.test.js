/**
 * remember scope=session 경로 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 세션 한정 쓰기가 영구 저장과 같은 의미 쓰기 관문(마스킹, 절삭, 정책, 거부)을 거치는지,
 * 저장소(Redis, PostgreSQL 대체 경로, 미저장) 선택이 응답의 working_memory와 힌트에 드러나는지,
 * 대체 경로의 기록 값이 관문을 거친 작업 기억 행인지 하위 계층 대역 위에서 확인한다.
 */

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert                                                from "node:assert/strict";

const { MemoryRememberer }   = await import("../../lib/memory/processors/MemoryRememberer.js");
const { FragmentFactory }    = await import("../../lib/memory/write/FragmentFactory.js");
const { isGateApproved }     = await import("../../lib/memory/write/gateApproval.js");
const { WM_FALLBACK_SOURCE } = await import("../../lib/memory/WorkingMemoryRows.js");
const { teardownTestResources } = await import("../_lifecycle.js");

after(async () => { await teardownTestResources(); });

const SECRET  = `sk-${"Z".repeat(36)}`;
const CONTENT = `배포 키 ${SECRET} 를 환경에 둔다`;

const decisionRule = { check: (f) => (f.type === "decision" ? [{ rule: "decisionHasRationale", severity: "medium" }] : []) };

/**
 * @param {Object}  [opts]
 * @param {boolean} [opts.redisStores]  - addToWorkingMemory의 반환값
 * @param {*}       [opts.insertResult] - store.insert가 돌려줄 값. undefined면 파편 id
 */
function makeRememberer({ redisStores = true, insertResult, policyRules = { check: () => [] }, policyGatingEnabled = false, getHardGate = async () => false } = {}) {
  const calls = { wm: [], inserted: [], approved: [], budget: [], cap: [], order: [] };
  const store = {
    findByIdempotencyKey            : async () => null,
    findCaseIdBySessionTopic        : async () => null,
    findErrorFragmentsBySessionTopic: async () => [],
    getDuplicateState               : async () => null,
    insert                          : async (f) => {
      calls.order.push("insert");
      calls.inserted.push(f);
      calls.approved.push(isGateApproved(f));
      return insertResult === undefined ? f.id : insertResult;
    },
    updateTtlTier                   : async () => true
  };
  const index = {
    index                            : async () => {},
    deindex                          : async () => {},
    addToWorkingMemory               : async (sessionId, f) => { calls.wm.push({ sessionId, f }); return redisStores; },
    enforceFallbackWorkingMemoryBudget: async (sessionId) => { calls.budget.push(sessionId); return 0; },
    enforceFallbackKeyCap             : async (keyId) => { calls.order.push("cap"); calls.cap.push(keyId); return 0; }
  };
  const rememberer = new MemoryRememberer({
    store,
    index,
    factory         : new FragmentFactory(),
    quotaChecker    : { check: async () => {}, getUsage: async () => ({ limit: null, current: 0, remaining: null, resetAt: null }) },
    postProcessor   : { run: async () => {} },
    conflictResolver: { detectConflicts: async () => [], autoLinkOnRemember: async () => {}, supersede: async () => {} },
    caseEventStore  : null,
    policyRules,
    getHardGate,
    policyGatingEnabled
  });
  return { rememberer, calls };
}

const SESSION_WRITE = Object.freeze({ content: CONTENT, topic: "ops", type: "fact", scope: "session", sessionId: "sess-wm-0001", _keyId: "key-1" });

beforeEach(() => { process.env.MEMENTO_REMEMBER_ATOMIC = "false"; });
afterEach(() => {
  delete process.env.MEMENTO_WRITE_GATE;
  delete process.env.MEMENTO_WM_PG_FALLBACK;
});

describe("관문 적용", () => {
  it("Redis 경로도 본문의 민감 정보를 마스킹해 작업 기억에 넣는다", async () => {
    const { rememberer, calls } = makeRememberer();
    await rememberer.remember({ ...SESSION_WRITE });
    assert.equal(calls.wm.length, 1);
    const stored = calls.wm[0].f.content;
    assert.ok(!stored.includes(SECRET), `원문이 남았다: ${stored}`);
    assert.ok(stored.includes("[REDACTED_API_KEY]"));
  });

  it("긴 본문은 유형별 상한으로 잘라 넣는다", async () => {
    const { rememberer, calls } = makeRememberer();
    await rememberer.remember({ ...SESSION_WRITE, content: "가".repeat(500) });
    assert.ok(calls.wm[0].f.content.length < 500);
  });

  it("정책 경고는 응답의 validation_warnings로 알리고 저장은 한다", async () => {
    const { rememberer, calls } = makeRememberer({ policyRules: decisionRule, policyGatingEnabled: true });
    const result = await rememberer.remember({ ...SESSION_WRITE, content: "Redis 캐시 레이어를 도입하기로 했다", type: "decision" });
    assert.deepEqual(result.validation_warnings, ["decisionHasRationale"]);
    assert.equal(calls.wm.length, 1);
  });

  it("hard gate 키의 정책 위반은 어느 저장소에도 쓰지 않고 거부한다", async () => {
    const { rememberer, calls } = makeRememberer({ policyRules: decisionRule, policyGatingEnabled: true, getHardGate: async () => true, redisStores: false });
    await assert.rejects(
      () => rememberer.remember({ ...SESSION_WRITE, content: "Redis 캐시 레이어를 도입하기로 했다", type: "decision" }),
      (err) => err.name === "SymbolicPolicyViolationError"
    );
    assert.equal(calls.wm.length, 0);
    assert.equal(calls.inserted.length, 0);
  });

  it("MEMENTO_WRITE_GATE=off이어도 마스킹은 적용한다", async () => {
    process.env.MEMENTO_WRITE_GATE = "off";
    const { rememberer, calls } = makeRememberer();
    await rememberer.remember({ ...SESSION_WRITE });
    assert.ok(!calls.wm[0].f.content.includes(SECRET));
  });

  it("너무 짧은 본문은 영구 저장과 같이 거부한다", async () => {
    const { rememberer, calls } = makeRememberer();
    await assert.rejects(() => rememberer.remember({ ...SESSION_WRITE, content: "짧음" }));
    assert.equal(calls.wm.length, 0);
  });
});

describe("저장소 선택", () => {
  it("Redis에 넣으면 DB에 쓰지 않고 redis로 알린다", async () => {
    const { rememberer, calls } = makeRememberer({ redisStores: true });
    const result = await rememberer.remember({ ...SESSION_WRITE });
    assert.equal(calls.inserted.length, 0);
    assert.equal(result.working_memory, "redis");
    assert.equal(result._meta, undefined);
    assert.equal(result.scope, "session");
  });

  it("Redis가 받지 못하면 관문을 거친 작업 기억 행으로 DB에 한 번 쓴다", async () => {
    const { rememberer, calls } = makeRememberer({ redisStores: false });
    const result = await rememberer.remember({ ...SESSION_WRITE, importance: 0.8, isAnchor: true, idempotencyKey: "idem-1" });

    assert.equal(calls.inserted.length, 1);
    const row = calls.inserted[0];
    assert.equal(calls.approved[0], true, "관문 표식 없이 기록했다");
    assert.equal(row.source, WM_FALLBACK_SOURCE);
    assert.equal(row.ttl_tier, "short");
    assert.equal(row.session_id, "sess-wm-0001");
    assert.equal(row.key_id, "key-1");
    assert.equal(row.is_anchor, false);
    assert.equal(row.idempotency_key, null);
    assert.ok(row.valid_to, "조회 대상에서 빠지지 않았다");
    assert.ok(!row.content.includes(SECRET));
    assert.deepEqual(calls.budget, ["sess-wm-0001"]);
    assert.equal(row.hash_scope, "wm:sess-wm-0001:default");
    assert.equal(result.working_memory, "postgres-fallback");
    assert.equal(result.id, row.id);
  });

  it("대체 경로 응답은 _meta.hints에 working_memory_fallback을 싣는다", async () => {
    const { rememberer } = makeRememberer({ redisStores: false });
    const result = await rememberer.remember({ ...SESSION_WRITE });
    assert.equal(result._meta.hints.length, 1);
    assert.equal(result._meta.hints[0].signal, "working_memory_fallback");
  });

  it("키별 상한 정리는 행을 쓰기 전에 그 키로 실행한다", async () => {
    const { rememberer, calls } = makeRememberer({ redisStores: false });
    await rememberer.remember({ ...SESSION_WRITE });
    assert.deepEqual(calls.cap, ["key-1"]);
    assert.deepEqual(calls.order, ["cap", "insert"]);
  });

  it("Redis에 넣은 쓰기는 키별 상한 정리를 하지 않는다", async () => {
    const { rememberer, calls } = makeRememberer({ redisStores: true });
    await rememberer.remember({ ...SESSION_WRITE });
    assert.equal(calls.cap.length, 0);
  });

  it("DB가 기존 행의 id를 돌려주면 응답 id가 그 id다", async () => {
    const { rememberer } = makeRememberer({ redisStores: false, insertResult: "existing-row" });
    const result = await rememberer.remember({ ...SESSION_WRITE });
    assert.equal(result.id, "existing-row");
  });

  it("대체 경로를 끄면 저장하지 않고 none과 working_memory_unavailable 힌트로 알린다", async () => {
    process.env.MEMENTO_WM_PG_FALLBACK = "off";
    const { rememberer, calls } = makeRememberer({ redisStores: false });
    const result = await rememberer.remember({ ...SESSION_WRITE });
    assert.equal(calls.inserted.length, 0);
    assert.equal(result.working_memory, "none");
    assert.equal(result._meta.hints[0].signal, "working_memory_unavailable");
    assert.match(result._meta.hints[0].suggestion, /꺼져 있어/);
  });

  it("DB가 쓰기를 받지 못하면(id 없음) 저장하지 않았다고 알린다", async () => {
    const { rememberer, calls } = makeRememberer({ redisStores: false, insertResult: null });
    const result = await rememberer.remember({ ...SESSION_WRITE });
    assert.equal(result.working_memory, "none");
    assert.equal(calls.budget.length, 0);
    assert.equal(result._meta.hints[0].signal, "working_memory_unavailable");
    assert.doesNotMatch(result._meta.hints[0].suggestion, /꺼져/, "대체 경로가 켜져 있는데 꺼졌다고 알렸다");
    assert.match(result._meta.hints[0].suggestion, /저장하지 못했다/);
  });

  it("sessionId가 없으면 영구 저장 경로를 타고 working_memory를 싣지 않는다", async () => {
    const { rememberer, calls } = makeRememberer({ redisStores: false });
    const result = await rememberer.remember({ ...SESSION_WRITE, sessionId: undefined });
    assert.equal(calls.wm.length, 0);
    assert.equal(calls.inserted.length, 1);
    assert.equal(calls.inserted[0].source === WM_FALLBACK_SOURCE, false);
    assert.equal(result.working_memory, undefined);
  });
});
