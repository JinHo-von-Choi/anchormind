/**
 * 질문 의도, 근거 상태, 근거 묶음, 묶음 요약, 리랭커 하한, 그래프 시드, amend 세계 시각 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-12
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const {
  classifyAnswerIntent, resolveAnswerIntent, applyIntentDefaults, evidenceStatus, buildEvidenceBundle
} = await import("../../lib/memory/read/EvidenceBundle.js");
const {
  digestLine, sourceHash, renderTimeline, renderProfile, buildDigests, DIGEST_MIN_ITEMS
} = await import("../../lib/memory/consolidate/DigestBuilder.js");
const { digestWants, loadDigests } = await import("../../lib/memory/read/DigestLoader.js");
const { filterByRerankerScore, interleaveSeedIds } = await import("../../lib/memory/read/RankFusion.js");
const { amendChanges } = await import("../../lib/memory/processors/MemoryRememberer.js");
const { amendWorldTime } = await import("../../lib/memory/write/EventTimeExtractor.js");
const { appendWorldTimeAssignments } = await import("../../lib/memory/WorldTime.js");
const { CASCADE_DELETE_SQL, summarizeCascade, emptyPurge } = await import("../../lib/memory/write/ForgetCascade.js");

describe("질문 의도", () => {
  it("집계, 시간, 상태, 단순 조회를 가린다", () => {
    assert.equal(classifyAnswerIntent("How many books did I buy last year?"), "aggregate");
    assert.equal(classifyAnswerIntent("올해 운동을 총 몇 번 했지?"), "aggregate");
    assert.equal(classifyAnswerIntent("When did I move to Seoul?"), "temporal");
    assert.equal(classifyAnswerIntent("이사와 이직 중 무엇이 먼저였어?"), "temporal");
    assert.equal(classifyAnswerIntent("Where do I currently work?"), "state");
    assert.equal(classifyAnswerIntent("지금 쓰는 에디터는?"), "state");
    assert.equal(classifyAnswerIntent("What is my dog's name?"), "lookup");
    assert.equal(classifyAnswerIntent(""), "lookup");
  });

  it("명시 의도가 우선하고 auto는 text, 없으면 keywords로 가린다", () => {
    assert.deepEqual(resolveAnswerIntent({ intent: "state", text: "how many" }), { intent: "state", explicit: true });
    assert.deepEqual(resolveAnswerIntent({ intent: "auto", text: "how many" }), { intent: "aggregate", explicit: false });
    assert.equal(resolveAnswerIntent({ keywords: ["when", "moved"] }).intent, "temporal");
  });

  it("명시 의도는 기본값만 채우고 직접 준 값은 두며 입력을 바꾸지 않는다", () => {
    const args = { intent: "aggregate" };
    assert.equal(applyIntentDefaults(args).pageSize, 30);
    assert.equal(args.pageSize, undefined);
    assert.equal(applyIntentDefaults({ intent: "aggregate", pageSize: 10 }).pageSize, 10);
    assert.equal(applyIntentDefaults({ intent: "temporal" }).order, "chronological");
    assert.equal(applyIntentDefaults({ intent: "state" }).includeHistory, true);
    assert.equal(applyIntentDefaults({ intent: "state", includeHistory: false }).includeHistory, false);
    const auto = { intent: "auto", text: "how many" };
    assert.equal(applyIntentDefaults(auto), auto);
  });
});

describe("근거 상태", () => {
  it("결과가 없으면 no_evidence", () => {
    assert.equal(evidenceStatus([], ["dog", "name"]).status, "no_evidence");
  });

  it("상위 결과에 충돌 표지가 있으면 conflicting", () => {
    const out = evidenceStatus([{ id: "a", conflicts_with: ["b"] }], ["port"], [["port"]]);
    assert.equal(out.status, "conflicting");
  });

  it("핵심 낱말이 절반 넘게 빠지면 partial이고 빠진 낱말을 알린다", () => {
    const out = evidenceStatus([{ id: "a" }], ["what", "is", "my", "sister", "wedding", "venue"], [["wedding"]]);
    assert.equal(out.status, "partial");
    assert.deepEqual(out.uncovered_terms.sort(), ["sister", "venue"]);
  });

  it("핵심 낱말이 하나뿐이어도 결과에 없으면 partial이다", () => {
    const out = evidenceStatus([{ id: "a" }], ["wedding"], [["dog", "name"]]);
    assert.equal(out.status, "partial");
    assert.deepEqual(out.uncovered_terms, ["wedding"]);
  });

  it("의문사와 기능어는 세지 않고 덮이면 supported", () => {
    const out = evidenceStatus([{ id: "a" }], ["what", "is", "dog", "name"], [["dog", "name", "max"]]);
    assert.equal(out.status, "supported");
    assert.equal(out.coverage, 1);
  });
});

describe("근거 묶음", () => {
  const frags = [
    { id: "b", content: "[2023/05/20] bought a lamp", event_time: "2023-05-18T00:00:00Z", event_time_precision: "day" },
    { id: "a", content: "bought a desk", mention_time: "2023-04-01T00:00:00Z" },
    { id: "c", content: "[2023/06/01]  Bought a lamp", created_at: "2026-10-12T00:00:00Z" },
    { id: "d", content: "no time" }
  ];

  it("lookup은 묶음을 만들지 않는다", () => {
    assert.equal(buildEvidenceBundle(frags, { intent: "lookup" }), null);
  });

  it("세계 시각순 행, 같은 본문 묶음, 잘림 여부를 낸다", () => {
    const b = buildEvidenceBundle(frags, { intent: "aggregate", truncated: true });
    assert.deepEqual(b.rows.map(r => r.id), ["a", "b", "c", "d"]);
    assert.deepEqual(b.rows.map(r => r.time_basis), ["mention", "event", "stored", null]);
    assert.equal(b.rows[1].precision, "day");
    assert.equal(b.distinct_count, 3);
    assert.deepEqual(b.duplicate_ids, [["b", "c"]]);
    assert.equal(b.coverage, "truncated");
  });
});

describe("묶음 요약 만들기", () => {
  it("한 줄은 공백을 줄이고 길이에서 자른다", () => {
    assert.equal(digestLine("a\n  b"), "a b");
    assert.equal(digestLine("x".repeat(200), 10), `${"x".repeat(10)}...`);
  });

  it("출처 해시는 순서와 무관하고 본문 해시가 바뀌면 바뀐다", () => {
    const a = [{ id: "1", content_hash: "h1" }, { id: "2", content_hash: "h2" }];
    assert.equal(sourceHash(a), sourceHash([...a].reverse()));
    assert.notEqual(sourceHash(a), sourceHash([{ id: "1", content_hash: "h9" }, a[1]]));
  });

  it("시간선은 세계 시각 오름차순, 선호 목록은 말한 시각 역순이다", () => {
    const rows = [
      { id: "2", type: "fact", content: "second", event_time: "2024-02-01T00:00:00Z", event_time_precision: "month" },
      { id: "1", type: "fact", content: "first", created_at: "2023-01-05T00:00:00Z" }
    ];
    const t = renderTimeline("trip", rows).split("\n");
    assert.equal(t[0], "[timeline] trip (2)");
    assert.equal(t[1], "2023-01-05 | fact | first");
    assert.equal(t[2], "2024-02 | fact | second");
    const p = renderProfile([
      { id: "x", content: "likes tea", mention_time: "2023-01-01T00:00:00Z" },
      { id: "y", content: "likes coffee", mention_time: "2024-01-01T00:00:00Z" }
    ]).split("\n");
    assert.equal(p[1], "2024-01-01 | likes coffee");
  });

  it("묶음마다 요약을 쓰고 낡은 요약을 지운다", async () => {
    const calls = [];
    const run = async (sql, params) => {
      calls.push({ sql, params });
      if (/GROUP BY f\.key_id, f\.workspace, f\.agent_id, f\.topic/.test(sql)) {
        return { rows: [{ key_id: "k", workspace: "w", agent_id: "default", topic: "trip" }] };
      }
      if (/GROUP BY f\.key_id, f\.workspace, f\.agent_id\n/.test(sql)) {
        return { rows: [{ key_id: "k", workspace: "w", agent_id: "default" }] };
      }
      if (/FROM agent_memory\.fragments f\s+WHERE/.test(sql) && /LIMIT \$/.test(sql) && params.length >= 4) {
        return { rows: Array.from({ length: DIGEST_MIN_ITEMS }, (_, i) => ({
          id: `f${i}`, content: `c${i}`, type: "fact", content_hash: `h${i}`, created_at: "2024-01-01T00:00:00Z"
        })) };
      }
      if (/INSERT INTO agent_memory\.fragment_digest/.test(sql)) return { rows: [{ inserted: true }] };
      if (/DELETE FROM agent_memory\.fragment_digest/.test(sql)) return { rows: [], rowCount: 2 };
      return { rows: [] };
    };
    const out = await buildDigests({ run });
    assert.deepEqual({ timelines: out.timelines, profiles: out.profiles, removed: out.removed }, { timelines: 1, profiles: 1, removed: 2 });
    const inserts = calls.filter(c => /INSERT INTO agent_memory\.fragment_digest/.test(c.sql));
    assert.deepEqual(inserts.map(c => c.params[3]), ["topic_timeline", "preference_profile"]);
    assert.deepEqual(inserts[0].params[6], ["f0", "f1", "f2", "f3", "f4"]);
    const groupSql = calls[0].sql;
    assert.match(groupSql, /trust_tier IS NULL OR f\.trust_tier >= 2/);
    assert.match(groupSql, /review_state IS NULL OR f\.review_state NOT IN/);
  });
});

describe("묶음 요약 읽기", () => {
  it("lookup이면 topic 시간선 없이 선호 질문만 본다", () => {
    assert.deepEqual(digestWants([{ topic: "a" }], { text: "what is my dog" }, "lookup"), { topics: [], preference: false });
    assert.equal(digestWants([], { text: "Can you recommend a book?" }, "lookup").preference, true);
    assert.equal(digestWants([], { type: "preference" }, "lookup").preference, true);
  });

  it("묶음 의도면 요청 topic, 없으면 결과 상위 topic 3개", () => {
    const frags = [{ topic: "a" }, { topic: "b" }, { topic: "a" }, { topic: "c" }, { topic: "d" }];
    assert.deepEqual(digestWants(frags, { topic: "z" }, "aggregate").topics, ["z"]);
    assert.deepEqual(digestWants(frags, {}, "temporal").topics, ["a", "b", "c"]);
  });

  it("범위와 신선도 조건을 걸고 요청이 없으면 조회하지 않는다", async () => {
    let seen = null;
    const pool = { query: async (sql, params) => { seen = { sql, params }; return { rows: [
      { kind: "topic_timeline", subject: "a", content: "x", item_count: 5, updated_at: new Date("2026-10-12T00:00:00Z") }
    ] }; } };
    assert.deepEqual(await loadDigests({}, { topics: [], preference: false }, () => pool), []);
    assert.equal(seen, null);
    const rows = await loadDigests({ keyId: "k", workspace: "w", agentId: "ag" }, { topics: ["a"] }, () => pool);
    assert.deepEqual(seen.params, ["w", "ag", ["a"], false, "k", ["k"]]);
    assert.match(seen.sql, /d\.key_id IS NOT DISTINCT FROM \$5 OR d\.key_id = ANY\(\$6::text\[\]\)/);
    assert.match(seen.sql, /f\.valid_to IS NULL/);
    assert.equal(rows[0].updated_at, "2026-10-12T00:00:00.000Z");
  });
});

describe("리랭커 하한과 그래프 시드", () => {
  it("하한 0은 그대로 두고 0보다 크면 낮은 후보를 뺀다", () => {
    const list = [{ id: "a", rerankerScore: 0.9 }, { id: "b", rerankerScore: 0.2 }];
    assert.equal(filterByRerankerScore(list, 0), list);
    const path = [];
    assert.deepEqual(filterByRerankerScore(list, 0.5, path).map(f => f.id), ["a"]);
    assert.deepEqual(path, ["RerankFilter:1"]);
  });

  it("시드는 목록을 번갈아 중복 없이 상한까지 고른다", () => {
    const l2 = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const l3 = [{ id: "x" }, { id: "a" }, { id: "y" }];
    assert.deepEqual(interleaveSeedIds([l2, l3], 4), ["a", "x", "b", "c"]);
    assert.deepEqual(interleaveSeedIds([[], l3], 10), ["x", "a", "y"]);
  });
});

describe("amend 세계 시각", () => {
  it("준 값만 열 변경으로 바꾸고 본문에서 뽑지 않는다", () => {
    const { changes, warnings } = amendWorldTime({ mentionTime: "2026-03-01T00:00:00Z", eventTime: "어제" });
    assert.equal(changes.mention_time, "2026-03-01T00:00:00.000Z");
    assert.equal(changes.event_time, "2026-02-28T00:00:00.000Z");
    assert.deepEqual(warnings, []);
    assert.deepEqual(amendWorldTime({ content: "어제 배포" }).changes, {});
    assert.equal(amendChanges({ eventTime: "2025" }).event_time_precision, "year");
  });

  it("해석할 수 없는 값은 경고하고 eventTimeEnd만 주면 받지 않는다", () => {
    assert.deepEqual(amendWorldTime({ eventTime: "언젠가" }).warnings.map(w => w.rule), ["eventTimeInvalid"]);
    const onlyEnd = amendWorldTime({ eventTimeEnd: "2026-01-01" });
    assert.deepEqual(onlyEnd.changes, {});
    assert.deepEqual(onlyEnd.warnings.map(w => w.rule), ["eventTimeEndInvalid"]);
  });

  it("UPDATE SET에는 키가 있는 열만 들어간다", () => {
    const set = [];
    const params = ["id"];
    appendWorldTimeAssignments(set, params, { event_time: "2026-01-01T00:00:00Z", event_time_precision: "day" });
    assert.deepEqual(set, ["event_time = $2::timestamptz", "event_time_precision = $3"]);
    assert.deepEqual(params, ["id", "2026-01-01T00:00:00Z", "day"]);
  });
});

describe("삭제 연쇄의 묶음 요약", () => {
  it("지운 파편을 출처로 가진 요약을 같은 문장에서 지우고 수를 센다", () => {
    assert.match(CASCADE_DELETE_SQL, /DELETE FROM agent_memory\.fragment_digest WHERE source_ids && \$1::text\[\]/);
    const out = summarizeCascade(["a"], [{ id: "a", scrubbed: 1, digests: 2 }]);
    assert.deepEqual(out.purged, { case_summaries: 1, audit_fragments: 0, digests: 2, derived_revoked: 0 });
    assert.deepEqual(emptyPurge(), { case_summaries: 0, audit_fragments: 0, digests: 0, derived_revoked: 0 });
  });
});
