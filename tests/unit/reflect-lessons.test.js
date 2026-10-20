/**
 * reflect lessons(상황 단서가 붙은 교훈) 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-10-20
 *
 * 입력 정규화(필수 칸, NO_ENTRY, 확신도), 교훈 파편의 형태(procedure, 중요도, 맥락 요약, low의 inferred),
 * 저장된 교훈만 cue를 등록하는 흐름, cue 등록 쿼리의 형태를 확인한다.
 */

import { describe, it, mock, after } from "node:test";
import assert from "node:assert/strict";

mock.module("../../lib/memory/embedding/MorphemeIndex.js", {
  namedExports: {
    MorphemeIndex: class {
      async tokenize(t)              { return String(t).toLowerCase().split(/[\s,.]+/).filter(w => w.length > 1).slice(0, 10); }
      async getOrRegisterEmbeddings() { return []; }
    }
  }
});
mock.module("../../lib/memory/processors/EpisodeContinuityService.js", {
  namedExports: { linkEpisodeMilestone: async () => null }
});

const { ReflectProcessor } = await import("../../lib/memory/processors/ReflectProcessor.js");
const { normalizeLessons, lessonContextSummary, registerLessonCues, NO_ENTRY } =
  await import("../../lib/memory/write/LessonCue.js");
const { __setRedisClientForTest } = await import("../../lib/redis.js");
__setRedisClientForTest({
  status: "stub",
  async lpush() { return 1; }, async rpush() { return 1; }, async rpop() { return null; },
  async lpop()  { return null; }, async llen() { return 0; }, async set() { return "OK"; },
  async get()   { return null; }, async del() { return 1; }, async expire() { return 1; }, async incr() { return 1; }
});
const { teardownTestResources, assertCleanShutdown } = await import("../_lifecycle.js");

const made = new Set();
after(async () => {
  for (const p of made) await Promise.allSettled([...(p._morphemePromises ?? [])]);
  await new Promise(r => setImmediate(r));
  await teardownTestResources();
  await assertCleanShutdown();
});

const LESSON = {
  cue     : "CI가 외부 패키지 다운로드 시간 초과로 실패할 때",
  lesson  : "실패한 작업만 gh run rerun --failed로 다시 돌리고 같은 단계가 연속 실패할 때만 원인을 조사한다",
  evidence: "onnxruntime nuget ETIMEDOUT 실패 2회가 재실행으로 통과했다"
};

function makeProcessor() {
  let n = 0;
  const deps = {
    store  : { insert: mock.fn(async () => `frag-${++n}`) },
    index  : { index: mock.fn(async () => {}), evictWorkingMemoryItems: mock.fn(async () => 0) },
    factory: {
      create: mock.fn((o) => ({
        content: o.content, topic: o.topic, type: o.type, keywords: [], importance: o.importance,
        assertion_status: o.assertionStatus ?? "observed", context_summary: o.contextSummary ?? null
      })),
      splitAndCreate: mock.fn((t) => [{ content: t }])
    },
    sessionLinker: {
      consolidateSessionFragments: mock.fn(async () => null),
      autoLinkSessionFragments   : mock.fn(async () => {})
    },
    remember    : mock.fn(async () => ({ id: "ep-1" })),
    registerCues: mock.fn(async () => 0)
  };
  const processor = new ReflectProcessor(deps);
  made.add(processor);
  return { processor, deps };
}

describe("normalizeLessons", () => {
  it("cue, lesson, evidence가 모두 있는 것만 받고 NO_ENTRY와 거부를 따로 센다", () => {
    const out = normalizeLessons([
      LESSON,
      { ...LESSON, cue: "  " },
      { lesson: "x", evidence: "y" },
      NO_ENTRY,
      42
    ]);
    assert.equal(out.lessons.length, 1);
    assert.equal(out.noEntry, 1);
    assert.equal(out.rejected, 3);
    assert.equal(out.lessons[0].confidence, "medium", "확신도 생략은 medium");
  });

  it("배열이 아니면 빈 결과", () => {
    assert.deepEqual(normalizeLessons(undefined), { lessons: [], noEntry: 0, rejected: 0 });
  });

  it("맥락 요약은 상황, 근거, 확신도를 담는다", () => {
    assert.equal(lessonContextSummary({ ...LESSON, confidence: "high" }),
      `상황: ${LESSON.cue}\n근거: ${LESSON.evidence}\n확신도: high`);
  });
});

