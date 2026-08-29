/**
 * tests/unit/dry-run-tools.test.js
 *
 * M5: remember / link / forget / amend dryRun 파라미터 동작 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

/** 공통 mock 팩토리 */
function makeRememberer(overrides = {}) {
  overrides._class ?? {};
  const store = {
    getById                       : mock.fn(async () => null),
    findByIdempotencyKey          : mock.fn(async () => null),
    findCaseIdBySessionTopic      : mock.fn(async () => null),
    findErrorFragmentsBySessionTopic: mock.fn(async () => []),
    insert                        : mock.fn(async () => "inserted-id"),
    update                        : mock.fn(async () => ({})),
    delete                        : mock.fn(async () => true),
    deleteMany                    : mock.fn(async () => 0),
    updateTtlTier                 : mock.fn(async () => {}),
    updateCaseId                  : mock.fn(async () => {}),
    searchByTopic                 : mock.fn(async () => []),
    writer                        : { insert: mock.fn(async () => "atomic-id") }
  };
  const index = {
    addToWorkingMemory : mock.fn(async () => {}),
    index              : mock.fn(async () => {}),
    deindex            : mock.fn(async () => {})
  };
  const factory = {
    create: mock.fn((params) => ({
      id         : "factory-gen-id",
      type       : params.type || "fact",
      content    : params.content || "",
      keywords   : params.keywords || [],
      importance : params.importance || 0.5,
      ttl_tier   : "medium",
      case_id    : params.caseId || null,
      topic      : params.topic || "test"
    }))
  };
  const quotaChecker = {
    check   : mock.fn(async () => {}),
    getUsage: mock.fn(async () => ({ limit: 100, current: 10, remaining: 90, resetAt: null }))
  };
  const postProcessor    = { run: mock.fn(async () => {}) };
  const conflictResolver = {
    detectConflicts    : mock.fn(async () => []),
    autoLinkOnRemember : mock.fn(async () => {}),
    supersede          : mock.fn(async () => {})
  };
  const caseEventStore   = null;
  const policyRules      = { check: mock.fn(() => []) };
  const sessionLinker    = null;
  const batchRememberProcessor = null;
  const linkChecker      = null;
  const getHardGate      = mock.fn(async () => false);

  return {
    store, index, factory, quotaChecker, postProcessor,
    conflictResolver, caseEventStore, policyRules,
    sessionLinker, batchRememberProcessor, linkChecker, getHardGate,
    policyGatingEnabled: false
  };
}

describe("dryRun: remember", () => {
  it("dryRun=true 시 파편 생성 없이 simulated 반환", async () => {
    const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");
    const deps = makeRememberer();
    const rememberer = new MemoryRememberer(deps);

    const result = await rememberer.remember({
      content   : "테스트 내용",
      topic     : "test",
      type      : "fact",
      dryRun    : true,
      _keyId    : "key-123"
    });

    assert.equal(result.dryRun, true);
    assert.ok(result.simulated, "simulated 필드 필수");
    assert.equal(result.simulated.fragment.id, "<would-generate>");
    assert.equal(deps.store.insert.mock.calls.length, 0, "store.insert 호출 금지");
    assert.equal(deps.index.index.mock.calls.length,  0, "index.index 호출 금지");
    assert.equal(deps.postProcessor.run.mock.calls.length, 0, "postProcessor.run 호출 금지");
  });

  it("dryRun=false(기본값)이면 정상 경로 실행 — store.insert 호출", async () => {
    const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");
    const deps = makeRememberer();
    const rememberer = new MemoryRememberer(deps);

    /**
     * MEMENTO_REMEMBER_ATOMIC=true 환경에서 keyId가 있으면 _rememberAtomic 경로로
     * 진입하여 실제 DB pool이 필요해진다. master key(_keyId=null)는 atomic 경로를
     * 건너뛰므로(!(atomicRemember && keyId) 가드) store.insert가 정상 호출된다.
     */
    await rememberer.remember({
      content: "실제 저장 내용",
      topic  : "test",
      type   : "fact",
      _keyId : null
    });

    assert.ok(deps.store.insert.mock.calls.length >= 1, "store.insert 호출 필수");
  });
});

describe("dryRun: link", () => {
  it("dryRun=true 시 createLink 호출 안 함", async () => {
    const { MemoryLinker } = await import("../../lib/memory/processors/MemoryLinker.js");

    const mockFrag = { id: "a", type: "fact", content: "c", key_id: "k", importance: 0.7 };
    const store = {
      getById   : mock.fn(async () => mockFrag),
      createLink: mock.fn(async () => {}),
      update    : mock.fn(async () => ({}))
    };
    const linker = new MemoryLinker({ store, index: {} });

    const result = await linker.link({
      fromId: "a", toId: "b", relationType: "related",
      dryRun: true, _keyId: "k"
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.simulated.would_link, true);
    assert.equal(store.createLink.mock.calls.length, 0, "createLink 호출 금지");
  });
});

describe("dryRun: forget", () => {
  it("dryRun=true 시 삭제 없이 simulated 반환", async () => {
    const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");
    const deps = makeRememberer();

    const targetFrag = {
      id: "frag-1", type: "fact", content: "지울 내용", ttl_tier: "medium",
      linked_to: ["link-a", "link-b"], key_id: "key-123"
    };
    deps.store.getById = mock.fn(async () => targetFrag);

    const rememberer = new MemoryRememberer(deps);
    const result = await rememberer.forget({ id: "frag-1", dryRun: true, _keyId: "key-123" });

    assert.equal(result.dryRun, true);
    assert.equal(result.simulated.fragment.id, "frag-1");
    assert.equal(result.simulated.linked_count, 2);
    assert.equal(result.simulated.would_delete, true);
    assert.equal(deps.store.delete.mock.calls.length, 0, "store.delete 호출 금지");
  });
});

describe("dryRun: amend", () => {
  it("dryRun=true 시 UPDATE 없이 would-be 파편 반환", async () => {
    const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");
    const deps = makeRememberer();

    const existingFrag = {
      id: "frag-2", type: "fact", content: "원본", topic: "test",
      keywords: ["old"], importance: 0.5, is_anchor: false,
      assertion_status: "observed", key_id: "key-123"
    };
    deps.store.getById = mock.fn(async () => existingFrag);

    const rememberer = new MemoryRememberer(deps);
    const result = await rememberer.amend({
      id      : "frag-2",
      content : "수정된 내용",
      dryRun  : true,
      _keyId  : "key-123"
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.simulated.would_be_fragment.content, "수정된 내용");
    assert.equal(deps.store.update.mock.calls.length, 0, "store.update 호출 금지");
  });
});
