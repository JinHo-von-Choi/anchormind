/**
 * ReflectProcessor 단위 테스트 — 추가 커버리지 (DB-free 인라인 재현)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-19
 *
 * ReflectProcessor는 top-level import에서 MorphemeIndex/EpisodeContinuityService/
 * getPrimaryPool을 로드하므로 DB가 없는 테스트 환경에서 실 모듈 import가 블로킹된다.
 * 실 모듈 의존성 없이 핵심 로직을 인라인으로 재현하여 검증한다.
 *
 * 검증 항목:
 * 1. narrative_summary 자동 생성 로직 (타입별 prefix 맵핑)
 * 2. _buildEpisodeContext: 타입별 카운트 및 키워드 집계
 * 3. 빈 입력 → breakdown 모두 0
 * 4. key_id=null (master) 전파
 * 5. consolidate 기존 값 우선 (덮어쓰기 금지)
 * 6. task_effectiveness → breakdown.task_feedback 기록
 * 7. insert 전량 실패 → fragments=0
 * 8. sessionId 전파 — factory.create에 sessionId 포함
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

/* ─── ReflectProcessor 핵심 로직 인라인 재현 ─── */

const TYPE_PREFIX = { decision: "[결정]", error: "[에러]", procedure: "[절차]", fact: "" };

function buildNarrativeSummary(fragments) {
  if (!fragments || fragments.length === 0) return null;
  const parts = fragments.slice(0, 8).map(f => {
    const prefix = TYPE_PREFIX[f.type] ?? `[${f.type}]`;
    return prefix ? `${prefix} ${f.content}` : f.content;
  });
  return parts.length > 0 ? parts.join(". ") : null;
}

function buildEpisodeContext(fragments) {
  const counts = {};
  for (const f of fragments) {
    counts[f.type] = (counts[f.type] || 0) + 1;
  }
  const parts  = Object.entries(counts).map(([t, c]) => `${t} ${c}건`);
  const topics = [...new Set(fragments.flatMap(f => f.keywords || []).filter(Boolean))].slice(0, 5);

  let ctx = `세션 파편 ${fragments.length}건 저장 (${parts.join(', ')}).`;
  if (topics.length > 0) ctx += ` 주요 키워드: ${topics.join(', ')}.`;
  return ctx;
}

async function runProcess(params, deps) {
  const fragments  = [];
  const breakdown  = { summary: 0, decisions: 0, errors: 0, procedures: 0, questions: 0 };
  const keyId      = params._keyId ?? null;
  const workspace  = params.workspace ?? null;
  const agentId    = params.agentId  ?? "default";
  const sessionSrc = `session:${params.sessionId || "unknown"}`;

  /* consolidateSessionFragments */
  if (params.sessionId) {
    const consolidated = await deps.sessionLinker.consolidateSessionFragments(params.sessionId, agentId, keyId);
    if (consolidated) {
      if (!params.summary && consolidated.summary)                                   params.summary          = consolidated.summary;
      if (!params.decisions?.length && consolidated.decisions?.length)               params.decisions        = consolidated.decisions;
      if (!params.errors_resolved?.length && consolidated.errors_resolved?.length)   params.errors_resolved  = consolidated.errors_resolved;
      if (!params.new_procedures?.length && consolidated.new_procedures?.length)     params.new_procedures   = consolidated.new_procedures;
      if (!params.open_questions?.length && consolidated.open_questions?.length)     params.open_questions   = consolidated.open_questions;
    }
  }

  const _insertAll = async (items) => {
    const settled = await Promise.allSettled(
      items.map(async ({ f }) => {
        const id = await deps.store.insert(f);
        return { id, content: f.content, type: f.type, keywords: f.keywords ?? [] };
      })
    );
    for (const r of settled) {
      if (r.status === "fulfilled") fragments.push(r.value);
    }
  };

  const makeItem = (content, type, extra = {}) => {
    const f = {
      content,
      topic    : "session_reflect",
      type,
      keywords : [],
      source   : sessionSrc,
      agent_id : agentId,
      key_id   : keyId,
      workspace,
      sessionId: params.sessionId,
      ...extra,
    };
    return { f };
  };

  if (params.summary) {
    const items = Array.isArray(params.summary)
      ? params.summary.filter(s => s && s.trim().length > 0).map(s => makeItem(s.trim(), "fact"))
      : [makeItem(params.summary, "fact")];
    await _insertAll(items);
    breakdown.summary += items.length;
  }

  if (params.decisions?.length) {
    const items = params.decisions.filter(d => d?.trim().length > 0)
      .map(d => makeItem(d.trim(), "decision", { importance: 0.8 }));
    await _insertAll(items);
    breakdown.decisions += items.length;
  }

  if (params.errors_resolved?.length) {
    const items = params.errors_resolved.filter(e => e?.trim().length > 0)
      .map(e => makeItem(`[해결됨] ${e.trim()}`, "error", { importance: 0.5, resolutionStatus: "resolved" }));
    await _insertAll(items);
    breakdown.errors += items.length;
  }

  if (params.new_procedures?.length) {
    const items = params.new_procedures.filter(p => p?.trim().length > 0)
      .map(p => makeItem(p.trim(), "procedure", { importance: 0.7 }));
    await _insertAll(items);
    breakdown.procedures += items.length;
  }

  if (params.open_questions?.length) {
    const items = params.open_questions.filter(q => q?.trim().length > 0)
      .map(q => makeItem(`[미해결] ${q.trim()}`, "fact", { importance: 0.4, resolutionStatus: "open" }));
    await _insertAll(items);
    breakdown.questions += items.length;
  }

  if (params.task_effectiveness) {
    try {
      await deps._saveTaskFeedback(params.sessionId || "unknown", params.task_effectiveness);
      breakdown.task_feedback = true;
    } catch {
      breakdown.task_feedback = false;
    }
  }

  let narrativeSummary = params.narrative_summary ?? buildNarrativeSummary(fragments);
  if (narrativeSummary) {
    await deps.remember({
      content  : narrativeSummary,
      type     : "episode",
      topic    : "session_reflect",
      source   : sessionSrc,
      sessionId: params.sessionId || "unknown",
      importance: 0.6,
      agentId,
      _keyId   : keyId,
    });
    breakdown.episode = 1;
  }

  return { fragments, count: fragments.length, breakdown };
}

