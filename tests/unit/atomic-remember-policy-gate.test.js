/**
 * Atomic Remember + PolicyRules Hard Gate 회귀 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-05-13
 *
 * MEMENTO_REMEMBER_ATOMIC=true 경로에서 PolicyRules hard gate가 우회되던 버그의 회귀 가드.
 * remember() 본문이 atomic 분기 진입 이전에 _runPolicyGate를 호출하므로,
 * hard gate 키에서는 _rememberAtomic 트랜잭션을 시작하지 않고 throw해야 한다.
 *
 * 5 케이스:
 * 1. atomic + hard gate true + 위반 → SymbolicPolicyViolationError throw, _rememberAtomic 미호출
 * 2. atomic + hard gate false + 위반 → _rememberAtomic 호출, fragment.validation_warnings 누적
 * 3. atomic + hard gate true + 정상 fragment → _rememberAtomic 정상 호출
 * 4. atomic + master key(keyId=null) → atomic 분기 진입 자체가 skip (기존 동작)
 * 5. atomic + dryRun + 위반 → simulated.validation_warnings 노출
 */

import { describe, it } from "node:test";
import assert            from "node:assert/strict";

/** 감사 이벤트 기록은 이 시험의 대상이 아니다. DB에 연결하지 않도록 끈다 */
process.env.MEMENTO_AUDIT_DB = "off";

async function makeManager(opts = {}) {
  const { MemoryManager } = await import("../../lib/memory/MemoryManager.js");

  /** atomic 분기를 강제 활성화 */
  process.env.MEMENTO_REMEMBER_ATOMIC = "true";

  const mm = new MemoryManager();

  mm._policyGatingEnabled = true;

  mm.policyRules = {
    check(fragment) {
      if (fragment.type === "decision") {
        return [{ rule: "decisionHasRationale", severity: "medium", detail: "test violation", ruleVersion: "v1" }];
      }
      return [];
    }
  };

  mm.quotaChecker = {
    check  : async () => {},
    getUsage: async () => ({ limit: null, current: 0, remaining: null, resetAt: null })
  };

  mm.factory = {
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
        workspace           : null,
        linked_to           : params.linkedTo ?? []
      };
    }
  };

  let savedFragment = null;
  let atomicInvoked = false;
  let atomicFragment = null;

  mm.store = {
    insert                          : async (fragment) => { savedFragment = fragment; return "test-fragment-id"; },
    findCaseIdBySessionTopic        : async () => null,
    findErrorFragmentsBySessionTopic: async () => [],
    findByIdempotencyKey            : async () => null,
    links                           : { createLink: async () => {} }
  };

  mm.index = {
    index             : async () => {},
    addToWorkingMemory: async () => {}
  };

  mm.postProcessor    = { run: async () => {} };
  mm.conflictResolver = {
    detectConflicts   : async () => [],
    autoLinkOnRemember: async () => {}
  };

  /**
   * _rememberAtomic stub — 진입 여부와 fragment 상태를 캡처한다.
   * MemoryManager의 setter facade 라우팅이 적용되지 않는 내부 메서드라
   * 실제 MemoryRememberer 인스턴스(mm.rememberer)에 직접 할당한다.
   */
  mm.rememberer._rememberAtomic = async (fragment) => {
    atomicInvoked  = true;
    atomicFragment = fragment;
    return {
      id       : "atomic-fragment-id",
      keywords : fragment.keywords,
      ttl_tier : fragment.ttl_tier ?? "permanent",
      scope    : "persistent",
      conflicts: []
    };
  };

  if (opts.throwOnLookup) {
    mm._getHardGate = async () => { throw new Error("DB connection error (simulated)"); };
  } else {
    const gateValue = Boolean(opts.symbolicHardGate);
    mm._getHardGate = async () => gateValue;
  }

  mm._getAtomicState   = () => ({ invoked: atomicInvoked, fragment: atomicFragment });
  mm._getSavedFragment = () => savedFragment;
  return mm;
}

describe("Atomic Remember + Policy Gate", () => {

  it("atomic + hard gate true + 위반 → throw하고 _rememberAtomic 미호출", async () => {
    const mm = await makeManager({ symbolicHardGate: true });

    await assert.rejects(
      () => mm.remember({ content: "bad decision", type: "decision", _keyId: "key-atomic-001" }),
      (err) => {
        assert.strictEqual(err.name, "SymbolicPolicyViolationError");
        assert.ok(err.violations.includes("decisionHasRationale"));
        return true;
      }
    );

    const state = mm._getAtomicState();
    assert.strictEqual(state.invoked, false, "_rememberAtomic이 호출되어선 안 된다");
    assert.strictEqual(mm._getSavedFragment(), null, "store.insert도 호출되어선 안 된다");
  });

  it("atomic + hard gate false + 위반 → _rememberAtomic 호출되고 validation_warnings 누적", async () => {
    const mm     = await makeManager({ symbolicHardGate: false });
    const result = await mm.remember({ content: "bad decision", type: "decision", _keyId: "key-atomic-002" });

    assert.strictEqual(result.id, "atomic-fragment-id", "atomic 경로 반환값이어야 한다");

    const state = mm._getAtomicState();
    assert.strictEqual(state.invoked, true, "_rememberAtomic이 호출되어야 한다");
    assert.ok(Array.isArray(state.fragment.validation_warnings), "validation_warnings가 누적되어야 한다");
    assert.ok(
      state.fragment.validation_warnings.some(v => v.rule === "decisionHasRationale"),
      "decisionHasRationale 위반이 fragment에 실려야 한다"
    );
  });

  it("atomic + hard gate true + 정상 fragment → _rememberAtomic 정상 호출", async () => {
    const mm     = await makeManager({ symbolicHardGate: true });
    const result = await mm.remember({ content: "ok fact recorded here", type: "fact", _keyId: "key-atomic-003" });

    assert.strictEqual(result.id, "atomic-fragment-id");
    const state = mm._getAtomicState();
    assert.strictEqual(state.invoked, true);
    assert.deepStrictEqual(state.fragment.validation_warnings, [], "위반 없으면 빈 배열이어야 한다");
  });

  it("atomic + master key(keyId=null) → atomic 분기 skip, soft만 적용", async () => {
    const mm     = await makeManager({ symbolicHardGate: true });
    const result = await mm.remember({ content: "bad decision", type: "decision", _keyId: null });

    assert.ok(result.id, "마스터 키는 hard gate에 관계없이 저장된다");
    const state = mm._getAtomicState();
    assert.strictEqual(state.invoked, false, "keyId가 null이면 atomic 분기 자체가 skip된다");
  });

  it("atomic + dryRun + 위반 → simulated.validation_warnings 노출", async () => {
    const mm  = await makeManager({ symbolicHardGate: true });
    const res = await mm.remember({
      content : "bad decision",
      type    : "decision",
      _keyId  : "key-atomic-005",
      dryRun  : true
    });

    assert.strictEqual(res.dryRun, true);
    assert.ok(Array.isArray(res.simulated.validation_warnings));
    assert.ok(
      res.simulated.validation_warnings.includes("decisionHasRationale"),
      "dryRun 응답에 정책 위반이 노출되어야 한다"
    );
    const state = mm._getAtomicState();
    assert.strictEqual(state.invoked, false, "dryRun은 atomic 분기를 호출하지 않는다");
  });

});
