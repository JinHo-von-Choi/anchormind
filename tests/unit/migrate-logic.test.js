import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { alignSyntheticQueryEmbedding } from "../../scripts/align-synthetic-query-embedding.js";

describe("migration file sorting", () => {
  it("sorts migration files numerically", () => {
    const files = [
      "migration-010-ema-activation.sql",
      "migration-002-decay.sql",
      "migration-001-temporal.sql",
      "migration-013-search-events.sql"
    ];
    const sorted = files.sort();
    assert.deepStrictEqual(sorted, [
      "migration-001-temporal.sql",
      "migration-002-decay.sql",
      "migration-010-ema-activation.sql",
      "migration-013-search-events.sql"
    ]);
  });

  it("filters only migration SQL files", () => {
    const files = ["memory-schema.sql", "migration-001-temporal.sql", "migration-002-decay.sql", "README.md"];
    const migrations = files.filter(f => f.startsWith("migration-") && f.endsWith(".sql"));
    assert.strictEqual(migrations.length, 2);
  });

  it("detects unapplied migrations", () => {
    const all = ["migration-001-temporal.sql", "migration-002-decay.sql", "migration-003-api-keys.sql"];
    const applied = new Set(["migration-001-temporal.sql", "migration-002-decay.sql"]);
    const pending = all.filter(f => !applied.has(f));
    assert.deepStrictEqual(pending, ["migration-003-api-keys.sql"]);
  });
});

const column = (udtName, declaredDim) => ({ udtName, declaredDim });

/** Exercise the real catalog-query helper with a dependency-free fake client. */
function fakeEmbeddingClient(source, target, { failOn, error, rollbackError } = {}) {
  const queries = [];
  const client = {
    queries,
    async query(sql, params) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      queries.push({ sql: normalized, params });
      if (normalized.includes("FROM pg_attribute")) {
        assert.ok(params[1] === "fragments" || params[1] === "fragment_synthetic_query");
        assert.deepStrictEqual(params, ["agent_memory", params[1]]);
        const spec = params[1] === "fragments" ? source : target;
        return { rows: spec ? [{ udt_name: spec.udtName, declared_dim: spec.declaredDim }] : [] };
      }
      if (normalized === "ROLLBACK" && rollbackError) throw rollbackError;
      if (failOn?.test(normalized)) throw error;
      return { rows: [] };
    }
  };
  return client;
}

function statements(client) {
  return client.queries.filter(q => !q.sql.includes("FROM pg_attribute")).map(q => q.sql);
}

function expectedConversion(type, dims) {
  return [
    "BEGIN",
    "LOCK TABLE agent_memory.fragment_synthetic_query IN ACCESS EXCLUSIVE MODE",
    "DROP INDEX IF EXISTS agent_memory.idx_fsq_embedding_hnsw",
    "DELETE FROM agent_memory.fragment_synthetic_query",
    `ALTER TABLE agent_memory.fragment_synthetic_query ALTER COLUMN embedding TYPE ${type}(${dims}) USING NULL`,
    `CREATE INDEX idx_fsq_embedding_hnsw ON agent_memory.fragment_synthetic_query USING hnsw (embedding ${type}_cosine_ops) WITH (m = 16, ef_construction = 128) WHERE embedding IS NOT NULL`,
    "COMMIT"
  ];
}