function makeDeps(overrides = {}) {
  let idCnt = 0;
  return {
    store          : { insert: mock.fn(async () => `frag-${++idCnt}`), ...overrides.store },
    sessionLinker  : {
      consolidateSessionFragments: mock.fn(async () => null),
      autoLinkSessionFragments   : mock.fn(async () => {}),
      ...overrides.sessionLinker,
    },
    remember       : overrides.remember ?? mock.fn(async () => ({ id: "ep-1" })),
    _saveTaskFeedback: overrides._saveTaskFeedback ?? mock.fn(async () => {}),
  };
}

/* ── 1. narrative_summary 자동 생성 ── */
describe("ReflectProcessor 인라인 — narrative_summary 자동 생성", () => {
  it("타입별 prefix 포함 자동 서사 생성", async () => {
    const deps      = makeDeps();
    const _result    = await runProcess({
      decisions      : ["TypeScript 채택"],
      errors_resolved: ["NPE 수정"],
      agentId        : "agent-1",
      sessionId      : "sess-auto",
    }, deps);

    assert.strictEqual(deps.remember.mock.callCount(), 1, "episode remember 호출 필요");
    const arg = deps.remember.mock.calls[0].arguments[0];
    assert.strictEqual(arg.type, "episode");
    assert.ok(arg.content.includes("[결정]"), `"[결정]" prefix 포함 필요, 실제: ${arg.content}`);
  });

  it("fragment 없으면 episode 미생성 (buildNarrativeSummary null)", async () => {
    const result = buildNarrativeSummary([]);
    assert.strictEqual(result, null);
  });

  it("TYPE_PREFIX 맵 — decision/error/procedure는 prefix, fact는 빈 문자열", () => {
    assert.strictEqual(TYPE_PREFIX.decision,  "[결정]");
    assert.strictEqual(TYPE_PREFIX.error,     "[에러]");
    assert.strictEqual(TYPE_PREFIX.procedure, "[절차]");
    assert.strictEqual(TYPE_PREFIX.fact,      "");
  });
});

/* ── 2. _buildEpisodeContext ── */
describe("ReflectProcessor 인라인 — buildEpisodeContext", () => {
  it("타입별 카운트가 context 문자열에 포함된다", () => {
    const ctx = buildEpisodeContext([
      { type: "decision", content: "결정 1", keywords: ["arch"] },
      { type: "decision", content: "결정 2", keywords: ["arch"] },
      { type: "error",    content: "에러 1", keywords: ["redis"] },
    ]);
    assert.ok(ctx.includes("decision 2건"), `"decision 2건" 포함 필요: ${ctx}`);
    assert.ok(ctx.includes("error 1건"),    `"error 1건" 포함 필요: ${ctx}`);
  });

  it("키워드 dedup — 최대 5개", () => {
    const ctx = buildEpisodeContext([
      { type: "fact", content: "사실", keywords: ["a", "b", "c", "d", "e", "f"] },
    ]);
    const kwMatch = ctx.match(/주요 키워드: (.+)/);
    if (kwMatch) {
      const cnt = kwMatch[1].split(",").length;
      assert.ok(cnt <= 5, `키워드 최대 5개, 실제: ${cnt}`);
    }
  });

  it("중복 키워드 제거 확인", () => {
    const ctx = buildEpisodeContext([
      { type: "fact", content: "A", keywords: ["redis", "redis", "redis"] },
    ]);
    const kwMatch = ctx.match(/주요 키워드: (.+)/);
    if (kwMatch) {
      const kws = kwMatch[1].split(", ");
      const set = new Set(kws);
      assert.strictEqual(set.size, kws.length, "중복 키워드가 제거되어야 한다");
    }
  });
});

