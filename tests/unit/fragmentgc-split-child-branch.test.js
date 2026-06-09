/**
 * Unit tests: FragmentGC includes a split-child cleanup branch.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const captured = [];
mock.module("../../lib/tools/db.js", {
  namedExports: {
    queryWithAgentVector: async (_ctx, sql, params) => {
      captured.push({ sql, params });
      return { rowCount: 0 };
    }
  }
});

const { FragmentGC } = await import("../../lib/memory/consolidate/FragmentGC.js");

describe("FragmentGC split-child branch", () => {
  it("includes a low-importance split-child GC branch", async () => {
    captured.length = 0;
    await new FragmentGC().deleteExpired();
    const { sql } = captured[0];
    assert.match(sql, /source\s+LIKE\s+'split:%'/i);
  });

  it("includes a parent-tombstoned split-child GC branch (drains the legacy backlog)", async () => {
    captured.length = 0;
    await new FragmentGC().deleteExpired();
    const { sql } = captured[0];
    // a correlated check that the parent of a split:<id> child is tombstoned/absent
    assert.match(sql, /parent\.valid_to\s+IS\s+NULL/i);
    assert.match(sql, /split_part\(child\.source,\s*':',\s*2\)/i);
  });
});
