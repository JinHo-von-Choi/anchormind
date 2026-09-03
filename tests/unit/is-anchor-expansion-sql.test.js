/**
 * graph/linked/context 확장 SQL이 isAnchor 3상태 계약을 우회하지 않는지 검증한다.
 */
import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const queries = [];

mock.module("../../lib/tools/db.js", {
  exports: {
    getPrimaryPool: () => ({
      query: async (sql, params) => {
        queries.push({ sql, params });
        return { rows: [] };
      }
    })
  }
});

const { fetchLinkedFragments } = await import("../../lib/memory/read/LinkedFragmentLoader.js");
const {
  fetchCausalLinks,
  fetchSessionNeighbors
} = await import("../../lib/memory/read/StitchSourceLoader.js");

beforeEach(() => {
  queries.length = 0;
});

describe("isAnchor 확장 SQL", () => {
  it("linked preview는 false를 명시 SQL 조건으로 전달한다", async () => {
    await fetchLinkedFragments(["synthetic-fragment"], { isAnchor: false });
    const { sql, params } = queries.at(-1);
    assert.match(sql, /f\.is_anchor = \$/);
    assert.ok(params.includes(false));
  });

  it("causal link는 true를 양방향 SQL 조건으로 전달한다", async () => {
    await fetchCausalLinks(["synthetic-fragment"], { isAnchor: true });
    const { sql, params } = queries.at(-1);
    assert.equal((sql.match(/f\.is_anchor = \$/g) || []).length, 2);
    assert.ok(params.includes(true));
  });

  it("session neighbor는 false를 SQL 조건으로 전달한다", async () => {
    await fetchSessionNeighbors([
      {
        id        : "synthetic-fragment",
        session_id: "synthetic-session",
        created_at: "2026-01-01T00:00:00.000Z"
      }
    ], { isAnchor: false });
    const { sql, params } = queries.at(-1);
    assert.match(sql, /f\.is_anchor = \$/);
    assert.ok(params.includes(false));
  });

  it("미지정 시 확장 SQL에 앵커 조건을 추가하지 않는다", async () => {
    await fetchLinkedFragments(["synthetic-fragment"]);
    await fetchCausalLinks(["synthetic-fragment"]);
    await fetchSessionNeighbors([
      {
        id        : "synthetic-fragment",
        session_id: "synthetic-session",
        created_at: "2026-01-01T00:00:00.000Z"
      }
    ]);

    for (const { sql, params } of queries) {
      assert.doesNotMatch(sql, /f\.is_anchor = \$/);
      assert.ok(!params.includes(true) && !params.includes(false));
    }
  });
});
