import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

let sourceRow;
let duplicateRow;
let writes;
let dedupQuery;
let candidateQuery;
let warnings;
let sourceQuery;

mock.module("../../lib/tools/db.js", {
  namedExports: {
    queryWithAgentVector: async (_agentId, sql, params, mode) => {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT id, content, topic, type, created_at, key_id")) {
        sourceQuery = { sql: normalized, params: [...params] };
        return { rows: sourceRow ? [{ ...sourceRow }] : [] };
      }
      if (normalized.includes(">= 0.90")) {
        dedupQuery = { sql: normalized, params: [...params] };
        return { rows: duplicateRow ? [{ ...duplicateRow }] : [] };
      }
      if (normalized.includes("> 0.7")) {
        candidateQuery = { sql: normalized, params: [...params] };
        return { rows: [] };
      }
      if (mode === "write") {
        writes.push({ sql: normalized, params: [...params] });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    }
  }
});

mock.module("../../lib/memory/write/FragmentStore.js", {
  namedExports: {
    FragmentStore: class FragmentStore {
      async createLink() {}
    }
  }
});

mock.module("../../lib/logger.js", {
  namedExports: {
    logDebug: () => {},
    logWarn: message => warnings.push(message)
  }
});

const { GraphLinker } = await import("../../lib/memory/link/GraphLinker.js");

beforeEach(() => {
  sourceRow = {
    id: "frag-b",
    content: "batch canary marker=batch-b",
    topic: "batch-canary",
    type: "fact",
    created_at: "2026-09-09T05:25:43.875Z",
    key_id: "key-web"
  };
  duplicateRow = {
    id: "frag-a",
    content: "batch canary marker=batch-a",
    created_at: "2026-09-09T05:25:43.875Z",
    similarity: "0.9926964636264142"
  };
  writes = [];
  dedupQuery = null;
  candidateQuery = null;
  sourceQuery = null;
  warnings = [];
});

test("high semantic similarity does not retire distinct batch memories", async () => {
  const count = await new GraphLinker().linkFragment("frag-b", "system", null, []);

  assert.equal(count, 0);
  assert.equal(writes.length, 0, "different content must never be soft-deleted as an exact duplicate");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Near-duplicate detected/);
  assert.match(dedupQuery.sql, /created_at < \$3::timestamptz/);
  assert.match(dedupQuery.sql, /key_id IS NOT DISTINCT FROM \$4/);
  assert.deepEqual(dedupQuery.params, [
    "frag-b",
    "batch-canary",
    "2026-09-09T05:25:43.875Z",
    "key-web"
  ]);
  assert.match(candidateQuery.sql, /key_id IS NOT DISTINCT FROM \$3/);
  assert.deepEqual(candidateQuery.params, ["frag-b", "batch-canary", "key-web"]);
});

test("retired rows are excluded from the source, dedup, and candidate lookups", async () => {
  await new GraphLinker().linkFragment("frag-b", "system", null, []);

  assert.match(sourceQuery.sql, /WHERE id = \$1 AND embedding IS NOT NULL AND valid_to IS NULL/);
  assert.match(dedupQuery.sql, /AND valid_to IS NULL AND \(created_at < \$3::timestamptz/);
  assert.match(candidateQuery.sql, /AND embedding IS NOT NULL AND valid_to IS NULL AND 1 - \(embedding/);
});

test("an older byte-identical memory remains the winner", async () => {
  duplicateRow.content = sourceRow.content;

  await new GraphLinker().linkFragment("frag-b", "system", null, []);

  assert.equal(writes.length, 2);
  assert.match(writes[0].sql, /SET valid_to = NOW\(\)/);
  assert.deepEqual(writes[0].params, ["frag-b"]);
  assert.match(writes[1].sql, /SET access_count = access_count \+ 1/);
  assert.deepEqual(writes[1].params, ["frag-a"]);
});

test("an already retired source is ignored", async () => {
  sourceRow = null;

  const count = await new GraphLinker().linkFragment("frag-b", "system", null, []);

  assert.equal(count, 0);
  assert.equal(dedupQuery, null);
  assert.equal(writes.length, 0);
});
