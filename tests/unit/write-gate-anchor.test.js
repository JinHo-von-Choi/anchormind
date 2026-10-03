/**
 * WriteGate anchor 단계와 앵커 판정 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 단계 함수는 대역 의존성으로, check()는 대역 조회와 감사 기록 위에서 warn, enforce, off,
 * dryRun, hard gate와의 관계를 확인한다. DB는 쓰지 않는다.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert                                   from "node:assert/strict";

import { WriteGate, WRITE_ENTRIES, anchorStep, isGateEligible, ANCHOR_REQUEST_ENTRIES } from "../../lib/memory/write/WriteGate.js";
import { anchorDecisionTotal } from "../../lib/memory/write/write-gate-metrics.js";
import { anchorQuotaOf }       from "../../lib/memory/write/anchorQuota.js";

const KEY = "11111111-2222-4333-8444-555555555555";

/** 단계 시험용 상태 */
function stateOf({ entry = "remember", op = "create", fields = {}, base = null, draft = null, keyId = KEY, isMaster = false } = {}) {
  return { entry, op, mode: "production", metrics: "all", fields, base, draft, ctx: { keyId, agentId: "default", isMaster }, violations: [] };
}

/** 단계 의존성 대역. state는 키의 권한과 앵커 수이고 calls는 조회한 키 id다. */
function depsOf({ mode = "warn", state = { permissions: ["read", "write"], anchorCount: 0 }, limit = 1000, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    anchorPermissionMode: () => mode,
    anchorLimit         : () => limit,
    getAnchorState      : async (keyId) => {
      calls.push(keyId);
      if (fail) throw new Error("db down");
      return state;
    }
  };
}

