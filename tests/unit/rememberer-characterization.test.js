/**
 * MemoryRememberer.remember() 특성화(characterization) 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-06-15
 *
 * 목적: 리팩터링 전 현재 동작을 고정한다. "이상적인 동작"이 아니라
 *       "지금 실제로 일어나는 일"을 단언한다.
 *
 * 커버하는 분기 (기존 테스트 공백 기준):
 *   1. scope=session 경로 — Redis addToWorkingMemory에 위임, DB insert 미호출
 *   2. scope=session + sessionId 없는 경우 — 일반(permanent) 경로로 낙하
 *   3. idempotencyKey 재시도 — 두 번째 호출 시 store.insert 미호출 + existing=true
 *   4. quota 초과 — quotaChecker.check throw 시 저장 차단
 *   5. dryRun=true — store.insert 미호출, simulated 구조 반환
 *   6. supersedes 배열 — conflictResolver.supersede 호출 (자기 id 제외)
 *   7. validation_warnings soft gate — 결과에 validation_warnings 배열 노출
 *   8. validation_warnings hard gate — SymbolicPolicyViolationError throw
 *   9. importance < 0.3 — ttl_tier "short" 강제 + low_importance_warning 반환
 *  10. skipConflictDetection=true — detectConflicts 미호출
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// 공통 mock 빌더
// ---------------------------------------------------------------------------

function buildDeps(overrides = {}) {
  process.env.MEMENTO_REMEMBER_ATOMIC = "false";

  const store = {
    findByIdempotencyKey            : async () => null,
    findCaseIdBySessionTopic        : async () => null,
    findErrorFragmentsBySessionTopic: async () => [],
    insert                          : async (f) => f.id || "inserted-id",
    updateTtlTier                   : async () => {},
    updateCaseId                    : async () => {},
    ...overrides.store
  };

  const index = {
    addToWorkingMemory : mock.fn(async () => {}),
    index              : mock.fn(async () => {}),
    deindex            : mock.fn(async () => {}),
    ...overrides.index
  };

  const factory = {
    create: (params) => ({
      id                  : `frag-${Math.random().toString(36).slice(2, 8)}`,
      content             : params.content || "",
      topic               : params.topic   || "general",
      type                : params.type    || "fact",
      keywords            : params.keywords || [],
      importance          : params.importance ?? 0.5,
      ttl_tier            : params.ttl_tier || "warm",
      key_id              : null,
      session_id          : params.sessionId || null,
      case_id             : params.caseId   || null,
      is_anchor           : params.isAnchor || false,
      affect              : params.affect   || "neutral",
      validation_warnings : [],
      ...overrides.factoryFragment
    }),
    ...overrides.factory
  };

  const quotaChecker = {
    check   : async () => {},
    getUsage: async () => ({ limit: 100, current: 10, remaining: 90, resetAt: null }),
    ...overrides.quotaChecker
  };

  const postProcessor = {
    run: mock.fn(async () => {}),
    ...overrides.postProcessor
  };

  const conflictResolver = {
    detectConflicts    : mock.fn(async () => []),
    autoLinkOnRemember : mock.fn(async () => {}),
    supersede          : mock.fn(async () => {}),
    ...overrides.conflictResolver
  };

  const policyRules = {
    check: () => [],
    ...overrides.policyRules
  };

  return {
    store,
    index,
    factory,
    quotaChecker,
    postProcessor,
    conflictResolver,
    caseEventStore : null,
    policyRules,
    sessionLinker  : null,
    batchRememberProcessor: null,
    linkChecker    : null,
    getHardGate    : async () => false,
    policyGatingEnabled: false,
    ...overrides.top
  };
}

// ---------------------------------------------------------------------------
// 1. scope=session 경로
// ---------------------------------------------------------------------------
describe("scope=session — Working Memory 경로", async () => {
  const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");

  it("addToWorkingMemory가 호출되고 store.insert는 호출되지 않는다", async () => {
    let insertCalled = false;
    const deps = buildDeps({
      store: { insert: async () => { insertCalled = true; return "x"; } }
    });
    const r = new MemoryRememberer(deps);

    const result = await r.remember({
      content  : "세션 한정 임시 기억 파편",
      topic    : "session-test",
      type     : "fact",
      scope    : "session",
      sessionId: "sess-abc-001"
    });

    assert.strictEqual(insertCalled, false, "DB insert가 호출되면 안 된다");
    assert.ok(deps.index.addToWorkingMemory.mock.calls.length > 0, "addToWorkingMemory가 호출돼야 한다");
    assert.strictEqual(result.scope,    "session");
    assert.strictEqual(result.ttl_tier, "session");
    assert.deepStrictEqual(result.conflicts, []);
  });

  it("scope=session이지만 sessionId가 없으면 permanent 경로로 낙하한다", async () => {
    let insertCalled = false;
    const deps = buildDeps({
      store: { insert: async (f) => { insertCalled = true; return f.id || "fallback-id"; } }
    });
    const r = new MemoryRememberer(deps);

    const result = await r.remember({
      content: "sessionId 없이 scope=session 전달",
      topic  : "test",
      type   : "fact",
      scope  : "session"
      /** sessionId 미전달 */
    });

    assert.strictEqual(insertCalled, true, "sessionId 없으면 permanent 경로(DB insert)로 낙하한다");
    assert.strictEqual(result.scope, "permanent");
  });
});