describe("ReflectProcessor lessons", () => {
  it("교훈을 procedure 파편으로 저장하고 저장된 파편의 cue만 등록한다", async () => {
    const { processor, deps } = makeProcessor();
    const result = await processor.process({
      agentId: "t",
      lessons: [{ ...LESSON, confidence: "high" }, { ...LESSON, lesson: "짧음" }, NO_ENTRY]
    });

    assert.equal(result.breakdown.lessons, 1);
    assert.equal(result.breakdown.lessons_no_entry, 1);
    assert.equal(result.breakdown.lessons_rejected, 1, "자기완결 기준 미달 lesson은 거부");

    const created = deps.factory.create.mock.calls.map(c => c.arguments[0]).find(o => o.type === "procedure");
    assert.equal(created.content, LESSON.lesson);
    assert.equal(created.importance, 0.8);
    assert.equal(created.assertionStatus, "observed");
    assert.match(created.contextSummary, /^상황: CI가/);

    assert.equal(deps.registerCues.mock.callCount(), 1);
    assert.deepEqual(deps.registerCues.mock.calls[0].arguments[0],
      [{ fragmentId: result.fragments[0].id, cue: LESSON.cue, agentId: "t" }]);
    assert.equal(result.fragments[0]._cue, undefined, "응답에는 cue 표지를 남기지 않는다");
  });

  it("low 확신도 교훈은 inferred로, 중요도 0.6으로 저장한다", async () => {
    const { processor, deps } = makeProcessor();
    await processor.process({ agentId: "t", lessons: [{ ...LESSON, confidence: "low" }] });
    const created = deps.factory.create.mock.calls[0].arguments[0];
    assert.equal(created.assertionStatus, "inferred");
    assert.equal(created.importance, 0.6);
  });

  it("교훈이 없으면 cue 등록을 부르지 않는다", async () => {
    const { processor, deps } = makeProcessor();
    await processor.process({ agentId: "t", decisions: ["PostgreSQL 16을 주 데이터베이스로 선택하고 pgvector 확장 활성화"] });
    assert.equal(deps.registerCues.mock.callCount(), 0);
  });
});

describe("registerLessonCues", () => {
  it("원문 파편을 읽고 cue를 임베딩해 origin='cue'로 역질의 저장 문장에 넘긴다", async () => {
    const row   = { id: "frag-1", content_hash: "h1", key_id: null, agent_id: "a", workspace: "ws" };
    const load  = mock.fn(async () => row);
    const store = mock.fn(async () => true);
    const embed = mock.fn(async () => [0.1, 0.2]);
    const n = await registerLessonCues([{ fragmentId: "frag-1", cue: LESSON.cue }], { embed, load, store });

    assert.equal(n, 1);
    assert.deepEqual(load.mock.calls[0].arguments, ["frag-1"]);
    assert.deepEqual(store.mock.calls[0].arguments, [row, LESSON.cue, [0.1, 0.2], "cue"]);
  });

  it("닫힌 파편은 건너뛰고, 실패해도 던지지 않는다", async () => {
    const closed = await registerLessonCues([{ fragmentId: "f", cue: "c" }],
      { embed: async () => [1], load: async () => null, store: async () => true });
    assert.equal(closed, 0);
    const failed = await registerLessonCues([{ fragmentId: "f", cue: "c" }],
      { embed: async () => [1], load: async () => ({ id: "f" }), store: async () => { throw new Error("db down"); } });
    assert.equal(failed, 0);
  });
});
