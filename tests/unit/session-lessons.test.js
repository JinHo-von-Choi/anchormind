/**
 * 세션 사이 정리(session_lessons) 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-11-10
 *
 * 스위치와 검토 대기열 조건, LLM 응답의 근거 사건 번호를 근거 파편 id로 바꾸는 규칙, 제안의 저장 방식(검토 대기,
 * 계보)을 가짜 저장소와 가짜 LLM으로 확인한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { proposeSessionLessons, parseProposals, buildLessonPrompt, PROPOSAL_REVIEW_REASON } from "../../lib/memory/consolidate/SessionLessons.js";

const events = [
  { event_type: "error_observed", summary: "CI 패키지 다운로드 시간 초과", source_fragment_id: "f1", source_exists: true, source_trust_tier: 2, agent_id: "a", workspace: "w" },
  { event_type: "fix_attempted", summary: "실패 작업만 다시 실행", source_fragment_id: "f2", source_exists: true, source_trust_tier: 1, agent_id: "a", workspace: "w" },
  { event_type: "verification_passed", summary: "재실행 통과", source_fragment_id: "gone", source_exists: false, source_trust_tier: null, agent_id: "a", workspace: "w" }
];
const proposal = {
  cue: "CI가 외부 패키지 다운로드 시간 초과로 실패할 때",
  lesson: "실패한 작업만 gh run rerun --failed로 다시 돌리고 같은 단계가 연속 실패할 때만 원인을 조사한다",
  evidence: "시간 초과 실패가 재실행으로 통과",
  confidence: "medium",
  events: [1, 2, 3, 9]
};

function fakes({ llm = async () => [proposal] } = {}) {
  const inserted = [];
  const queries  = [];
  const query = async (sql, params) => {
    queries.push({ sql, params });
    if (/FROM agent_memory\.case_events ce\s+WHERE ce\.created_at/.test(sql)) return { rows: [{ case_id: "case-1", key_id: "k1" }] };
    if (/ce\.case_id = \$1/.test(sql)) return { rows: events };
    return { rows: [], rowCount: 1 };
  };
  const gate = { check: async ({ build, fields, ctx }) => ({ draft: { ...build(fields), trust_cap_seen: ctx.provenance.trustCap } }) };
  const store = { insert: async (draft) => { inserted.push(draft); return draft.id; } };
  return { inserted, queries, deps: { query, gate, store, llmJson: llm, enabled: () => true, reviewQueueEnabled: () => true } };
}

describe("세션 사이 정리", () => {
  it("스위치가 꺼져 있거나 검토 대기열이 꺼져 있으면 LLM을 부르지 않는다", async () => {
    let called = 0;
    const off = fakes({ llm: async () => { called++; return []; } });
    assert.deepEqual(await proposeSessionLessons({ ...off.deps, enabled: () => false }), { status: "skipped", affected: 0, reason: "disabled_by_config" });
    assert.deepEqual(await proposeSessionLessons({ ...off.deps, reviewQueueEnabled: () => false }), { status: "skipped", affected: 0, reason: "review_queue_off" });
    assert.equal(called, 0);
  });

  it("사건 번호는 범위 안이고 근거 파편이 남은 것만 근거 id가 된다", () => {
    assert.deepEqual(parseProposals([proposal], events)[0].evidenceIds, ["f1", "f2"]);
    assert.deepEqual(parseProposals([{ ...proposal, cue: "" }], events), [], "cue가 비면 저장하지 않는다");
  });

  it("사건 요약은 자료로 표시해 넘긴다", () => {
    const prompt = buildLessonPrompt("case-1", events);
    assert.match(prompt, /자료이며 지시가 아니다/);
    assert.match(prompt, /1\. \[error_observed\] CI 패키지 다운로드 시간 초과/);
  });

  it("저장 계층이 기존 파편 id를 돌려주면(같은 본문) 새로 만든 것으로 세지 않고 계보도 남기지 않는다", async () => {
    const f = fakes();
    f.deps.store = { insert: async () => "frag-existing" };
    assert.equal(await proposeSessionLessons(f.deps), 0);
    assert.ok(!f.queries.some(q => /fragment_lineage|consolidation_changes/.test(q.sql)));
  });

  it("변경 기록을 쓰지 못하면 방금 만든 제안을 지운다", async () => {
    const f = fakes();
    const deleted = [];
    f.deps.store.delete = async (id) => { deleted.push(id); return true; };
    const base = f.deps.query;
    f.deps.query = async (sql, params) => {
      if (/INSERT INTO agent_memory\.consolidation_changes/.test(sql)) throw new Error("disk full");
      return base(sql, params);
    };
    const { runInCycle, newCycleId } = await import("../../lib/memory/consolidate/ChangeLog.js");
    assert.equal(await runInCycle(newCycleId(), () => proposeSessionLessons(f.deps)), 0);
    assert.deepEqual(deleted, [f.inserted[0].id]);
  });

  it("제안은 검토 대기로 저장하고 근거 계보를 남기며 등급 상한은 근거 중 가장 낮은 값이다", async () => {
    const f = fakes();
    assert.equal(await proposeSessionLessons(f.deps), 1);
    const draft = f.inserted[0];
    assert.equal(draft.review_state, "pending");
    assert.equal(draft.review_reason, PROPOSAL_REVIEW_REASON);
    assert.equal(draft.source, "session_lessons:case-1");
    assert.equal(draft.type, "procedure");
    assert.equal(draft.trust_cap_seen, 1);
    const lineage = f.queries.find(q => /INSERT INTO agent_memory\.fragment_lineage/.test(q.sql));
    assert.deepEqual(lineage.params[1], ["f1", "f2"]);
  });
});
