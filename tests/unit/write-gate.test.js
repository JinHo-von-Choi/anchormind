/**
 * WriteGate 단계와 판정 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 단계 함수는 상태를 받아 새 상태를 돌려주는 순수 함수로 따로 시험하고, check()는
 * 대역 의존성 위에서 단계 순서, 후보 생성, 판정, 스위치를 시험한다.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert                                   from "node:assert/strict";

import {
  WriteGate,
  WRITE_ENTRIES,
  STEP_ORDER,
  LEGACY_STEPS,
  normalizeStep,
  sensitiveStep,
  lengthStep,
  policyStep,
  workspaceStep,
  anchorStep,
  isGateEligible,
  WriteInputError
} from "../../lib/memory/write/WriteGate.js";

/** 단계 시험용 상태 */
function stateOf({ op = "create", fields = {}, base = null, draft = null, keyId = null } = {}) {
  return { entry: "remember", op, mode: "production", fields, base, draft, ctx: { keyId, agentId: "default" }, violations: [] };
}

const SECRET_CONTENT = "연락처 user@example.com, password: hunter2, 전화 010-1234-5678 기록";

describe("normalizeStep", () => {
  it("4000자를 넘는 본문은 -32602 오류로 거부한다", () => {
    assert.throws(
      () => normalizeStep(stateOf({ fields: { content: "a".repeat(4001), type: "fact" } })),
      (err) => err instanceof WriteInputError && err.code === -32602 && /exceeds max 4000/.test(err.message)
    );
  });

  it("생성은 본문 앞뒤 공백을 걷어 낸다", () => {
    const next = normalizeStep(stateOf({ fields: { content: "  공백이 있는 충분히 긴 본문  ", type: "fact" } }));
    assert.equal(next.fields.content, "공백이 있는 충분히 긴 본문");
  });

  it("생성은 빈 본문을 거부한다", () => {
    assert.throws(() => normalizeStep(stateOf({ fields: { content: "   ", type: "fact" } })), /Fragment content is required/);
  });

  it("생성은 최소 품질 미달 본문을 거부한다", () => {
    assert.throws(
      () => normalizeStep(stateOf({ fields: { content: "짧음", type: "fact" } })),
      (err) => err instanceof WriteInputError && err.code === undefined && /Content too short/.test(err.message)
    );
  });

  it("갱신은 본문을 다듬지 않고 키워드만 정규화한다", () => {
    const next = normalizeStep(stateOf({ op: "update", fields: { content: "  x  ", keywords: ["Redis", "PORT"] } }));
    assert.equal(next.fields.content, "  x  ");
    assert.deepEqual(next.fields.keywords, ["redis", "port"]);
  });

  it("입력 상태를 바꾸지 않는다", () => {
    const input = stateOf({ fields: { content: "  공백이 있는 충분히 긴 본문  ", type: "fact" } });
    normalizeStep(input);
    assert.equal(input.fields.content, "  공백이 있는 충분히 긴 본문  ");
  });
});

describe("sensitiveStep", () => {
  const table = [
    ["이메일",   "메일은 user@example.com 이다",               "[REDACTED_EMAIL]"],
    ["비밀번호", "password: hunter2 로 접속한다",              "[REDACTED_PWD]"],
    ["휴대전화", "담당자 번호 010-1234-5678 로 연락한다",     "[REDACTED_PHONE]"],
    ["API 키",   `키 sk-${"a".repeat(40)} 를 쓴다`,           "[REDACTED_API_KEY]"]
  ];
  for (const [label, content, marker] of table) {
    it(`${label} 원문을 표식으로 바꾼다`, () => {
      const next = sensitiveStep(stateOf({ fields: { content } }));
      assert.ok(next.fields.content.includes(marker), next.fields.content);
    });
  }

  it("본문이 없으면 상태를 그대로 돌려준다", () => {
    const state = stateOf({ op: "update", fields: { importance: 0.4 } });
    assert.equal(sensitiveStep(state), state);
  });
});