describe("anchorStep", () => {
  it("off이면 상태를 그대로 돌려준다", async () => {
    const state = stateOf({ draft: { is_anchor: true } });
    assert.equal(await anchorStep(state, depsOf({ mode: "off" })), state);
  });

  it("앵커 요청 진입점은 remember, amend, batch_remember뿐이다", async () => {
    assert.deepEqual([...ANCHOR_REQUEST_ENTRIES].sort(), [WRITE_ENTRIES.AMEND, WRITE_ENTRIES.BATCH, WRITE_ENTRIES.REMEMBER].sort());
    const state = stateOf({ entry: WRITE_ENTRIES.ADMIN_IMPORT, draft: { is_anchor: true } });
    const deps  = depsOf();
    assert.equal(await anchorStep(state, deps), state);
    assert.deepEqual(deps.calls, []);
  });

  it("앵커 요청이 없으면 조회하지 않는다", async () => {
    const deps  = depsOf();
    const state = stateOf({ draft: { is_anchor: false } });
    assert.equal(await anchorStep(state, deps), state);
    assert.deepEqual(deps.calls, []);
  });

  it("master 키(keyId 없음)는 조회 없이 허용한다", async () => {
    const deps = depsOf();
    const next = await anchorStep(stateOf({ keyId: null, draft: { is_anchor: true } }), deps);
    assert.equal(next.draft.is_anchor, true);
    assert.deepEqual(next.violations, []);
    assert.deepEqual(next.anchor, { change: "set", granted: true, reason: "master" });
    assert.deepEqual(deps.calls, []);
  });

  it("서버가 확인한 master 문맥은 대상 키가 있어도 허용한다", async () => {
    const deps = depsOf();
    const next = await anchorStep(stateOf({ isMaster: true, draft: { is_anchor: true } }), deps);
    assert.equal(next.anchor.reason, "master");
    assert.deepEqual(deps.calls, []);
  });

  it("anchor 권한이 없는 키의 생성 요청은 일반 파편으로 낮추고 위반을 남긴다", async () => {
    const input = stateOf({ draft: { id: "f1", is_anchor: true } });
    const next  = await anchorStep(input, depsOf());
    assert.equal(next.draft.is_anchor, false);
    assert.deepEqual(next.violations.map(v => v.rule), ["anchorPermissionRequired"]);
    assert.deepEqual(next.anchor, { change: "set", granted: false, reason: "permission" });
    assert.equal(input.draft.is_anchor, true);
    assert.deepEqual(input.violations, []);
  });

  it("권한이 있는 키는 허용한다", async () => {
    const deps = depsOf({ state: { permissions: ["read", "write", "anchor"], anchorCount: 3 } });
    const next = await anchorStep(stateOf({ draft: { is_anchor: true } }), deps);
    assert.equal(next.draft.is_anchor, true);
    assert.deepEqual(next.violations, []);
    assert.deepEqual(deps.calls, [KEY]);
  });

  it("살아 있는 앵커 수가 상한에 이르면 anchorLimitExceeded다", async () => {
    const deps = depsOf({ state: { permissions: ["anchor"], anchorCount: 5 }, limit: 5 });
    const next = await anchorStep(stateOf({ draft: { is_anchor: true } }), deps);
    assert.equal(next.draft.is_anchor, false);
    assert.deepEqual(next.violations.map(v => v.rule), ["anchorLimitExceeded"]);
  });

  it("키 행이 없으면 권한이 없는 것으로 본다", async () => {
    const next = await anchorStep(stateOf({ draft: { is_anchor: true } }), depsOf({ state: null }));
    assert.deepEqual(next.violations.map(v => v.rule), ["anchorPermissionRequired"]);
  });

  it("조회 실패는 anchorLookupFailed로 낮춘다", async () => {
    const next = await anchorStep(stateOf({ draft: { is_anchor: true } }), depsOf({ fail: true }));
    assert.equal(next.draft.is_anchor, false);
    assert.deepEqual(next.violations.map(v => v.rule), ["anchorLookupFailed"]);
  });

  it("갱신 요청을 낮추면 is_anchor만 빼고 나머지 변경은 남긴다", async () => {
    const base  = { id: "f1", is_anchor: false, content: "기존" };
    const input = stateOf({ entry: WRITE_ENTRIES.AMEND, op: "update", base, fields: { is_anchor: true, topic: "t2" }, draft: { ...base, is_anchor: true, topic: "t2" } });
    const next  = await anchorStep(input, depsOf());
    assert.equal(Object.hasOwn(next.fields, "is_anchor"), false);
    assert.equal(next.fields.topic, "t2");
    assert.equal(next.draft.is_anchor, false);
    assert.equal(input.fields.is_anchor, true);
  });

  it("앵커 표시를 내리는 갱신은 판정 없이 clear로 기록한다", async () => {
    const deps = depsOf();
    const base = { id: "f1", is_anchor: true };
    const next = await anchorStep(stateOf({ entry: WRITE_ENTRIES.AMEND, op: "update", base, fields: { is_anchor: false }, draft: { ...base, is_anchor: false } }), deps);
    assert.deepEqual(next.anchor, { change: "clear", granted: true, reason: "clear" });
    assert.deepEqual(next.violations, []);
    assert.deepEqual(deps.calls, []);
  });

  it("앵커 위반은 hard gate 대상이 아니다", () => {
    for (const rule of ["anchorPermissionRequired", "anchorLimitExceeded", "anchorLookupFailed"]) {
      assert.equal(isGateEligible({ rule }), false);
    }
  });
});

