/**
 * CaseRecall 확장 조회가 seed 검색의 isAnchor 3상태 계약을 유지하는지 검증한다.
 */
import { after, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

const queries = [];
const representativeRows = [
  {
    case_id          : "synthetic-case",
    goal             : "anchor goal",
    outcome          : "anchor outcome",
    resolution_status: "resolved",
    phase            : "verification",
    is_anchor        : true,
    fragment_count   : "1"
  },
  {
    case_id          : "synthetic-case",
    goal             : "non-anchor goal",
    outcome          : "non-anchor outcome",
    resolution_status: "open",
    phase            : "debugging",
    is_anchor        : false,
    fragment_count   : "1"
  }
];
const eventRows = [
  {
    case_id   : "synthetic-case",
    event_type: "verification_passed",
    summary   : "first historical event",
    created_at: "2026-01-01T00:00:00.000Z"
  },
  {
    case_id   : "synthetic-case",
    event_type: "error_observed",
    summary   : "second historical event",
    created_at: "2026-01-02T00:00:00.000Z"
  },
  {
    case_id   : "synthetic-case",
    event_type: "decision_committed",
    summary   : "case-level event without source fragment",
    created_at: "2026-01-03T00:00:00.000Z"
  }
];

mock.module("../../lib/tools/db.js", {
  exports: {
    getPrimaryPool: () => ({
      query: async (sql, params) => {
        queries.push({ sql, params });
        const requestedAnchor = params.find(value => typeof value === "boolean");
        return sql.includes("case_events")
          ? { rows: eventRows.map(row => ({ ...row })) }
          : {
              rows: representativeRows
                .filter(row => requestedAnchor === undefined || row.is_anchor === requestedAnchor)
                .map(row => ({ ...row }))
            };
      }
    })
  }
});

mock.module("../../lib/logger.js", {
  exports: { logWarn: mock.fn() }
});

const { CaseRecall } = await import("../../lib/memory/read/CaseRecall.js");

beforeEach(() => {
  queries.length = 0;
});

describe("CaseRecall isAnchor 3상태", () => {
  async function build(isAnchor, extraOptions = {}) {
    const seed = {
      id       : isAnchor === false ? "non-anchor-seed" : "anchor-seed",
      case_id  : "synthetic-case",
      is_anchor: isAnchor
    };
    const options = { maxCases: 5, ...extraOptions };
    if (isAnchor !== undefined) options.isAnchor = isAnchor;
    return new CaseRecall().buildCaseTriples([seed], options);
  }

  it("true는 앵커 대표값·상태·count를 사용하되 case 타임라인은 온전히 유지한다", async () => {
    const cases = await build(true);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].goal, "anchor goal");
    assert.equal(cases[0].outcome, "anchor outcome");
    assert.equal(cases[0].resolution_status, "resolved");
    assert.equal(cases[0].fragment_count, 1);
    assert.deepEqual(cases[0].events.map(event => event.summary), [
      "first historical event",
      "second historical event",
      "case-level event without source fragment"
    ]);
    assert.ok(queries[0].params.includes(true));
    assert.ok(!queries[1].params.includes(true));
    assert.match(queries[0].sql, /is_anchor = \$/);
    assert.doesNotMatch(queries[1].sql, /JOIN .*fragments f ON/);
  });

  it("false는 비앵커 대표값·상태·count를 사용하되 같은 case 타임라인을 유지한다", async () => {
    const cases = await build(false);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].goal, "non-anchor goal");
    assert.equal(cases[0].outcome, "non-anchor outcome");
    assert.equal(cases[0].resolution_status, "open");
    assert.equal(cases[0].fragment_count, 1);
    assert.deepEqual(cases[0].events.map(event => event.summary), [
      "first historical event",
      "second historical event",
      "case-level event without source fragment"
    ]);
    assert.ok(queries[0].params.includes(false));
    assert.ok(!queries[1].params.includes(false));
  });

  it("미지정은 기존 혼합 case 확장 의미를 유지한다", async () => {
    const cases = await build(undefined);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].goal, "anchor goal");
    assert.deepEqual(
      cases[0].events.map(event => event.summary),
      ["first historical event", "second historical event", "case-level event without source fragment"]
    );
    assert.doesNotMatch(queries[0].sql, /is_anchor = \$/);
    assert.doesNotMatch(queries[1].sql, /JOIN .*fragments f ON/);
  });

  it("includeSuperseded=true는 대표 파편의 valid_to 조건을 제거하며 event 이력에는 영향을 주지 않는다", async () => {
    await build(true, { includeSuperseded: true });

    assert.doesNotMatch(queries[0].sql, /valid_to IS NULL/);
    assert.doesNotMatch(queries[1].sql, /valid_to IS NULL/);
    assert.doesNotMatch(queries[1].sql, /JOIN .*fragments f ON/);
  });

  it("isAnchor 미지정 event 조회도 case_id와 함께 key_id를 격리한다", async () => {
    await build(undefined, { keyId: "synthetic-key" });

    assert.match(queries[1].sql, /ce\.key_id = \$/);
    assert.ok(queries[1].params.includes("synthetic-key"));
  });

  it("isAnchor 지정 여부와 무관하게 event 조회는 case_events 자체 key_id로 격리한다", async () => {
    await build(true, { keyId: "synthetic-key" });

    assert.match(queries[1].sql, /ce\.key_id = \$/);
    assert.doesNotMatch(queries[1].sql, /f\.key_id = \$/);
    assert.ok(queries[1].params.includes("synthetic-key"));
  });

  it("같은 case의 앵커/비앵커 대표 선택이 바뀌어도 과거 event 타임라인은 안정적이다", async () => {
    const anchored = await build(true);
    const ordinary = await build(false);

    assert.deepEqual(anchored[0].events, ordinary[0].events);
    assert.ok(queries
      .filter(({ sql }) => sql.includes("case_events"))
      .every(({ sql, params }) => !sql.includes("source_fragment_id") && !params.some(value => typeof value === "boolean")));
  });
});
