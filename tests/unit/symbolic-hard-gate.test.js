/**
 * Symbolic Hard Gate 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-16
 *
 * 4 케이스:
 * 1. soft gate (default false) — violations 누적, save 허용
 * 2. hard gate true — violations 시 throw (SymbolicPolicyViolationError)
 * 3. master key (keyId=null) — hard gate 무시, save 허용
 * 4. apiKeyStore 조회 실패 → fail-closed (위반이 있으면 save 거부)
 * 5. 위반이 없으면 조회 실패와 무관하게 save 허용
 * 6. policy rules 평가 실패 → hard gate 키는 거부, soft 키는 경고로 저장
 *
 * 실제 DB 의존성 없이 순수 단위 테스트.
 * SYMBOLIC_CONFIG.freeze 문제는 MemoryManager._policyGatingEnabled 인스턴스 프로퍼티로 우회.
 */

import { describe, it } from "node:test";
import assert            from "node:assert/strict";

/** 감사 이벤트 기록은 이 시험의 대상이 아니다. DB에 연결하지 않도록 끈다 */
process.env.MEMENTO_AUDIT_DB = "off";

/**
 * policy rules 검사가 활성화된 상태에서 내부 컴포넌트를 stub한
 * MemoryManager 인스턴스를 반환한다.
 *
 * @param {{ symbolicHardGate?: boolean, throwOnLookup?: boolean, throwOnPolicy?: boolean }} opts
 * @returns {Promise<import("../../lib/memory/MemoryManager.js").MemoryManager>}
 */
async function makeManager(opts = {}) {
  const { MemoryManager } = await import("../../lib/memory/MemoryManager.js");

  /**
   * lib/config.js가 dotenv/config를 import하며 .env의 MEMENTO_REMEMBER_ATOMIC=true가
   * 단위 테스트로 유출될 수 있다. 이 스위트의 관심사는 symbolic hard/soft gate이지
   * atomic remember 경로가 아니므로, MemoryManager.remember 호출 직전 런타임으로 차단한다.
   * (R12 TDZ 핫픽스 이후 atomic 분기가 복구되며 stub 누락 간섭이 표면화됨)
   */
  delete process.env.MEMENTO_REMEMBER_ATOMIC;

  const mm = new MemoryManager();

  /** SYMBOLIC_CONFIG frozen 우회 — 인스턴스 레벨 플래그로 policy 활성화 */
  mm._policyGatingEnabled = true;

  /** PolicyRules.check stub — decision 파편에 위반 하나를 항상 반환 */
  mm.policyRules = {
    check(fragment) {
      if (opts.throwOnPolicy) throw new Error("policy engine failure (simulated)");
      if (fragment.type === "decision") {
        return [{ rule: "decisionHasRationale", severity: "medium", detail: "test violation", ruleVersion: "v1" }];
      }
      return [];
    }
  };

  /** QuotaChecker stub — 항상 통과 */
  mm.quotaChecker = { check: async () => {} };

  /** FragmentFactory stub — 최소 fragment 반환 */
  mm.factory = {
    create(params) {
      return {
        id                  : undefined,
        type                : params.type ?? "fact",
        content             : params.content ?? "",
        validation_warnings : [],
        key_id              : params._keyId ?? null,
        agent_id            : "default",
        workspace           : null,
        linked_to           : params.linkedTo ?? []
      };
    }
  };

  /** FragmentStore stub — insert는 UUID 반환, 실제 DB 미사용 */
  let savedFragment = null;
  mm.store = {
    insert                          : async (fragment) => { savedFragment = fragment; return "test-fragment-id"; },
    findCaseIdBySessionTopic        : async () => null,
    findErrorFragmentsBySessionTopic: async () => [],
    links                           : { createLink: async () => {} }
  };

  /** FragmentIndex stub */
  mm.index = {
    index             : async () => {},
    addToWorkingMemory: async () => {}
  };

  /** RememberPostProcessor stub */
  mm.postProcessor = { run: async () => {} };

  /** ConflictResolver stub */
  mm.conflictResolver = {
    detectConflicts   : async () => [],
    autoLinkOnRemember: async () => {}
  };

  /** _getHardGate mock — opts로 동작 제어 */
  if (opts.throwOnLookup) {
    mm._getHardGate = async () => { throw new Error("DB connection error (simulated)"); };
  } else {
    const gateValue = Boolean(opts.symbolicHardGate);
    mm._getHardGate = async () => gateValue;
  }

  mm._getSavedFragment = () => savedFragment;
  return mm;
}