describe("lengthStep", () => {
  it("일반 유형은 300자에서 자른다", () => {
    const next = lengthStep(stateOf({ fields: { content: "a".repeat(350), type: "fact" } }));
    assert.equal(next.fields.content, `${"a".repeat(300)}...`);
  });

  it("episode는 1000자에서 자른다", () => {
    const next = lengthStep(stateOf({ fields: { content: "a".repeat(1200), type: "episode" } }));
    assert.equal(next.fields.content.length, 1003);
  });

  it("갱신에서 유형을 바꾸지 않으면 현재 행의 유형을 쓴다", () => {
    const next = lengthStep(stateOf({ op: "update", fields: { content: "a".repeat(1200) }, base: { type: "episode" } }));
    assert.equal(next.fields.content.length, 1003);
  });

  it("자른 결과를 다시 넣어도 같다", () => {
    const once  = lengthStep(stateOf({ fields: { content: "a".repeat(500), type: "fact" } }));
    const twice = lengthStep(once);
    assert.equal(twice.fields.content, once.fields.content);
  });
});

describe("policyStep", () => {
  const violating = { check: (f) => (f.type === "decision" ? [{ rule: "decisionHasRationale", severity: "medium" }] : []) };
  const deps      = (enabled, policyRules = violating) => ({ policyRules, policyGatingEnabled: () => enabled });

  it("정책 게이트가 꺼져 있으면 위반을 모으지 않는다", () => {
    const next = policyStep(stateOf({ draft: { type: "decision" } }), deps(false));
    assert.deepEqual(next.violations, []);
  });

  it("생성 후보의 위반을 모은다", () => {
    const next = policyStep(stateOf({ draft: { type: "decision" } }), deps(true));
    assert.deepEqual(next.violations.map(v => v.rule), ["decisionHasRationale"]);
  });

  it("갱신은 현재 행에 이미 있던 위반을 빼고 새 위반만 남긴다", () => {
    const kept = policyStep(stateOf({ op: "update", base: { type: "decision" }, draft: { type: "decision" } }), deps(true));
    assert.deepEqual(kept.violations, []);

    const fresh = policyStep(stateOf({ op: "update", base: { type: "fact" }, draft: { type: "decision" } }), deps(true));
    assert.deepEqual(fresh.violations.map(v => v.rule), ["decisionHasRationale"]);
  });

  it("평가 실패는 policyCheckFailed 위반이 된다", () => {
    const broken = { check: () => { throw new Error("boom"); } };
    const next   = policyStep(stateOf({ draft: { type: "fact" } }), deps(true, broken));
    assert.deepEqual(next.violations.map(v => v.rule), ["policyCheckFailed"]);
  });
});

describe("workspaceStep", () => {
  it("workspace를 바꾸지 않는 갱신은 판정하지 않는다", async () => {
    let called = false;
    const deps = { checkWorkspaceAllowed: async () => { called = true; return null; } };
    await workspaceStep(stateOf({ op: "update", fields: { content: "x" }, draft: { workspace: "w" } }), deps);
    assert.equal(called, false);
  });

  it("허가 집합 밖이면 위반을 모은다", async () => {
    const deps = { checkWorkspaceAllowed: async () => ({ rule: "workspaceNotAllowed", severity: "medium" }) };
    const next = await workspaceStep(stateOf({ draft: { workspace: "other" }, keyId: "k1" }), deps);
    assert.deepEqual(next.violations.map(v => v.rule), ["workspaceNotAllowed"]);
  });

  it("판정 실패는 workspace를 주장한 쓰기만 workspaceLookupFailed로 다룬다", async () => {
    const deps    = { checkWorkspaceAllowed: async () => { throw new Error("db down"); } };
    const claimed = await workspaceStep(stateOf({ draft: { workspace: "w" }, keyId: "k1" }), deps);
    assert.deepEqual(claimed.violations.map(v => v.rule), ["workspaceLookupFailed"]);

    const unclaimed = await workspaceStep(stateOf({ draft: { workspace: null }, keyId: "k1" }), deps);
    assert.deepEqual(unclaimed.violations, []);
  });
});

