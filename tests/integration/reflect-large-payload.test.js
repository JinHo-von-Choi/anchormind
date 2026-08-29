/**
 * R12 회귀 통합 테스트 — reflect 큰 페이로드 TDZ 회귀 가드
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * 배경 (docs/plans/2026-04-19-tech-debt-audit.md R12):
 *   v2.9.0에서 MemoryManager.remember 본문의 atomic 분기가 const fragment
 *   선언보다 앞에 놓여 MEMENTO_REMEMBER_ATOMIC=true && keyId != null 경로에서
 *   `ReferenceError: Cannot access 'fragment' before initialization`.
 *   재현 조건: 다건 summary + 긴 narrative_summary를 포함한 reflect 페이로드.
 *
 *   v2.10.1 핫픽스(commit 21c903c)로 atomic 분기를 fragment 생성 뒤로 이동,
 *   quotaChecker.check을 !(atomicRemember && keyId) 가드로 감쌌다.
 *
 * 이 테스트는 ReflectProcessor.process → MemoryRememberer.remember 경로를
 * atomic 환경에서 실행하여 ReferenceError 없이 완료되는지 검증한다.
 * 실제 DB/Redis를 요구하지 않고 모든 mutation 지점을 stub으로 격리한다.
 */

import "./_cleanup.js";
import { describe, it, before, after, mock } from "node:test";
import assert                          from "node:assert/strict";

/**
 * atomic 경로는 getPrimaryPool()을 모듈에서 직접 부른다. 이 시험은 TDZ 회귀
 * 가드이며 실제 DB를 필요로 하지 않는다고 선언하고 있으므로, 커넥션 획득도
 * 대역으로 막아 선언과 구현을 맞춘다.
 */
const stubClient = {
  query  : async () => ({ rows: [], rowCount: 0 }),
  release: () => {}
};
mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool      : () => ({ connect: async () => stubClient, query: stubClient.query }),
    getBatchPool        : () => ({ connect: async () => stubClient, query: stubClient.query }),
    queryWithAgentVector: async () => ({ rows: [], rowCount: 0 }),
    withTransaction     : async (fn) => fn(stubClient)
  }
});

describe("R12 reflect 큰 페이로드 TDZ 회귀 가드", () => {
  let prevAtomic;

  before(() => {
    prevAtomic = process.env.MEMENTO_REMEMBER_ATOMIC;
    process.env.MEMENTO_REMEMBER_ATOMIC = "true";
  });

  after(() => {
    if (prevAtomic === undefined) delete process.env.MEMENTO_REMEMBER_ATOMIC;
    else                           process.env.MEMENTO_REMEMBER_ATOMIC = prevAtomic;
  });

  it("summary 10건 + narrative 300자 페이로드가 atomic + keyId 경로에서 ReferenceError 없이 완료된다", async () => {
    const { MemoryManager } = await import("../../lib/memory/MemoryManager.js");
    const mm                 = new MemoryManager();

    /** 공유 의존성 최소 stub — facade setter가 모든 프로세서에 자동 전파한다. */
    mm.factory = {
      create: (p) => ({
        id                  : undefined,
        type                : p.type ?? "fact",
        content             : p.content ?? "",
        topic               : p.topic ?? null,
        keywords            : p.keywords ?? [],
        importance          : p.importance ?? 0.5,
        ttl_tier            : p.ttl_tier ?? "medium",
        validation_warnings : [],
        key_id              : p._keyId ?? null,
        agent_id            : "default",
        workspace           : null,
        case_id             : p.caseId ?? null,
        session_id          : p.sessionId ?? null
      })
    };

    let insertedCount = 0;
    mm.store = {
      insert                          : async () => { insertedCount += 1; return `stub-${insertedCount}`; },
      findCaseIdBySessionTopic        : async () => null,
      findErrorFragmentsBySessionTopic: async () => [],
      findByIdempotencyKey            : async () => null,
      updateTtlTier                   : async () => {},
      updateImportance                : async () => {},
      updateCaseId                    : async () => {},
      touchLinked                     : async () => {},
      links                           : { createLink: async () => {} },
      writer                          : { insert: async () => `stub-writer-${++insertedCount}` }
    };

    mm.index             = { index: async () => {}, addToWorkingMemory: async () => {} };
    mm.postProcessor     = { run: async () => {} };
    mm.conflictResolver  = {
      detectConflicts   : async () => [],
      autoLinkOnRemember: async () => {},
      supersede         : async () => {}
    };
    mm.quotaChecker      = { check: async () => {}, getUsage: async () => ({ limit: null, current: 0, remaining: null, resetAt: null }) };
    mm.sessionLinker     = {
      consolidateSessionFragments  : async () => null,
      autoLinkSessionFragments     : async () => {},
      wouldCreateCycle             : async () => false
    };
    mm.caseEventStore    = { append: async () => {}, recordEvent: async () => {} };

    /**
     * Phase 1 변경: ReflectProcessor가 batchRememberProcessor를 통해 INSERT하므로
     * 실제 DB pool 없이 동작하도록 batchRememberProcessor를 stub으로 교체한다.
     * stub은 입력 fragments 수만큼 성공 결과를 반환한다.
     */
    let batchCallCount = 0;
    mm.reflectProcessor.batchRememberProcessor = {
      process: async ({ fragments: frags }) => {
        batchCallCount++;
        const results = frags.map((_, i) => ({ index: i, id: `stub-batch-${batchCallCount}-${i}`, success: true }));
        return { results, inserted: frags.length, skipped: 0 };
      }
    };

    const summary = Array.from({ length: 10 }, (_, i) => `원자 사실 ${i + 1}. 이 문장은 reflect 큰 페이로드 재현 시나리오의 구성원이다.`);
    const narrativeSummary = "이 세션은 reflect 큰 페이로드 재현을 위한 통합 테스트 흐름이다. ".repeat(12).slice(0, 600);

    const params = {
      summary,
      decisions          : ["원격 서버 배포 결정", "회귀 가드 추가"],
      errors_resolved    : ["원인: atomic 분기 선행 참조 -> 해결: fragment 생성 뒤로 이동"],
      new_procedures     : ["배포 후 reflect 회귀 확인 절차"],
      open_questions     : ["후속 release 병합 전략"],
      narrative_summary  : narrativeSummary,
      agentId            : "integration-test",
      _keyId             : "test-key-r12",
      sessionId          : `r12-${Date.now()}`
    };

    let result;
    try {
      result = await mm.reflect(params);
    } catch (err) {
      assert.ok(
        !(err instanceof ReferenceError) || !/before initialization/.test(err.message),
        `R12 regression: ${err.message}\n${err.stack}`
      );
      throw err;
    }

    assert.ok(result, "reflect()는 non-null 결과를 반환해야 한다");
    assert.ok(Array.isArray(result.fragments), "result.fragments는 배열이어야 한다");
    /**
     * R12 본질은 "ReferenceError: Cannot access 'fragment' before initialization"이
     * 던져지지 않는 것이다. insert 호출 횟수는 reflect 내부 배치 전략에 따라 달라질
     * 수 있으므로 최소 1회만 요구한다. 위 try/catch 블록이 ReferenceError를 명시
     * 차단하므로 이 지점에 도달했다는 사실 자체가 회귀 가드를 만족한다.
     */
    assert.ok(result.fragments.length >= 1, `fragment가 최소 1건 생성되어야 한다 — 실제 ${result.fragments.length}`);
  });
});
