/**
 * Align the derived synthetic-query embedding column with fragments.embedding.
 *
 * migration-043 uses the default vector(1536) schema because SQL migrations
 * cannot read the runtime embedding configuration. Existing installations may
 * already use another dimension, so this repair runs after numbered migrations
 * and uses the canonical fragments column as the source of truth.
 */

import { fetchEmbeddingColumn } from "../lib/memory/embedding/column-spec.js";

const SCHEMA          = "agent_memory";
const SOURCE_TABLE    = "fragments";
const TARGET_TABLE    = "fragment_synthetic_query";
const TARGET_INDEX    = "idx_fsq_embedding_hnsw";
const SUPPORTED_TYPES = new Set(["vector", "halfvec"]);

function fixedType(column) {
  if (!column || !SUPPORTED_TYPES.has(column.udtName)) return null;
  if (!Number.isInteger(column.declaredDim) || column.declaredDim <= 0) return null;
  return `${column.udtName}(${column.declaredDim})`;
}

function describe(column) {
  if (!column) return "column missing";
  return `${column.udtName}(${column.declaredDim ?? "unspecified"})`;
}

/**
 * Align the derived table without changing fragments or morpheme_dict.
 * Delete derived rows on a type change so SyntheticQueryWorker.backfill() can
 * select their fragments again. Keeping rows with NULL embeddings would leave
 * them excluded by backfill's NOT EXISTS check.
 *
 * @param {import("pg").PoolClient} client
 * @returns {Promise<{action: string, reason?: string, sourceType?: string, targetType?: string}>}
 */
export async function alignSyntheticQueryEmbedding(client) {
  const source = await fetchEmbeddingColumn(client, SCHEMA, SOURCE_TABLE);
  const target = await fetchEmbeddingColumn(client, SCHEMA, TARGET_TABLE);

  if (!source || !target) {
    return { action: "skip", reason: "embedding_column_missing" };
  }

  const sourceType = fixedType(source);
  const targetType = fixedType(target);
  if (!sourceType) {
    return { action: "skip", reason: `unsupported_source_type:${describe(source)}` };
  }

  if (source.udtName === target.udtName && source.declaredDim === target.declaredDim) {
    return { action: "skip", reason: "already_aligned", sourceType, targetType: targetType ?? describe(target) };
  }

  // The source type name and dimension are validated before interpolation.
  const opsType = `${source.udtName}_cosine_ops`;
  try {
    await client.query("BEGIN");
    // Prevent a concurrent worker from inserting rows between DELETE and ALTER,
    // including when the HNSW index is missing and DROP INDEX is a no-op.
    await client.query(`LOCK TABLE ${SCHEMA}.${TARGET_TABLE} IN ACCESS EXCLUSIVE MODE`);
    await client.query(`DROP INDEX IF EXISTS ${SCHEMA}.${TARGET_INDEX}`);
    await client.query(`DELETE FROM ${SCHEMA}.${TARGET_TABLE}`);
    await client.query(
      `ALTER TABLE ${SCHEMA}.${TARGET_TABLE}
         ALTER COLUMN embedding TYPE ${sourceType} USING NULL`
    );
    // PostgreSQL creates the index in the table's schema; its name must be unqualified.
    await client.query(
      `CREATE INDEX ${TARGET_INDEX}
         ON ${SCHEMA}.${TARGET_TABLE}
         USING hnsw (embedding ${opsType})
         WITH (m = 16, ef_construction = 128)
         WHERE embedding IS NOT NULL`
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error(
      `synthetic-query embedding alignment failed (${describe(target)} -> ${sourceType})`,
      { cause: err }
    );
  }

  return {
    action: "converted",
    sourceType,
    targetType: targetType ?? describe(target),
  };
}
