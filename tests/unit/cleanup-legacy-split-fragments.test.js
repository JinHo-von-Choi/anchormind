/**
 * Unit tests: legacy split cleanup is dry-run by default and never deletes
 * without explicit --apply + --yes.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const queries = [];
mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => ({
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (/count\(\*\)/i.test(sql)) return { rows: [{ n: "4200" }] };
        if (/SELECT id, content/i.test(sql)) return { rows: [{ id: "a", content: "x" }] };
        return { rowCount: 0, rows: [] };
      }
    })
  }
});

const { runCleanup, buildSelectionWhere } = await import("../../scripts/cleanup-legacy-split-fragments.js");

describe("legacy split cleanup", () => {
  it("selection WHERE targets only non-live-parent split children", () => {
    const where = buildSelectionWhere();
    assert.match(where, /source\s+LIKE\s+'split:%'/i);
    assert.match(where, /importance\s*<\s*0\.4/i);
    assert.match(where, /NOT\s+EXISTS/i);
  });

  it("dry-run mode issues no DELETE", async () => {
    queries.length = 0;
    await runCleanup({ apply: false, yes: false });
    assert.ok(!queries.some(q => /DELETE/i.test(q.sql)), "no DELETE in dry-run");
  });

  it("refuses to delete with --apply but without --yes", async () => {
    queries.length = 0;
    await runCleanup({ apply: true, yes: false });
    assert.ok(!queries.some(q => /DELETE/i.test(q.sql)), "missing --yes blocks delete");
  });

  it("deletes only with --apply and --yes", async () => {
    queries.length = 0;
    await runCleanup({ apply: true, yes: true });
    assert.ok(queries.some(q => /DELETE/i.test(q.sql)), "apply+yes performs delete");
  });
});