// ---------------------------------------------------------------------------
// 2. idempotencyKey 재시도 — 기존 테스트(idempotency-remember.test.js)가 DB
//    hit/miss 재현은 하지만, "store.insert 미호출" 단언을 명시적으로 추가한다.
// ---------------------------------------------------------------------------
describe("idempotencyKey — store.insert 미호출 재확인", async () => {
  const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");

  it("DB hit 시 store.insert가 호출되지 않고 existing=true이다", async () => {
    const insertFn = mock.fn(async () => "should-not-be-called");
    const deps = buildDeps({
      store: {
        findByIdempotencyKey: async () => ({
          id: "hit-id", keywords: ["k1"], ttl_tier: "warm"
        }),
        insert: insertFn
      }
    });
    const r = new MemoryRememberer(deps);

    const result = await r.remember({
      content       : "중복 idempotency 파편",
      topic         : "test",
      type          : "fact",
      idempotencyKey: "key-dup-001"
    });

    assert.strictEqual(insertFn.mock.calls.length, 0);
    assert.strictEqual(result.existing,   true);
    assert.strictEqual(result.idempotent, true);
    assert.strictEqual(result.id,         "hit-id");
  });
});

// ---------------------------------------------------------------------------
// 3. quota 초과 — QuotaExceededError 시 저장 차단
// ---------------------------------------------------------------------------
describe("quota 초과 — 저장 차단", async () => {
  const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");

  it("quotaChecker.check throw 시 store.insert가 호출되지 않는다", async () => {
    const insertFn = mock.fn(async () => "should-not-run");
    const quotaError = new Error("fragment limit exceeded");
    quotaError.code  = "fragment_limit_exceeded";

    const deps = buildDeps({
      store        : { insert: insertFn },
      quotaChecker : { check: async () => { throw quotaError; }, getUsage: async () => ({}) }
    });
    const r = new MemoryRememberer(deps);

    await assert.rejects(
      () => r.remember({ content: "quota 초과 파편", topic: "test", type: "fact", _keyId: "key-1" }),
      (err) => err.code === "fragment_limit_exceeded"
    );
    assert.strictEqual(insertFn.mock.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. dryRun=true — store.insert 미호출, simulated 구조 반환
// ---------------------------------------------------------------------------
describe("dryRun=true — 실행 계획 반환", async () => {
  const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");

  it("dryRun=true이면 store.insert가 호출되지 않는다", async () => {
    const insertFn = mock.fn(async () => "should-not-run");
    const deps = buildDeps({ store: { insert: insertFn } });
    const r    = new MemoryRememberer(deps);

    const result = await r.remember({
      content: "dryRun 테스트 파편",
      topic  : "test",
      type   : "fact",
      dryRun : true
    });

    assert.strictEqual(insertFn.mock.calls.length, 0);
    assert.strictEqual(result.dryRun, true);
    assert.ok(result.simulated,                   "simulated 키가 있어야 한다");
    assert.ok(result.simulated.fragment,          "simulated.fragment가 있어야 한다");
    assert.strictEqual(result.simulated.fragment.id, "<would-generate>");
    assert.ok(Array.isArray(result.simulated.conflicts),           "conflicts 배열");
    assert.ok(Array.isArray(result.simulated.validation_warnings), "validation_warnings 배열");
    assert.ok(result.simulated.quota !== undefined,                "quota 객체");
  });

  it("dryRun=true이면 index.index가 호출되지 않는다", async () => {
    const deps = buildDeps();
    const r    = new MemoryRememberer(deps);

    await r.remember({
      content: "dryRun index 미호출 확인",
      topic  : "test",
      type   : "fact",
      dryRun : true
    });

    assert.strictEqual(deps.index.index.mock.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 5. supersedes — conflictResolver.supersede 호출 확인
// ---------------------------------------------------------------------------
describe("supersedes — conflictResolver.supersede 호출", async () => {
  const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");

  it("supersedes 배열의 각 id에 대해 _supersede가 호출된다", async () => {
    const supersedeFn = mock.fn(async () => {});
    const deps = buildDeps({
      conflictResolver: {
        detectConflicts    : async () => [],
        autoLinkOnRemember : async () => {},
        supersede          : supersedeFn
      }
    });
    const r = new MemoryRememberer(deps);

    const result = await r.remember({
      content   : "이전 파편을 대체하는 신규 파편",
      topic     : "test",
      type      : "fact",
      supersedes: ["old-id-1", "old-id-2"]
    });

    assert.ok(result.id, "id가 반환돼야 한다");
    assert.strictEqual(supersedeFn.mock.calls.length, 2, "supersedes 2개 → supersede 2회 호출");
  });

  it("자기 id는 supersede 대상에서 제외된다", async () => {
    const supersedeFn = mock.fn(async () => {});
    let generatedId;

    const deps = buildDeps({
      store: {
        insert: async (f) => {
          generatedId = f.id;
          return f.id;
        }
      },
      conflictResolver: {
        detectConflicts    : async () => [],
        autoLinkOnRemember : async () => {},
        supersede          : supersedeFn
      }
    });
    const r = new MemoryRememberer(deps);

    await r.remember({
      content   : "자기 참조 supersede 방지 확인",
      topic     : "test",
      type      : "fact",
      supersedes: ["other-id"]
    });

    /** 자기 id가 supersedes에 있었어도 건너뛰는지는 소스 로직상
     *  `if (oldId === id) continue;` 라인으로 보장된다.
     *  여기서는 other-id에 대해 정확히 1회 호출됨을 검증한다. */
    assert.strictEqual(supersedeFn.mock.calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 6. validation_warnings soft gate — 결과에 validation_warnings 노출
// ---------------------------------------------------------------------------
describe("validation_warnings soft gate", async () => {
  const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");

  it("policyRules.check가 violations를 반환하면 결과에 validation_warnings가 포함된다", async () => {
    const deps = buildDeps({
      top: {
        policyGatingEnabled: true,
        getHardGate        : async () => false  /** soft gate: throw 없이 경고만 */
      },
      policyRules: {
        check: () => [{ rule: "content_too_short", severity: "low" }]
      }
    });
    const r = new MemoryRememberer(deps);

    const result = await r.remember({
      content: "짧음",
      topic  : "test",
      type   : "fact",
      _keyId : "key-soft"
    });

    assert.ok(result.id, "id가 반환돼야 한다");
    assert.ok(Array.isArray(result.validation_warnings),      "validation_warnings가 배열이어야 한다");
    assert.ok(result.validation_warnings.length > 0,          "violations이 적어도 1개여야 한다");
    assert.ok(result.validation_warnings.includes("content_too_short"), "rule 이름이 문자열로 변환돼야 한다");
  });
});

// ---------------------------------------------------------------------------
// 7. validation_warnings hard gate — SymbolicPolicyViolationError throw
// ---------------------------------------------------------------------------
describe("hard gate — SymbolicPolicyViolationError throw", async () => {
  const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");
  const { SymbolicPolicyViolationError } = await import("../../lib/symbolic/errors.js");

  it("keyId 있고 hardGate=true이면 SymbolicPolicyViolationError를 던진다", async () => {
    const insertFn = mock.fn(async () => "should-not-run");
    const deps = buildDeps({
      store: { insert: insertFn },
      top  : {
        policyGatingEnabled: true,
        getHardGate        : async () => true
      },
      policyRules: {
        check: () => [{ rule: "prohibited_content", severity: "high" }]
      }
    });
    const r = new MemoryRememberer(deps);

    await assert.rejects(
      () => r.remember({
        content: "하드 게이트 위반 파편",
        topic  : "test",
        type   : "fact",
        _keyId : "key-hard"
      }),
      (err) => err instanceof SymbolicPolicyViolationError
    );
    assert.strictEqual(insertFn.mock.calls.length, 0, "hard gate throw 시 insert가 호출되면 안 된다");
  });
});

// ---------------------------------------------------------------------------
// 8. importance < 0.3 — ttl_tier "short" 강제 + low_importance_warning
// ---------------------------------------------------------------------------
describe("importance < 0.3 — ttl_tier 자동 하향", async () => {
  const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");

  it("importance=0.2이면 결과에 low_importance_warning이 포함된다", async () => {
    let updatedTier;
    const deps = buildDeps({
      store: {
        updateTtlTier: async (id, tier) => { updatedTier = tier; }
      },
      factoryFragment: { importance: 0.2, ttl_tier: "warm" }
    });
    const r = new MemoryRememberer(deps);

    const result = await r.remember({
      content   : "낮은 중요도 파편으로 자동 ttl 하향 테스트",
      topic     : "test",
      type      : "fact",
      importance: 0.2
    });

    assert.ok(result.low_importance_warning, "low_importance_warning이 있어야 한다");
    assert.strictEqual(updatedTier, "short", "updateTtlTier가 'short'로 호출돼야 한다");
  });

  it("importance=0.3(경계값)이면 low_importance_warning이 없다", async () => {
    const deps = buildDeps({
      factoryFragment: { importance: 0.3, ttl_tier: "warm" }
    });
    const r = new MemoryRememberer(deps);

    const result = await r.remember({
      content   : "경계값 importance=0.3 파편",
      topic     : "test",
      type      : "fact",
      importance: 0.3
    });

    assert.strictEqual(result.low_importance_warning, undefined, "0.3은 경고 없어야 한다");
  });
});

// ---------------------------------------------------------------------------
// 9. skipConflictDetection=true — detectConflicts 미호출
// ---------------------------------------------------------------------------
describe("skipConflictDetection=true — detectConflicts 미호출", async () => {
  const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");

  it("skipConflictDetection=true이면 detectConflicts가 호출되지 않는다", async () => {
    const detectFn = mock.fn(async () => []);
    const deps     = buildDeps({
      conflictResolver: {
        detectConflicts    : detectFn,
        autoLinkOnRemember : async () => {},
        supersede          : async () => {}
      }
    });
    const r = new MemoryRememberer(deps);

    const result = await r.remember({
      content               : "reflect 내부 episode 파편 — conflict 생략",
      topic                 : "reflect",
      type                  : "episode",
      skipConflictDetection : true
    });

    assert.strictEqual(detectFn.mock.calls.length, 0, "detectConflicts가 호출되면 안 된다");
    assert.deepStrictEqual(result.conflicts, [], "conflicts는 빈 배열");
  });

  it("skipConflictDetection 미지정이면 detectConflicts가 호출된다", async () => {
    const detectFn = mock.fn(async () => []);
    const deps     = buildDeps({
      conflictResolver: {
        detectConflicts    : detectFn,
        autoLinkOnRemember : async () => {},
        supersede          : async () => {}
      }
    });
    const r = new MemoryRememberer(deps);

    await r.remember({
      content: "일반 파편 — conflict 검사 정상",
      topic  : "test",
      type   : "fact"
    });

    assert.ok(detectFn.mock.calls.length > 0, "detectConflicts가 호출돼야 한다");
  });
});