describe("synthetic-query embedding alignment", () => {
  for (const spec of [column("vector", 384), column("halfvec", 3072)]) {
    it(`leaves an already aligned ${spec.udtName}(${spec.declaredDim}) table untouched`, async () => {
      const client = fakeEmbeddingClient(spec, spec);
      const type = `${spec.udtName}(${spec.declaredDim})`;
      assert.deepStrictEqual(await alignSyntheticQueryEmbedding(client), {
        action: "skip", reason: "already_aligned", sourceType: type, targetType: type
      });
      assert.strictEqual(client.queries.length, 2);
      assert.deepStrictEqual(statements(client), []);
    });
  }

  for (const [name, source, target] of [
    ["source", null, column("vector", 1536)],
    ["target", column("vector", 384), null],
    ["both", null, null]
  ]) {
    it(`skips without any writes when ${name} embedding columns are missing`, async () => {
      const client = fakeEmbeddingClient(source, target);
      assert.deepStrictEqual(await alignSyntheticQueryEmbedding(client), {
        action: "skip", reason: "embedding_column_missing"
      });
      assert.strictEqual(client.queries.length, 2);
      assert.deepStrictEqual(statements(client), []);
    });
  }

  for (const [source, target] of [
    [column("vector", 384), column("vector", 1536)],
    [column("halfvec", 384), column("vector", 384)],
    [column("halfvec", 3072), column("vector", 1536)],
    [column("vector", 384), column("halfvec", 384)],
    [column("vector", 384), column("vector", null)]
  ]) {
    const sourceType = `${source.udtName}(${source.declaredDim})`;
    const targetType = `${target.udtName}(${target.declaredDim ?? "unspecified"})`;
    it(`repairs ${targetType} -> ${sourceType} and deletes derived rows before changing type`, async () => {
      const client = fakeEmbeddingClient(source, target);
      assert.deepStrictEqual(await alignSyntheticQueryEmbedding(client), {
        action: "converted", sourceType, targetType
      });
      assert.strictEqual(client.queries.length, 9);
      // Exact ordering also guards against writes to fragments/morpheme_dict,
      // leftover NULL rows that block backfill, and schema-qualified CREATE INDEX.
      assert.deepStrictEqual(statements(client), expectedConversion(source.udtName, source.declaredDim));
    });
  }

  for (const source of [
    column("text", 384),
    column("vector); DROP TABLE fragments; --", 384),
    column("vector", null),
    column("vector", 0),
    column("vector", -1),
    column("vector", 1.5),
    column("vector", "384"),
    column("vector", "384); DROP TABLE fragments; --")
  ]) {
    it(`does not interpolate unsupported source ${source.udtName}(${source.declaredDim})`, async () => {
      const client = fakeEmbeddingClient(source, column("vector", 1536));
      const result = await alignSyntheticQueryEmbedding(client);
      assert.strictEqual(result.action, "skip");
      assert.ok(result.reason.startsWith("unsupported_source_type:"));
      assert.deepStrictEqual(statements(client), []);
    });
  }

  for (const failedStatement of expectedConversion("vector", 384)) {
    it(`rolls back and retains the original PostgreSQL error when ${failedStatement.split(" ")[0]} fails`, async () => {
      const original = Object.assign(new Error("test PostgreSQL failure"), { code: "XX000" });
      const client = fakeEmbeddingClient(column("vector", 384), column("vector", 1536), {
        failOn: new RegExp(`^${failedStatement.split(" ")[0]}(?: |$)`), error: original
      });
      await assert.rejects(alignSyntheticQueryEmbedding(client), err => {
        assert.match(err.message, /synthetic-query embedding alignment failed \(vector\(1536\) -> vector\(384\)\)/);
        assert.strictEqual(err.cause, original);
        assert.strictEqual(err.cause.code, "XX000");
        return true;
      });
      const expected = expectedConversion("vector", 384);
      assert.deepStrictEqual(statements(client), [
        ...expected.slice(0, expected.indexOf(failedStatement) + 1), "ROLLBACK"
      ]);
    });
  }

  it("preserves the original error even if rollback also fails", async () => {
    const original = new Error("original CREATE INDEX failure");
    const client = fakeEmbeddingClient(column("vector", 384), column("vector", 1536), {
      failOn: /^CREATE INDEX /, error: original, rollbackError: new Error("connection lost")
    });
    await assert.rejects(alignSyntheticQueryEmbedding(client), err => {
      assert.strictEqual(err.cause, original);
      return true;
    });
    assert.strictEqual(statements(client).at(-1), "ROLLBACK");
    assert.ok(!statements(client).includes("COMMIT"));
  });
});
