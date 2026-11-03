import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

let sourceRow;
let duplicateRow;
let writes;
let scoredQuery;
let warnings;
let sourceQuery;

mock.module("../../lib/memory/FragmentIndex.js", {
  namedExports: { deindexRows: async () => {} }
});

mock.module("../../lib/tools/db.js", {
  namedExports: {
    queryWithAgentVector: async (_agentId, sql, params, mode) => {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT id, content, topic, type, created_at, key_id")) {
        sourceQuery = { sql: normalized, params: [...params] };
        return { rows: sourceRow ? [{ ...sourceRow }] : [] };
      }
      if (normalized.includes("scored AS MATERIALIZED")) {
        scoredQuery = { sql: normalized, params: [...params] };
        return { rows: duplicateRow ? [{ kind: "dedup", ...duplicateRow }] : [] };
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
    key_id: "key-web",
    workspace: "ws-a"
  };
  duplicateRow = {
    id: "frag-a",
    content: "batch canary marker=batch-a",
    created_at: "2026-09-09T05:25:43.875Z",
    similarity: "0.9926964636264142"
  };
  writes = [];
  scoredQuery = null;
  sourceQuery = null;
  warnings = [];
});

test("high semantic similarity does not retire distinct batch memories", async () => {
  const count = await new GraphLinker().linkFragment("frag-b", "system", null, []);

  assert.equal(count, 0);
  assert.equal(writes.length, 0, "different content must never be soft-deleted as an exact duplicate");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Near-duplicate detected/);
  /** 중복 판정은 같은 key 범위의 이전 파편에서만 고르고, 링크 후보도 같은 key 범위에서 고른다. */
  assert.match(scoredQuery.sql, /AND f\.key_id = \$5/);
  assert.match(scoredQuery.sql, /similarity >= 0\.90 AND same_workspace AND \(created_at < \$3::timestamptz/);
  assert.match(scoredQuery.sql, /similarity > 0\.7/);
  assert.deepEqual(scoredQuery.params, [
    "frag-b",
    "batch-canary",
    "2026-09-09T05:25:43.875Z",
    "ws-a",
    "key-web"
  ]);
});

test("the duplicate verdict compares only rows in the same workspace", async () => {
  await new GraphLinker().linkFragment("frag-b", "system", null, []);

  /** 같은 본문을 다른 workspace에 둔 파편은 중복 판정 대상이 아니다. 전역(NULL)끼리는 같은 workspace로 본다. */
  assert.match(scoredQuery.sql, /f\.workspace IS NOT DISTINCT FROM \$4::text AS same_workspace/);
  sourceRow.workspace = null;
  await new GraphLinker().linkFragment("frag-b", "system", null, []);
  assert.equal(scoredQuery.params[3], null);
});

test("retired rows are excluded from the source, dedup, and candidate lookups", async () => {
  await new GraphLinker().linkFragment("frag-b", "system", null, []);

  assert.match(sourceQuery.sql, /WHERE id = \$1 AND embedding IS NOT NULL AND valid_to IS NULL/);
  /** 중복 판정과 후보는 같은 scored 집합에서 고르므로 그 집합이 닫힌 파편을 빼야 한다. */
  assert.match(scoredQuery.sql, /scored AS MATERIALIZED \( SELECT .* AND f\.embedding IS NOT NULL AND f\.valid_to IS NULL/);
});

test("a source without key_id compares only against rows without key_id", async () => {
  sourceRow.key_id = null;
  await new GraphLinker().linkFragment("frag-b", "system", null, []);

  assert.match(scoredQuery.sql, /AND f\.key_id IS NULL/);
  assert.equal(scoredQuery.params.length, 4);
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
  assert.equal(scoredQuery, null);
  assert.equal(writes.length, 0);
});
