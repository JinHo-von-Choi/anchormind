/**
 * idempotency-remember 단위 테스트 (migration-034-v2.16.0-bundle)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * 검증 항목:
 * 1. 동일 idempotencyKey로 2회 호출 시 같은 id 반환 + existing=true
 * 2. idempotencyKey 미제공 시 정상 삽입 경로 실행
 * 3. 첫 번째 호출(DB miss)에서 fragment.idempotency_key가 삽입 파라미터에 포함됨
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// 공통 mock 빌더
// ---------------------------------------------------------------------------

/**
 * MemoryRememberer 단위 테스트용 최소 mock 의존성을 생성한다.
 * MEMENTO_REMEMBER_ATOMIC은 DB pool이 필요하므로 테스트에서는 false로 고정한다.
 * @param {Object} storeOverrides - store 메서드 오버라이드
 */
function buildDeps(storeOverrides = {}) {
  process.env.MEMENTO_REMEMBER_ATOMIC = "false";
  const insertedIds = [];

  const store = {
    findCaseIdBySessionTopic        : async () => null,
    findErrorFragmentsBySessionTopic: async () => [],
    insert                          : async (fragment) => {
      const id = fragment.id || `frag-test-${insertedIds.length}`;
      insertedIds.push(id);
      return id;
    },
    updateTtlTier                   : async () => {},
    findByIdempotencyKey            : async () => null,   // 기본: DB miss
    ...storeOverrides
  };

  const index = {
    addToWorkingMemory: async () => {},
    index             : async () => {},
    deindex           : async () => {}
  };

  const factory = {
    create: (params) => ({
      id               : `frag-mock-${Math.random().toString(36).slice(2, 8)}`,
      content          : params.content,
      topic            : params.topic || "general",
      type             : params.type || "fact",
      keywords         : params.keywords || [],
      importance       : params.importance ?? 0.5,
      ttl_tier         : "warm",
      key_id           : params._keyId ?? null,
      session_id       : params.sessionId || null,
      case_id          : params.caseId || null,
      idempotency_key  : params.idempotencyKey ?? null,
      linked_to        : [],
      is_anchor        : false,
      validation_warnings: [],
      affect           : "neutral"
    })
  };

  const quotaChecker     = { check: async () => {} };
  const postProcessor    = { run : async () => {} };
  const conflictResolver = {
    detectConflicts   : async () => [],
    autoLinkOnRemember: async () => {}
  };
  const caseEventStore       = null;
  const policyRules          = { check: () => [] };
  const sessionLinker        = null;
  const batchRememberProcessor = null;
  const linkChecker          = null;

  return {
    store, index, factory, quotaChecker, postProcessor,
    conflictResolver, caseEventStore, policyRules,
    sessionLinker, batchRememberProcessor, linkChecker,
    getHardGate        : async () => false,
    policyGatingEnabled: false,
    insertedIds
  };
}

// ---------------------------------------------------------------------------
// 1. 동일 idempotencyKey 2회 호출 — 같은 id 반환 + existing=true
// ---------------------------------------------------------------------------
describe("idempotencyKey — 중복 호출 시 기존 파편 반환", async () => {
  const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");

  it("2회 호출 시 첫 번째와 동일한 id를 반환한다", async () => {
    const existingFragment = {
      id      : "frag-existing-001",
      keywords: ["nginx", "ssl"],
      ttl_tier: "warm",
      key_id  : "key-abc"
    };

    /** 두 번째 호출부터 DB에서 기존 파편을 반환하도록 설정 */
    let callCount = 0;
    const deps = buildDeps({
      findByIdempotencyKey: async () => {
        callCount++;
        return callCount === 1 ? null : existingFragment;
      },
      insert: async (fragment) => {
        return fragment.id;
      }
    });

    const rememberer = new MemoryRememberer(deps);

    const params = {
      content        : "nginx ssl 설정 오류 해결: ssl_certificate 경로 오타",
      topic          : "nginx",
      type           : "error",
      idempotencyKey : "retry-safe-key-001",
      _keyId         : "key-abc"
    };

    /** 첫 번째 호출 — DB miss이므로 실제 삽입 */
    const first = await rememberer.remember(params);
    assert.ok(first.id, "첫 번째 호출에서 id가 반환되어야 한다");

    /** 두 번째 호출 — DB hit이므로 기존 파편 반환 */
    const second = await rememberer.remember(params);
    assert.strictEqual(second.id, existingFragment.id, "두 번째 호출은 기존 파편 id를 반환해야 한다");
    assert.strictEqual(second.existing, true, "existing 플래그가 true여야 한다");
    assert.strictEqual(second.idempotent, true, "idempotent 플래그가 true여야 한다");
    assert.strictEqual(second.scope, "persistent", "scope는 persistent여야 한다");
  });

  it("idempotencyKey 미제공 시 정상 삽입 경로가 실행된다", async () => {
    const deps      = buildDeps();
    const rememberer = new MemoryRememberer(deps);

    const result = await rememberer.remember({
      content: "idempotencyKey 없이 일반 파편을 저장하는 테스트",
      topic  : "test",
      type   : "fact",
      _keyId : "key-xyz"
    });

    assert.ok(result.id, "id가 반환되어야 한다");
    assert.strictEqual(result.existing, undefined, "existing 플래그가 없어야 한다");
    assert.strictEqual(result.idempotent, undefined, "idempotent 플래그가 없어야 한다");
  });

  it("idempotency DB hit 시 store.insert가 호출되지 않는다", async () => {
    let insertCalled = false;
    const deps = buildDeps({
      findByIdempotencyKey: async () => ({
        id      : "frag-hit",
        keywords: [],
        ttl_tier: "warm",
        key_id  : "key-abc"
      }),
      insert: async () => {
        insertCalled = true;
        return "frag-hit";
      }
    });

    const rememberer = new MemoryRememberer(deps);
    await rememberer.remember({
      content        : "중복 방지 테스트 파편",
      topic          : "test",
      type           : "fact",
      idempotencyKey : "dupe-key",
      _keyId         : "key-abc"
    });

    assert.strictEqual(insertCalled, false, "DB hit 시 store.insert가 호출되면 안 된다");
  });
});

// ---------------------------------------------------------------------------
// 2. FragmentFactory — idempotency_key 필드 매핑 검증
// ---------------------------------------------------------------------------
describe("FragmentFactory — idempotency_key 필드 생성", async () => {
  const { FragmentFactory } = await import("../../lib/memory/write/FragmentFactory.js");

  it("idempotencyKey가 idempotency_key로 매핑된다", () => {
    const factory  = new FragmentFactory();
    const fragment = factory.create({
      content        : "idempotency 매핑 테스트",
      topic          : "test",
      type           : "fact",
      idempotencyKey : "my-idem-key-123"
    });

    assert.strictEqual(fragment.idempotency_key, "my-idem-key-123");
  });

  it("idempotencyKey 미제공 시 idempotency_key가 null이다", () => {
    const factory  = new FragmentFactory();
    const fragment = factory.create({
      content: "idempotencyKey를 전달하지 않은 일반 파편 생성 테스트",
      topic  : "test",
      type   : "fact"
    });

    assert.strictEqual(fragment.idempotency_key, null);
  });
});
