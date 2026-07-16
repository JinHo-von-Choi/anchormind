/**
 * ReflectProcessor 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-05
 *
 * store/index/factory/sessionLinker/remember를 mock하여
 * ReflectProcessor.process()의 파편 생성, breakdown 집계,
 * 세션 통합, episode 생성을 검증한다.
 */

import { describe, it, mock, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

mock.module("../../lib/memory/embedding/MorphemeIndex.js", {
  namedExports: {
    MorphemeIndex: class {
      async tokenize(t)              { return String(t).toLowerCase().split(/[\s,.]+/).filter(w => w.length > 1).slice(0, 10); }
      async getOrRegisterEmbeddings() { return []; }
    },
  },
});

const { ReflectProcessor }  = await import("../../lib/memory/processors/ReflectProcessor.js");
const { teardownTestResources, assertCleanShutdown } = await import("../_lifecycle.js");

/**
 * ReflectProcessor import 체인이 Redis ioredis 클라이언트를 즉시 연결하므로
 * 테스트 종료 후 lifecycle helper로 정리하지 않으면 event loop가 유지되어
 * node:test가 "Promise resolution is still pending" 메시지와 함께 cleanup hang.
 *
 * MEMENTO_METRICS_DEFAULT=off (CP2) 적용 후 prom-client collectDefaultMetrics
 * timer가 비활성화되므로 assertCleanShutdown이 active handle 0을 검증할 수 있다.
 */
after(async () => {
  /** mock stub이라 즉시 settle되지만 _morphemePromises finally 콜백은
   *  microtask queue에 적재되므로 setImmediate로 한 tick 비워 drain한다. */
  await new Promise(r => setImmediate(r));
  await teardownTestResources();
  await assertCleanShutdown();
});

/* ── mock 의존성 생성 헬퍼 ── */
let idCounter;

function createMockDeps(overrides = {}) {
  idCounter = 0;

  const store = {
    insert: mock.fn(async () => `frag-${++idCounter}`),
    ...overrides.store,
  };

  const index = {
    index            : mock.fn(async () => {}),
    clearWorkingMemory: mock.fn(async () => {}),
    ...overrides.index,
  };

  const factory = {
    create: mock.fn((opts) => ({
      content  : opts.content,
      topic    : opts.topic,
      type     : opts.type,
      keywords : opts.keywords || [],
      source   : opts.source,
      agent_id : opts.agentId,
    })),
    splitAndCreate: mock.fn((text, opts) => [{ content: text }]),
    ...overrides.factory,
  };

  const sessionLinker = {
    consolidateSessionFragments: mock.fn(async () => null),
    autoLinkSessionFragments   : mock.fn(async () => {}),
    ...overrides.sessionLinker,
  };

  const rememberFn = overrides.remember ?? mock.fn(async () => ({ id: "ep-1" }));

  return { store, index, factory, sessionLinker, remember: rememberFn };
}

/* ── summary 테스트 ── */
describe("ReflectProcessor - summary", () => {
  it("문자열 summary를 fact 파편으로 변환", async () => {
    const deps      = createMockDeps();
    const processor = new ReflectProcessor(deps);

    const result = await processor.process({
      summary: "세션 요약 텍스트",
      agentId: "test-agent",
    });

    assert.equal(result.breakdown.summary, 1);
    assert.equal(result.fragments.length, 1);
    assert.equal(result.fragments[0].type, "fact");
    assert.equal(deps.store.insert.mock.callCount(), 1);
    assert.equal(deps.index.index.mock.callCount(), 1);
  });

  it("배열 summary를 각각 fact 파편으로 변환", async () => {
    const deps      = createMockDeps();
    const processor = new ReflectProcessor(deps);

    const result = await processor.process({
      summary: ["요약 1", "요약 2", "요약 3"],
      agentId: "test-agent",
    });

    assert.equal(result.breakdown.summary, 3);
    assert.equal(result.count, 3);
  });

  it("빈 문자열 summary 항목은 필터링", async () => {
    const deps      = createMockDeps();
    const processor = new ReflectProcessor(deps);

    const result = await processor.process({
      summary: ["유효", "", "  "],
      agentId: "test-agent",
    });

    assert.equal(result.breakdown.summary, 1);
  });
});

/* ── decisions 테스트 ── */
describe("ReflectProcessor - decisions", () => {
  it("decisions 배열을 decision 파편으로 변환", async () => {
    const deps      = createMockDeps();
    const processor = new ReflectProcessor(deps);

    const result = await processor.process({
      decisions: ["TypeScript를 프로젝트 공식 언어로 채택하고 tsconfig strict 모드 활성화", "PostgreSQL 16을 주 데이터베이스로 선택하고 pgvector 확장 활성화"],
      agentId  : "test-agent",
    });

    assert.equal(result.breakdown.decisions, 2);
    assert.equal(result.fragments[0].type, "decision");
    assert.equal(result.fragments[1].type, "decision");

    const createCalls = deps.factory.create.mock.calls;
    assert.equal(createCalls[0].arguments[0].importance, 0.7);
  });
});

/* ── errors_resolved 테스트 ── */
describe("ReflectProcessor - errors_resolved", () => {
  it("errors_resolved를 [해결됨] prefix 포함 error 파편으로 변환", async () => {
    const deps      = createMockDeps();
    const processor = new ReflectProcessor(deps);

    const result = await processor.process({
      errors_resolved: ["NPE 발생 원인인 null 미검증 경로를 Optional 체이닝으로 수정 완료"],
      agentId        : "test-agent",
    });

    assert.equal(result.breakdown.errors, 1);
    assert.equal(result.fragments[0].type, "error");
    const createCall = deps.factory.create.mock.calls[0].arguments[0];
    assert.ok(createCall.content.startsWith("[해결됨]"));
    assert.equal(createCall.importance, 0.5);
  });
});

/* ── new_procedures 테스트 ── */
describe("ReflectProcessor - new_procedures", () => {
  it("new_procedures를 procedure 파편으로 변환", async () => {
    const deps      = createMockDeps();
    const processor = new ReflectProcessor(deps);

    const result = await processor.process({
      new_procedures: ["배포 절차 v2: 스테이징 환경 검증 후 프로덕션 롤아웃 순서 확정"],
      agentId       : "test-agent",
    });

    assert.equal(result.breakdown.procedures, 1);
    assert.equal(result.fragments[0].type, "procedure");
    const createCall = deps.factory.create.mock.calls[0].arguments[0];
    assert.equal(createCall.importance, 0.7);
  });
});

/* ── open_questions 테스트 ── */
describe("ReflectProcessor - open_questions", () => {
  it("open_questions를 [미해결] prefix 포함 fact 파편으로 변환", async () => {
    const deps      = createMockDeps();
    const processor = new ReflectProcessor(deps);

    const result = await processor.process({
      open_questions: ["Redis 클러스터 이슈"],
      agentId       : "test-agent",
    });

    assert.equal(result.breakdown.questions, 1);
    assert.equal(result.fragments[0].type, "fact");
    const createCall = deps.factory.create.mock.calls[0].arguments[0];
    assert.ok(createCall.content.startsWith("[미해결]"));
    assert.equal(createCall.importance, 0.4);
  });
});

/* ── 세션 통합 테스트 ── */
describe("ReflectProcessor - session consolidation", () => {
  it("sessionId 존재 시 consolidateSessionFragments 호출", async () => {
    const deps = createMockDeps({
      sessionLinker: {
        consolidateSessionFragments: mock.fn(async () => ({
          summary         : "통합 요약",
          decisions       : ["통합 결정: 마이크로서비스 분리 전략을 다음 분기 로드맵에 반영"],
          errors_resolved : null,
          new_procedures  : null,
          open_questions  : null,
        })),
        autoLinkSessionFragments: mock.fn(async () => {}),
      },
    });
    const processor = new ReflectProcessor(deps);

    const result = await processor.process({
      sessionId: "sess-1",
      agentId  : "test-agent",
    });

    assert.equal(deps.sessionLinker.consolidateSessionFragments.mock.callCount(), 1);
    assert.equal(result.breakdown.summary, 1);
    assert.equal(result.breakdown.decisions, 1);
  });

  it("sessionId 존재 시 clearWorkingMemory 호출", async () => {
    const deps      = createMockDeps();
    const processor = new ReflectProcessor(deps);

    await processor.process({ sessionId: "sess-1", agentId: "test-agent" });

    assert.equal(deps.index.clearWorkingMemory.mock.callCount(), 1);
    assert.equal(deps.index.clearWorkingMemory.mock.calls[0].arguments[0], "sess-1");
  });

  it("sessionId 없으면 clearWorkingMemory 미호출", async () => {
    const deps      = createMockDeps();
    const processor = new ReflectProcessor(deps);

    await processor.process({ summary: "테스트", agentId: "test-agent" });

    assert.equal(deps.index.clearWorkingMemory.mock.callCount(), 0);
  });
});

/* ── narrative_summary → episode 생성 ── */
describe("ReflectProcessor - narrative_summary", () => {
  it("narrative_summary 있으면 remember()로 episode 파편 생성", async () => {
    const rememberFn = mock.fn(async () => ({ id: "ep-1" }));
    const deps       = createMockDeps({ remember: rememberFn });
    const processor  = new ReflectProcessor(deps);

    const result = await processor.process({
      summary           : "요약",
      narrative_summary : "세션 서사",
      sessionId         : "sess-1",
      agentId           : "test-agent",
    });

    assert.equal(rememberFn.mock.callCount(), 1);
    const rememberArgs = rememberFn.mock.calls[0].arguments[0];
    assert.equal(rememberArgs.type, "episode");
    assert.equal(rememberArgs.content, "세션 서사");
    assert.equal(rememberArgs.sessionId, "sess-1");
    assert.equal(result.breakdown.episode, 1);
  });
});

/* ── 복합 입력 ── */
describe("ReflectProcessor - combined", () => {
  it("모든 항목 동시 입력 시 각 breakdown 정확히 집계", async () => {
    const deps      = createMockDeps();
    const processor = new ReflectProcessor(deps);

    const result = await processor.process({
      summary        : ["요약 A", "요약 B"],
      decisions      : ["결정 1: Redis 캐시 레이어 도입으로 DB 조회 부하 절감"],
      errors_resolved: ["에러 1: 커넥션 풀 고갈로 인한 타임아웃 발생 원인 확인 완료", "에러 2: SSL 인증서 갱신 누락으로 외부 API 호출 실패 원인 파악"],
      new_procedures : ["절차 1: 마이그레이션 실행 전 백업 스냅샷 생성 후 검증 단계 추가"],
      open_questions : ["질문 1: Redis 클러스터 샤딩 전략을 일관 해싱으로 전환할지 검토 필요"],
      agentId        : "test-agent",
    });

    assert.equal(result.breakdown.summary, 2);
    assert.equal(result.breakdown.decisions, 1);
    assert.equal(result.breakdown.errors, 2);
    assert.equal(result.breakdown.procedures, 1);
    assert.equal(result.breakdown.questions, 1);
    assert.equal(result.count, 7);
  });
});

/* ── resolutionStatus 자동 세팅 ── */
describe("ReflectProcessor - resolutionStatus", () => {
  it("errors_resolved 파편에 resolutionStatus='resolved' 세팅", async () => {
    const deps      = createMockDeps();
    const processor = new ReflectProcessor(deps);

    await processor.process({
      errors_resolved: ["NPE 수정 완료: 사용자 입력 null 체크 로직을 서비스 레이어에 추가"],
      sessionId      : "sess-rs",
      agentId        : "test-agent",
    });

    const createCall = deps.factory.create.mock.calls[0].arguments[0];
    assert.equal(createCall.resolutionStatus, "resolved");
  });

  it("open_questions 파편에 resolutionStatus='open' 세팅", async () => {
    const deps      = createMockDeps();
    const processor = new ReflectProcessor(deps);

    await processor.process({
      open_questions: ["캐시 전략 미확정: L2 캐시를 Redis Cluster로 교체할지 로컬 Caffeine 유지할지 결정 보류"],
      sessionId     : "sess-rs",
      agentId       : "test-agent",
    });

    const createCall = deps.factory.create.mock.calls[0].arguments[0];
    assert.equal(createCall.resolutionStatus, "open");
  });
});

/* ── sessionId 전파 ── */
describe("ReflectProcessor - sessionId propagation", () => {
  it("sessionId가 모든 섹션의 factory.create()에 전파됨", async () => {
    const deps      = createMockDeps();
    const processor = new ReflectProcessor(deps);

    await processor.process({
      summary        : ["요약"],
      decisions      : ["결정: GraphQL 대신 REST API를 유지하기로 최종 확정"],
      errors_resolved: ["에러: 동시 요청 폭증 시 OOM 발생, 힙 크기 제한 설정으로 완화 확인"],
      new_procedures : ["절차: 주간 DB 인덱스 재빌드 자동화 크론잡 설정 완료"],
      open_questions : ["질문: gRPC 프로토콜 도입 타당성을 다음 스프린트에서 PoC로 검증 예정"],
      sessionId      : "sess-prop",
      agentId        : "test-agent",
    });

    const calls = deps.factory.create.mock.calls;
    assert.equal(calls.length, 5);
    for (const call of calls) {
      assert.equal(call.arguments[0].sessionId, "sess-prop",
        `sessionId missing in ${call.arguments[0].type} fragment`);
    }
  });
});

/* ── keyId / workspace 전파 ── */
describe("ReflectProcessor - keyId and workspace propagation", () => {
  it("_keyId와 workspace가 파편에 전파됨", async () => {
    const deps      = createMockDeps();
    const processor = new ReflectProcessor(deps);

    await processor.process({
      summary  : "테스트",
      _keyId   : "key-abc",
      workspace: "ws-1",
      agentId  : "test-agent",
    });

    const insertArg = deps.store.insert.mock.calls[0].arguments[0];
    assert.equal(insertArg.key_id, "key-abc");
    assert.equal(insertArg.workspace, "ws-1");
  });
});

/* ── insert 실패 시 graceful 처리 ── */
describe("ReflectProcessor - insert failure handling", () => {
  it("일부 insert 실패 시 성공한 파편만 반환, 에러 삼키지 않음", async () => {
    let callCount = 0;
    const deps    = createMockDeps({
      store: {
        insert: mock.fn(async () => {
          callCount++;
          if (callCount === 2) throw new Error("DB insert failed");
          return `frag-${callCount}`;
        }),
      },
    });
    const processor = new ReflectProcessor(deps);

    const result = await processor.process({
      summary: ["성공 1", "실패할 항목", "성공 2"],
      agentId: "test-agent",
    });

    assert.equal(result.fragments.length, 2);
    assert.equal(result.breakdown.summary, 3);
  });
});