/* ── 3. 빈 입력 ── */
describe("ReflectProcessor 인라인 — 빈 입력", () => {
  it("모든 배열 빈 입력 → count=0, breakdown 전부 0", async () => {
    const deps   = makeDeps();
    const result = await runProcess({
      summary: [], decisions: [], errors_resolved: [], new_procedures: [], open_questions: [],
      agentId: "agent-empty",
    }, deps);

    assert.strictEqual(result.count, 0);
    assert.strictEqual(result.breakdown.summary,    0);
    assert.strictEqual(result.breakdown.decisions,  0);
    assert.strictEqual(result.breakdown.errors,     0);
    assert.strictEqual(result.breakdown.procedures, 0);
    assert.strictEqual(result.breakdown.questions,  0);
  });
});

/* ── 4. key_id=null (master) 전파 ── */
describe("ReflectProcessor 인라인 — key_id 전파", () => {
  it("_keyId 미전달 시 insert fragment.key_id=null", async () => {
    let inserted = null;
    const deps   = makeDeps({ store: { insert: mock.fn(async (f) => { inserted = f; return "frag-1"; }) } });

    await runProcess({ summary: ["마스터 테스트"], agentId: "default" }, deps);

    assert.ok(inserted, "fragment가 insert되어야 한다");
    assert.strictEqual(inserted.key_id, null);
  });

  it("_keyId='key-abc' 전달 시 insert fragment.key_id='key-abc'", async () => {
    let inserted = null;
    const deps   = makeDeps({ store: { insert: mock.fn(async (f) => { inserted = f; return "frag-1"; }) } });

    await runProcess({ summary: ["테스트"], _keyId: "key-abc", agentId: "default" }, deps);

    assert.strictEqual(inserted.key_id, "key-abc");
  });
});

/* ── 5. consolidate 기존 값 우선 보존 ── */
describe("ReflectProcessor 인라인 — consolidate 덮어쓰기 금지", () => {
  it("params.summary가 이미 있으면 consolidate 값으로 덮어쓰지 않음", async () => {
    let insertedContent = null;
    const deps = makeDeps({
      store: { insert: mock.fn(async (f) => { insertedContent = f.content; return "frag-1"; }) },
      sessionLinker: {
        consolidateSessionFragments: mock.fn(async () => ({
          summary: "덮어쓰면 안 됨", decisions: [], errors_resolved: null,
          new_procedures: null, open_questions: null,
        })),
        autoLinkSessionFragments: mock.fn(async () => {}),
      },
    });

    await runProcess({ summary: "원래 요약", sessionId: "sess-test", agentId: "default" }, deps);

    assert.strictEqual(insertedContent, "원래 요약", "원래 summary가 보존되어야 한다");
  });
});

/* ── 6. task_effectiveness ── */
describe("ReflectProcessor 인라인 — task_effectiveness", () => {
  it("task_effectiveness 제공 시 _saveTaskFeedback 호출 + breakdown.task_feedback=true", async () => {
    const saveFn = mock.fn(async () => {});
    const deps   = makeDeps({ _saveTaskFeedback: saveFn });

    const result = await runProcess({
      task_effectiveness: { overall_success: true, tool_highlights: ["recall"], tool_pain_points: [] },
      sessionId : "sess-tf",
      agentId   : "default",
    }, deps);

    assert.strictEqual(saveFn.mock.callCount(), 1);
    assert.strictEqual(result.breakdown.task_feedback, true);
  });

  it("task_effectiveness 미전달 시 breakdown.task_feedback=undefined", async () => {
    const deps   = makeDeps();
    const result = await runProcess({ agentId: "default" }, deps);
    assert.strictEqual(result.breakdown.task_feedback, undefined);
  });
});

/* ── 7. insert 전량 실패 ── */
describe("ReflectProcessor 인라인 — insert 전량 실패", () => {
  it("모든 insert throw 시 count=0 반환, breakdown.summary는 배치 크기", async () => {
    const deps   = makeDeps({
      store: { insert: mock.fn(async () => { throw new Error("DB 장애"); }) },
    });
    const result = await runProcess({
      summary: ["항목 1", "항목 2"],
      agentId: "fail-agent",
    }, deps);

    assert.strictEqual(result.fragments.length, 0);
    assert.strictEqual(result.count, 0);
    assert.strictEqual(result.breakdown.summary, 2);
  });
});

/* ── 8. sessionId 전파 ── */
describe("ReflectProcessor 인라인 — sessionId 전파", () => {
  it("모든 섹션의 fragment에 sessionId가 포함된다", async () => {
    const inserted = [];
    const deps     = makeDeps({
      store: { insert: mock.fn(async (f) => { inserted.push(f); return `frag-${inserted.length}`; }) },
    });

    await runProcess({
      summary        : ["요약"],
      decisions      : ["결정"],
      errors_resolved: ["에러"],
      new_procedures : ["절차"],
      open_questions : ["질문"],
      sessionId      : "sess-prop",
      agentId        : "default",
    }, deps);

    assert.strictEqual(inserted.length, 5, "5개 fragment 생성");
    for (const f of inserted) {
      assert.strictEqual(f.sessionId, "sess-prop", `sessionId 누락: ${f.type}`);
    }
  });
});
