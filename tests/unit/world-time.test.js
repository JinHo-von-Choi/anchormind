/**
 * 세계 시각(말한 시각, 사건 시각) 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-12
 *
 * 본문 날짜 표현 추출, 쓰기 파라미터 해석, 시각 대체 순서, INSERT 조각, 시간순 정렬, 답 꾸러미 속성,
 * 상태 표지 조립을 확인한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { extractEventTime, resolveWorldTime } from "../../lib/memory/write/EventTimeExtractor.js";
import {
  statedAtMs, worldTimeMs, worldTimeInsertParts, timeRangeColumnSql, orderChronologically, formatEventTime
} from "../../lib/memory/WorldTime.js";
import { buildAnswerPack, PACK_BLOCK_OPEN } from "../../lib/memory/read/AnswerPack.js";
import { annotateFragmentState } from "../../lib/memory/read/FragmentStateLoader.js";

const REF = "2026-10-12T09:00:00Z";

describe("extractEventTime", () => {
  it("절대 날짜를 정밀도와 함께 뽑는다", () => {
    assert.deepEqual(extractEventTime("2026-03-14 배포", REF),
      { event_time: "2026-03-14T00:00:00.000Z", event_time_end: null, event_time_precision: "day" });
    assert.equal(extractEventTime("2025년 7월 회의", REF).event_time_precision, "month");
    assert.equal(extractEventTime("2025년 7월 회의", REF).event_time_end, "2025-08-01T00:00:00.000Z");
    assert.equal(extractEventTime("We met on March 3rd, 2024.", REF).event_time, "2024-03-03T00:00:00.000Z");
    assert.equal(extractEventTime("10월 1일 출시", REF).event_time, "2026-10-01T00:00:00.000Z");
  });

  it("상대 표현을 기준 시각으로 해석한다", () => {
    assert.equal(extractEventTime("어제 고쳤다", REF).event_time, "2026-10-11T00:00:00.000Z");
    assert.equal(extractEventTime("3일 전에 고쳤다", REF).event_time, "2026-10-09T00:00:00.000Z");
    assert.equal(extractEventTime("two weeks ago I bought it", REF).event_time, "2026-09-28T00:00:00.000Z");
    const week = extractEventTime("지난주에 이사했다", REF);
    assert.equal(week.event_time, "2026-10-05T00:00:00.000Z");
    assert.equal(week.event_time_precision, "week");
    assert.equal(extractEventTime("작년에 시작", REF).event_time, "2025-01-01T00:00:00.000Z");
  });

  it("읽는 법이 여럿이거나 날짜가 아닌 표현은 뽑지 않는다", () => {
    assert.equal(extractEventTime("다음 주제는 메모리", REF), null);
    assert.equal(extractEventTime("오늘날 기술", REF), null);
    assert.equal(extractEventTime("I may 2 go", REF), null);
    assert.equal(extractEventTime("10/12 배포", REF), null);
    assert.equal(extractEventTime("10.0.0.1 port 2026", REF), null);
    assert.equal(extractEventTime("2026-02-30 존재하지 않는 날", REF), null);
  });

  it("기준 시각과 같은 날짜(발화 머리)보다 본문 속 다른 시각을 고른다", () => {
    const hit = extractEventTime("[2023/05/20 (Sat) 02:21] user: I went to Paris last week", "2023-05-20T02:21:00Z");
    assert.equal(hit.event_time, "2023-05-08T00:00:00.000Z");
    assert.equal(extractEventTime("[2023/05/20] 별일 없음", "2023-05-20T02:21:00Z").event_time, "2023-05-20T00:00:00.000Z");
  });
});

describe("resolveWorldTime", () => {
  it("명시 값을 정규화하고 날짜 표현은 mentionTime 기준으로 읽는다", () => {
    const { fields, warnings } = resolveWorldTime(
      { mentionTime: "2026-03-15T09:30:00+09:00", eventTime: "어제" }, "본문", { now: Date.parse(REF) });
    assert.equal(fields.mention_time, "2026-03-15T00:30:00.000Z");
    assert.equal(fields.event_time, "2026-03-14T00:00:00.000Z");
    assert.deepEqual(warnings, []);
  });

  it("정밀도 표기(YYYY, YYYY-MM)와 구간 끝을 받는다", () => {
    const { fields } = resolveWorldTime({ eventTime: "2026-03", eventTimeEnd: "2026-03-20" }, "x");
    assert.equal(fields.event_time_precision, "month");
    assert.equal(fields.event_time_end, "2026-03-20T00:00:00.000Z");
    assert.equal(resolveWorldTime({ eventTime: "2025" }, "x").fields.event_time_precision, "year");
  });

  it("해석할 수 없는 값은 버리고 경고한다", () => {
    const { fields, warnings } = resolveWorldTime(
      { mentionTime: "언젠가", eventTime: "아무때나", eventTimeEnd: "2000-01-01" }, "본문", { extract: true });
    assert.equal(fields.mention_time, null);
    assert.equal(fields.event_time, null);
    assert.deepEqual(warnings.map(w => w.rule), ["mentionTimeInvalid", "eventTimeInvalid", "eventTimeEndInvalid"]);
  });

  it("extract가 거짓이면 본문에서 뽑지 않는다", () => {
    assert.equal(resolveWorldTime({}, "어제 배포", { extract: false }).fields.event_time, null);
    assert.notEqual(resolveWorldTime({}, "어제 배포", { extract: true }).fields.event_time, null);
  });
});

describe("WorldTime", () => {
  it("말한 시각은 mention_time, 세계 시각은 event_time을 먼저 쓴다", () => {
    const f = { created_at: "2026-10-12T00:00:00Z", mention_time: "2023-05-20T00:00:00Z", event_time: "2023-05-08T00:00:00Z" };
    assert.equal(statedAtMs(f), Date.parse("2023-05-20T00:00:00Z"));
    assert.equal(worldTimeMs(f), Date.parse("2023-05-08T00:00:00Z"));
    assert.equal(statedAtMs({ created_at: "2026-10-12T00:00:00Z" }), Date.parse("2026-10-12T00:00:00Z"));
    assert.ok(Number.isNaN(worldTimeMs({})));
  });

  it("값이 없으면 INSERT 조각이 비고 force면 NULL을 채운다", () => {
    assert.deepEqual(worldTimeInsertParts({}, 10), { columns: "", placeholders: "", values: [] });
    const forced = worldTimeInsertParts({}, 10, { force: true });
    assert.equal(forced.values.length, 4);
    assert.ok(forced.values.every(v => v === null));
    assert.match(forced.placeholders, /\$10::timestamptz, \$11::timestamptz, \$12::timestamptz, \$13$/);
  });

  it("timeRange 식은 색인 식과 같다", () => {
    assert.equal(timeRangeColumnSql("event", "f"), "COALESCE(f.event_time, f.mention_time, f.created_at)");
    assert.equal(timeRangeColumnSql(undefined), "created_at");
  });

  it("시간순 정렬은 시각 없는 파편을 뒤에 두고 같은 시각은 순위를 지킨다", () => {
    const list = [
      { id: "c", event_time: "2024-01-01T00:00:00Z" },
      { id: "none" },
      { id: "a", mention_time: "2023-01-01T00:00:00Z" },
      { id: "b", event_time: "2024-01-01T00:00:00Z" }
    ];
    assert.deepEqual(orderChronologically(list).map(f => f.id), ["a", "c", "b", "none"]);
  });

  it("사건 시각을 정밀도대로 표기한다", () => {
    assert.equal(formatEventTime("2026-03-01T00:00:00Z", "month"), "2026-03");
    assert.equal(formatEventTime("2026-03-01T00:00:00Z", "year"), "2026");
    assert.equal(formatEventTime("2026-03-14T00:00:00Z", "day"), "2026-03-14");
    assert.equal(formatEventTime(null, "day"), null);
  });
});

describe("답 꾸러미 세계 시각과 충돌 속성", () => {
  const base = (id, extra = {}) => ({
    id, type: "fact", topic: "ops", content: `${id} body`, created_at: "2026-10-12T00:00:00Z",
    valid_to: null, assertion_status: "observed", ...extra
  });

  it("mentioned, event, conflicts_with를 여는 줄에 싣는다", () => {
    const pack = buildAnswerPack([
      base("a", { mention_time: "2023-05-20T02:21:00Z", event_time: "2023-05-08T00:00:00Z", event_time_precision: "week",
        event_time_end: "2023-05-15T00:00:00Z", conflicts_with: ["b"] })
    ]);
    const header = pack.text.split("\n").find(line => line.startsWith(PACK_BLOCK_OPEN));
    assert.match(header, /mentioned=2023-05-20/);
    assert.match(header, /event=2023-05-08 /);
    assert.match(header, /conflicts_with="b"/);
    assert.equal(pack.items[0].event, "2023-05-08");
  });

  it("값이 없으면 속성을 싣지 않는다", () => {
    const header = buildAnswerPack([base("a")]).text.split("\n").find(line => line.startsWith(PACK_BLOCK_OPEN));
    assert.doesNotMatch(header, /mentioned=|event=|conflicts_with=/);
  });

  it("order=chronological이면 묶음으로 다시 줄 세우지 않는다", () => {
    const frags = [base("x1", { topic: "t1" }), base("y1", { topic: "t2" }), base("x2", { topic: "t1" })];
    assert.deepEqual(buildAnswerPack(frags).items.map(i => i.id), ["x1", "x2", "y1"]);
    assert.deepEqual(buildAnswerPack(frags, { order: "chronological" }).items.map(i => i.id), ["x1", "y1", "x2"]);
  });
});

describe("annotateFragmentState", () => {
  /** 질의 문장으로 응답을 고르는 가짜 풀 */
  const fakePool = ({ conflicts = [], predecessors = [] }) => () => ({
    query: async (sql) => ({ rows: sql.includes("'contradicts'") ? conflicts : predecessors })
  });

  it("유효한 충돌 상대를 conflicts_with와 state=conflict로 단다", async () => {
    const out = await annotateFragmentState([{ id: "a" }, { id: "b" }], {}, {
      getPool: fakePool({ conflicts: [{ item_id: "a", other_id: "z" }] })
    });
    assert.deepEqual(out[0].conflicts_with, ["z"]);
    assert.equal(out[0].state, "conflict");
    assert.equal(out[1].state, undefined);
  });

  it("includeHistory면 이전 값을 대체한 파편 바로 뒤에 끼운다", async () => {
    const out = await annotateFragmentState([{ id: "new" }, { id: "other" }], {}, {
      includeHistory: true,
      getPool: fakePool({ predecessors: [{ _successor_id: "new", id: "old", content: "old value", valid_to: "2026-01-01" }] })
    });
    assert.deepEqual(out.map(f => f.id), ["new", "old", "other"]);
    assert.equal(out[0].state, "current");
    assert.equal(out[1].state, "superseded");
    assert.deepEqual(out[1].superseded_by, ["new"]);
    assert.equal("_successor_id" in out[1], false);
  });

  it("이전 값은 상한까지만 끼우고 이미 결과에 있는 파편은 다시 넣지 않는다", async () => {
    const predecessors = Array.from({ length: 8 }, (_, i) => ({ _successor_id: "new", id: `old${i}` }));
    predecessors.unshift({ _successor_id: "new", id: "other" });
    const out = await annotateFragmentState([{ id: "new" }, { id: "other" }], {}, {
      includeHistory: true, maxHistory: 5, getPool: fakePool({ predecessors })
    });
    assert.equal(out.filter(f => f.state === "superseded").length, 5);
    assert.equal(out.filter(f => f.id === "other").length, 1);
  });

  it("includeHistory가 아니면 이전 값을 조회하지 않는다", async () => {
    const queries = [];
    const out = await annotateFragmentState([{ id: "a" }], {}, {
      getPool: () => ({ query: async (sql) => { queries.push(sql); return { rows: [] }; } })
    });
    /** 충돌 상대와 근거 상태(support_state)만 읽고, 이전 값(superseded_by 체인)은 읽지 않는다 */
    assert.equal(queries.length, 2);
    assert.ok(queries.some(sql => /support_state/.test(sql)));
    assert.ok(!queries.some(sql => /'superseded_by'/.test(sql)));
    assert.deepEqual(out, [{ id: "a" }]);
  });
});