describe("Symbolic Hard Gate", () => {

  it("soft gate (default false) — violations 누적, save 허용", async () => {
    const mm     = await makeManager({ symbolicHardGate: false });
    const result = await mm.remember({ content: "bad decision", type: "decision", _keyId: "key-001" });

    assert.ok(result.id, "저장된 id가 반환되어야 한다");
    const saved = mm._getSavedFragment();
    assert.ok(Array.isArray(saved.validation_warnings), "validation_warnings는 배열이어야 한다");
    assert.ok(
      saved.validation_warnings.some(v => v.rule === "decisionHasRationale"),
      "decisionHasRationale 위반이 누적되어야 한다"
    );
  });

  it("hard gate true — violations 시 SymbolicPolicyViolationError throw", async () => {
    const mm = await makeManager({ symbolicHardGate: true });

    await assert.rejects(
      () => mm.remember({ content: "bad decision", type: "decision", _keyId: "key-002" }),
      (err) => {
        assert.strictEqual(err.name, "SymbolicPolicyViolationError", "에러 name이 SymbolicPolicyViolationError여야 한다");
        assert.match(err.message, /policy_violation/, "메시지에 policy_violation이 포함되어야 한다");
        assert.ok(Array.isArray(err.violations) && err.violations.length > 0, "violations 배열이 비어있지 않아야 한다");
        assert.ok(err.violations.includes("decisionHasRationale"), "decisionHasRationale이 violations에 포함되어야 한다");
        return true;
      }
    );

    /** store.insert가 호출되지 않았음을 검증 */
    assert.strictEqual(mm._getSavedFragment(), null, "hard gate 위반 시 store.insert가 호출되지 않아야 한다");
  });

  it("master key (keyId=null) — hard gate 무시, save 허용", async () => {
    const mm     = await makeManager({ symbolicHardGate: true /* 무시되어야 함 */ });
    const result = await mm.remember({ content: "bad decision", type: "decision", _keyId: null });

    assert.ok(result.id, "마스터 키는 hard gate에 관계없이 저장되어야 한다");
  });

  it("apiKeyStore 조회 실패 → fail-closed (위반이 있으면 save 거부)", async () => {
    const mm = await makeManager({ throwOnLookup: true });

    await assert.rejects(
      () => mm.remember({ content: "bad decision", type: "decision", _keyId: "key-003" }),
      (err) => {
        assert.strictEqual(err.name, "SymbolicPolicyViolationError");
        assert.ok(err.violations.includes("hardGateLookupFailed"), "hardGateLookupFailed가 violations에 포함되어야 한다");
        return true;
      }
    );
    assert.strictEqual(mm._getSavedFragment(), null, "조회 실패 시 store.insert가 호출되지 않아야 한다");
  });

  it("위반이 없으면 조회 실패와 무관하게 save 허용", async () => {
    const mm     = await makeManager({ throwOnLookup: true });
    const result = await mm.remember({ content: "plain fact", type: "fact", _keyId: "key-004" });

    assert.ok(result.id, "위반이 없으면 hard gate를 조회하지 않으므로 저장되어야 한다");
  });

  it("policy rules 평가 실패 + hard gate 키 → save 거부", async () => {
    const mm = await makeManager({ symbolicHardGate: true, throwOnPolicy: true });

    await assert.rejects(
      () => mm.remember({ content: "plain fact", type: "fact", _keyId: "key-005" }),
      (err) => err.name === "SymbolicPolicyViolationError" && err.violations.includes("policyCheckFailed")
    );
    assert.strictEqual(mm._getSavedFragment(), null);
  });

  it("policy rules 평가 실패 + soft gate 키 → 경고로 기록하고 save 허용", async () => {
    const mm     = await makeManager({ symbolicHardGate: false, throwOnPolicy: true });
    const result = await mm.remember({ content: "plain fact", type: "fact", _keyId: "key-006" });

    assert.ok(result.id);
    assert.ok(mm._getSavedFragment().validation_warnings.some(v => v.rule === "policyCheckFailed"));
  });

});
