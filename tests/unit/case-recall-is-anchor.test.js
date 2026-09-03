/**
 * CaseRecall 확장 조회가 seed 검색의 isAnchor 3상태 계약을 유지하는지 검증한다.
 */
import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

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
    case_id        : "synthetic-case",
    event_type     : "verification_passed",
    summary        : "anchor event",
    created_at     : "2026-01-01T00:00:00.000Z",
    source_is_anchor: true
  },
  {
    case_id        : "synthetic-case",
    event_type     : "error_observed",
    summary        : "non-anchor event",
    created_at     : "2026-01-02T00:00:00.000Z",
    source_is_anchor: false
  }
];

mock.module("../../lib/tools/db.js", {
  exports: {
    getPrimaryPool: () => ({
      query: async (sql, params) => {
        queries.push({ sql, params });
        return sql.includes("case_events")
          ? { rows: eventRows.map(row => ({ ...row })) }
          : { rows: representativeRows.map(row => ({ ...row })) };
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
  async function build(isAnchor) {
    const seed = {
      id       : isAnchor === false ? "non-anchor-seed" : "anchor-seed",
      case_id  : "synthetic-case",
      is_anchor: isAnchor
    };
    const options = { maxCases: 5 };
    if (isAnchor !== undefined) options.isAnchor = isAnchor;
    return new CaseRecall().buildCaseTriples([seed], options);
  }

  it("true는 앵커 대표값·상태·count·event만 사용한다", async () => {
    const cases = await build(true);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].goal, "anchor goal");
    assert.equal(cases[0].outcome, "anchor outcome");
    assert.equal(cases[0].resolution_status, "resolved");
    assert.equal(cases[0].fragment_count, 1);
    assert.deepEqual(cases[0].events.map(event => event.summary), ["anchor event"]);
    assert.ok(queries.every(({ params }) => params.includes(true)));
    assert.match(queries[0].sql, /is_anchor = \$/);
    assert.match(queries[1].sql, /JOIN .*fragments f ON f\.id = ce\.source_fragment_id/);
  });

  it("false는 비앵커 대표값·상태·count·event만 사용한다", async () => {
    const cases = await build(false);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].goal, "non-anchor goal");
    assert.equal(cases[0].outcome, "non-anchor outcome");
    assert.equal(cases[0].resolution_status, "open");
    assert.equal(cases[0].fragment_count, 1);
    assert.deepEqual(cases[0].events.map(event => event.summary), ["non-anchor event"]);
    assert.ok(queries.every(({ params }) => params.includes(false)));
  });

  it("미지정은 기존 혼합 case 확장 의미를 유지한다", async () => {
    const cases = await build(undefined);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].goal, "anchor goal");
    assert.deepEqual(
      cases[0].events.map(event => event.summary),
      ["anchor event", "non-anchor event"]
    );
    assert.doesNotMatch(queries[0].sql, /is_anchor = \$/);
    assert.doesNotMatch(queries[1].sql, /JOIN .*fragments f ON/);
  });
});