describe("anchorStep", () => {
  it("기본 구현은 상태를 그대로 돌려준다", () => {
    const state = stateOf({ draft: { is_anchor: true } });
    assert.equal(anchorStep(state), state);
  });
});

describe("isGateEligible", () => {
  afterEach(() => { delete process.env.MEMENTO_WORKSPACE_GATE; });

  it("workspace 정책 위반은 MEMENTO_WORKSPACE_GATE=true일 때만 대상이다", () => {
    assert.equal(isGateEligible({ rule: "workspaceNotAllowed" }), false);
    assert.equal(isGateEligible({ rule: "fragmentHasWorkspace" }), false);
    process.env.MEMENTO_WORKSPACE_GATE = "true";
    assert.equal(isGateEligible({ rule: "workspaceNotAllowed" }), true);
  });

  it("판정 실패와 구조 위반은 항상 대상이다", () => {
    assert.equal(isGateEligible({ rule: "workspaceLookupFailed" }), true);
    assert.equal(isGateEligible({ rule: "decisionHasRationale" }), true);
  });
});

describe("WriteGate.check", () => {
  beforeEach(() => { delete process.env.MEMENTO_WRITE_GATE; });
  afterEach(() => { delete process.env.MEMENTO_WRITE_GATE; });

  const decisionRule = { check: (f) => (f.type === "decision" ? [{ rule: "decisionHasRationale", severity: "medium" }] : []) };

  it("단계를 정해진 순서로 한 번씩 적용한다", async () => {
    const order = [];
    const steps = Object.fromEntries(STEP_ORDER.map(name => [name, (state) => { order.push(name); return state; }]));
    const gate  = new WriteGate({ steps });
    await gate.check({ entry: WRITE_ENTRIES.REMEMBER, op: "create", fields: { content: "x" }, build: (f) => ({ ...f }) });
    assert.deepEqual(order, [...STEP_ORDER]);
  });

  it("생성은 본문 단계를 마친 입력으로 build를 부른다", async () => {
    let built = null;
    const gate = new WriteGate();
    const out  = await gate.check({
      entry : WRITE_ENTRIES.REMEMBER,
      op    : "create",
      fields: { content: `  ${SECRET_CONTENT}  `, type: "fact", topic: "t" },
      build : (input) => { built = input; return { ...input, validation_warnings: [] }; }
    });
    assert.ok(!built.content.includes("user@example.com"));
    assert.ok(!built.content.includes("hunter2"));
    assert.ok(!built.content.includes("010-1234-5678"));
    assert.equal(out.draft.content, built.content);
    assert.deepEqual(out.warnings, []);
  });

  it("갱신은 현재 행에 바뀐 값을 겹친 후보를 판정한다", async () => {
    const gate = new WriteGate({ policyRules: decisionRule, policyGatingEnabled: true });
    const out  = await gate.check({
      entry : WRITE_ENTRIES.AMEND,
      op    : "update",
      fields: { type: "decision", content: SECRET_CONTENT },
      base  : { id: "f1", type: "fact", content: "기존 본문", workspace: "w" }
    });
    assert.equal(out.draft.id, "f1");
    assert.equal(out.draft.type, "decision");
    assert.ok(out.fields.content.includes("[REDACTED_EMAIL]"));
    assert.deepEqual(out.warnings, ["decisionHasRationale"]);
  });

  it("생성 위반은 후보의 validation_warnings에 쌓인다", async () => {
    const gate = new WriteGate({ policyRules: decisionRule, policyGatingEnabled: true });
    const out  = await gate.check({
      entry : WRITE_ENTRIES.BATCH,
      op    : "create",
      fields: { content: "결정 사항을 하나 적어 둔다", type: "decision", topic: "t" },
      build : (input) => ({ ...input, validation_warnings: [] })
    });
    assert.deepEqual(out.draft.validation_warnings.map(v => v.rule), ["decisionHasRationale"]);
  });

  it("dryRun은 위반 이름만 돌려주고 거부하지 않는다", async () => {
    const gate = new WriteGate({ policyRules: decisionRule, policyGatingEnabled: true, getHardGate: async () => true });
    const out  = await gate.check({
      entry : WRITE_ENTRIES.REMEMBER,
      op    : "create",
      mode  : "dryRun",
      ctx   : { keyId: "k1" },
      fields: { content: "결정 사항을 하나 적어 둔다", type: "decision", topic: "t" },
      build : (input) => ({ ...input, validation_warnings: [] })
    });
    assert.deepEqual(out.warnings, ["decisionHasRationale"]);
    assert.deepEqual(out.draft.validation_warnings, []);
  });

  it("hard gate 키의 위반은 SymbolicPolicyViolationError로 거부한다", async () => {
    const gate = new WriteGate({ policyRules: decisionRule, policyGatingEnabled: true, getHardGate: async () => true });
    await assert.rejects(
      () => gate.check({
        entry : WRITE_ENTRIES.AMEND,
        op    : "update",
        ctx   : { keyId: "k1" },
        fields: { type: "decision" },
        base  : { id: "f1", type: "fact", content: "기존 본문" }
      }),
      (err) => err.name === "SymbolicPolicyViolationError" && err.violations.includes("decisionHasRationale")
    );
  });

  it("hard gate 조회 실패는 hardGateLookupFailed로 거부한다", async () => {
    const gate = new WriteGate({
      policyRules        : decisionRule,
      policyGatingEnabled: true,
      getHardGate        : async () => { throw new Error("db down"); }
    });
    await assert.rejects(
      () => gate.check({
        entry : WRITE_ENTRIES.REMEMBER,
        op    : "create",
        ctx   : { keyId: "k1" },
        fields: { content: "결정 사항을 하나 적어 둔다", type: "decision", topic: "t" },
        build : (input) => ({ ...input })
      }),
      (err) => err.violations.includes("hardGateLookupFailed")
    );
  });

  it("마스터 키(keyId=null)는 위반이 있어도 거부하지 않는다", async () => {
    const gate = new WriteGate({ policyRules: decisionRule, policyGatingEnabled: true, getHardGate: async () => true });
    const out  = await gate.check({
      entry : WRITE_ENTRIES.CLI_REMEMBER,
      op    : "create",
      fields: { content: "결정 사항을 하나 적어 둔다", type: "decision", topic: "t" },
      build : (input) => ({ ...input })
    });
    assert.deepEqual(out.warnings, ["decisionHasRationale"]);
  });

  it("지정한 단계만 교체할 수 있다", async () => {
    const gate = new WriteGate({ steps: { sensitive: (state) => ({ ...state, fields: { ...state.fields, content: "교체된 마스킹 결과" } }) } });
    const out  = await gate.check({
      entry : WRITE_ENTRIES.REMEMBER,
      op    : "update",
      fields: { content: SECRET_CONTENT },
      base  : { type: "fact" }
    });
    assert.equal(out.fields.content, "교체된 마스킹 결과");
  });

  it("MEMENTO_WRITE_GATE=off이면 진입점별 기본 단계만 적용한다", async () => {
    process.env.MEMENTO_WRITE_GATE = "off";
    const gate = new WriteGate({ policyRules: decisionRule, policyGatingEnabled: true });

    const amended = await gate.check({
      entry : WRITE_ENTRIES.AMEND,
      op    : "update",
      fields: { content: SECRET_CONTENT, type: "decision" },
      base  : { type: "fact" }
    });
    assert.equal(amended.fields.content, SECRET_CONTENT);
    assert.deepEqual(amended.warnings, []);

    const remembered = await gate.check({
      entry : WRITE_ENTRIES.REMEMBER,
      op    : "create",
      fields: { content: SECRET_CONTENT, type: "decision", topic: "t" },
      build : (input) => ({ ...input })
    });
    assert.ok(remembered.fields.content.includes("[REDACTED_EMAIL]"));
    assert.deepEqual(remembered.warnings, ["decisionHasRationale"]);
  });

  it("기본 단계 표의 단계 이름은 모두 정의된 단계다", () => {
    for (const steps of Object.values(LEGACY_STEPS)) {
      for (const name of steps) assert.ok(STEP_ORDER.includes(name), name);
    }
  });
});