describe("WriteGate.check 앵커 판정", () => {
  beforeEach(() => { delete process.env.MEMENTO_WRITE_GATE; });
  afterEach(() => { delete process.env.MEMENTO_WRITE_GATE; });

  /** 대역 관문. audits에 감사 기록 요청을 모은다. */
  function gateOf({ mode = "warn", state = { permissions: ["read", "write"], anchorCount: 0 }, hardGate = false } = {}) {
    const audits = [];
    const gate   = new WriteGate({
      getHardGate         : async () => hardGate,
      getAnchorState      : async () => state,
      auditAnchor         : (event) => { audits.push(event); },
      anchorPermissionMode: () => mode,
      reviewQueue         : () => false
    });
    return { gate, audits };
  }

  const remember = (extra = {}) => ({
    entry : WRITE_ENTRIES.REMEMBER,
    op    : "create",
    ctx   : { keyId: KEY },
    fields: { content: "앵커로 고정할 충분히 긴 본문", type: "fact", topic: "t", isAnchor: true },
    build : (input) => ({ id: "f-new", ...input, is_anchor: input.isAnchor === true, validation_warnings: [] }),
    ...extra
  });

  const settle = () => new Promise(resolve => setImmediate(resolve));

  async function decisionCount(outcome, reason) {
    const metric = await anchorDecisionTotal.get();
    return metric.values.find(v => v.labels.outcome === outcome && v.labels.reason === reason)?.value ?? 0;
  }

  it("warn은 hard gate 키에서도 저장하고 일반 파편으로 낮춘 뒤 경고, 지표, 감사를 남긴다", async () => {
    const { gate, audits } = gateOf({ hardGate: true });
    const before = await decisionCount("downgraded", "permission");
    const out    = await gate.check(remember());
    await settle();
    assert.equal(out.draft.is_anchor, false);
    assert.deepEqual(out.warnings, ["anchorPermissionRequired"]);
    assert.deepEqual(out.draft.validation_warnings.map(v => v.rule), ["anchorPermissionRequired"]);
    assert.equal(await decisionCount("downgraded", "permission"), before + 1);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].outcome, "downgraded");
    assert.equal(audits[0].reason, "permission");
    assert.equal(audits[0].fragmentId, "f-new");
    assert.equal(audits[0].keyId, KEY);
  });

  it("enforce는 -32003 오류(SymbolicPolicyViolationError)로 거부하고 거부를 감사한다", async () => {
    const { gate, audits } = gateOf({ mode: "enforce" });
    await assert.rejects(
      () => gate.check(remember()),
      (err) => err.name === "SymbolicPolicyViolationError" && err.violations.includes("anchorPermissionRequired")
    );
    await settle();
    assert.deepEqual(audits.map(a => a.outcome), ["rejected"]);
  });

  it("enforce의 dryRun은 거부하지 않고 규칙 이름만 돌려주며 감사하지 않는다", async () => {
    const { gate, audits } = gateOf({ mode: "enforce" });
    const out = await gate.check(remember({ mode: "dryRun" }));
    await settle();
    assert.deepEqual(out.warnings, ["anchorPermissionRequired"]);
    assert.deepEqual(audits, []);
  });

  it("허용된 지정은 경고 없이 저장하고 granted로 감사한다", async () => {
    const { gate, audits } = gateOf({ mode: "enforce", state: { permissions: ["read", "write", "anchor"], anchorCount: 0 } });
    const out = await gate.check(remember());
    await settle();
    assert.equal(out.draft.is_anchor, true);
    assert.deepEqual(out.warnings, []);
    assert.deepEqual(audits.map(a => [a.outcome, a.reason, a.change]), [["granted", "permitted", "set"]]);
  });

  it("앵커 표시를 내리는 amend는 cleared로 감사한다", async () => {
    const { gate, audits } = gateOf({ mode: "enforce" });
    const out = await gate.check({
      entry : WRITE_ENTRIES.AMEND,
      op    : "update",
      ctx   : { keyId: KEY },
      fields: { is_anchor: false },
      base  : { id: "f1", type: "fact", is_anchor: true }
    });
    await settle();
    assert.equal(out.fields.is_anchor, false);
    assert.deepEqual(audits.map(a => [a.outcome, a.fragmentId]), [["cleared", "f1"]]);
  });

  it("감사 기록 실패는 쓰기를 막지 않는다", async () => {
    const gate = new WriteGate({
      getAnchorState      : async () => ({ permissions: ["anchor"], anchorCount: 0 }),
      auditAnchor         : () => { throw new Error("disk full"); },
      anchorPermissionMode: () => "warn"
    });
    const out = await gate.check(remember());
    await settle();
    assert.equal(out.draft.is_anchor, true);
  });

  it("MEMENTO_WRITE_GATE=off이면 앵커를 판정하지 않는다", async () => {
    process.env.MEMENTO_WRITE_GATE = "off";
    const { gate, audits } = gateOf({ mode: "enforce" });
    const out = await gate.check(remember());
    await settle();
    assert.equal(out.draft.is_anchor, true);
    assert.deepEqual(audits, []);
  });

  it("조회 의존성을 주지 않은 관문은 키의 앵커 요청을 조회 실패로 낮춘다", async () => {
    const gate = new WriteGate({ anchorPermissionMode: () => "warn" });
    const out  = await gate.check(remember());
    assert.equal(out.draft.is_anchor, false);
    assert.deepEqual(out.warnings, ["anchorLookupFailed"]);
  });
});

describe("WriteGate.check 앵커 상한 표식", () => {
  const settle = () => new Promise(resolve => setImmediate(resolve));

  function gateOf(mode = "warn", state = { permissions: ["anchor"], anchorCount: 0 }) {
    const audits = [];
    const gate   = new WriteGate({
      getAnchorState      : async () => state,
      auditAnchor         : (event) => { audits.push(event); },
      anchorPermissionMode: () => mode,
      anchorLimit         : () => 3,
      reviewQueue         : () => false
    });
    return { gate, audits };
  }

  const request = (extra = {}) => ({
    entry : WRITE_ENTRIES.BATCH,
    op    : "create",
    ctx   : { keyId: KEY },
    fields: { content: "일괄 저장 항목을 앵커로 고정한다", type: "fact", topic: "t", isAnchor: true },
    build : (input) => ({ id: "f-batch", ...input, is_anchor: input.isAnchor === true, validation_warnings: [] }),
    ...extra
  });

  it("일괄 저장 항목의 앵커 지정도 판정하고 권한이 없으면 낮춘다", async () => {
    const { gate } = gateOf("warn", { permissions: ["read", "write"], anchorCount: 0 });
    const out = await gate.check(request());
    assert.equal(out.draft.is_anchor, false);
    assert.deepEqual(out.warnings, ["anchorPermissionRequired"]);
    assert.equal(anchorQuotaOf(out.draft), null);
  });

  it("허용한 키 지정의 생성 후보와 갱신 열에 키와 상한을 담은 표식을 단다", async () => {
    const { gate } = gateOf();
    const created  = await gate.check(request());
    assert.deepEqual({ keyId: anchorQuotaOf(created.draft).keyId, limit: anchorQuotaOf(created.draft).limit }, { keyId: KEY, limit: 3 });

    const updated = await gate.check({
      entry: WRITE_ENTRIES.AMEND, op: "update", ctx: { keyId: KEY },
      fields: { is_anchor: true }, base: { id: "f1", type: "fact", is_anchor: false }
    });
    assert.equal(anchorQuotaOf(updated.fields).keyId, KEY);
  });

  it("master 지정과 dryRun에는 표식을 달지 않는다", async () => {
    const { gate } = gateOf();
    assert.equal(anchorQuotaOf((await gate.check(request({ ctx: { keyId: null } }))).draft), null);
    assert.equal(anchorQuotaOf((await gate.check(request({ mode: "dryRun" }))).draft), null);
  });

  it("warn의 exceed는 위반을 돌려주고 warnings에 더하며 limit 사유로 감사한다", async () => {
    const { gate, audits } = gateOf();
    const out       = await gate.check(request());
    const violation = anchorQuotaOf(out.draft).exceed();
    await settle();
    assert.equal(violation.rule, "anchorLimitExceeded");
    assert.deepEqual(out.warnings, ["anchorLimitExceeded"]);
    assert.deepEqual(audits.map(a => [a.outcome, a.reason]), [["granted", "permitted"], ["downgraded", "limit"]]);
  });

  it("enforce의 exceed는 SymbolicPolicyViolationError를 던지고 거부를 감사한다", async () => {
    const { gate, audits } = gateOf("enforce");
    const out = await gate.check(request());
    assert.throws(() => anchorQuotaOf(out.draft).exceed(),
      (err) => err.name === "SymbolicPolicyViolationError" && err.violations.includes("anchorLimitExceeded"));
    await settle();
    assert.deepEqual(audits.map(a => a.outcome), ["granted", "rejected"]);
  });
});
