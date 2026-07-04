-- NOTE: vector_cosine_ops is auto-replaced by migrate.js with the correct
--       ops class (halfvec_cosine_ops when embedding column is halfvec type).
-- Migration 019: HNSW index tuning for improved L3 search latency
-- Current:  m=16, ef_construction=64  (default ef_search=40)
-- Target:   m=16, ef_construction=128 (ef_search=80 set at session level)
--
-- Background:
--   181,765 embeddings / 303,100 total fragments (3.6 GB table)
--   L3 latency: p50=327ms, p90=1696ms before this tuning.
--   Raising ef_construction from 64 to 128 improves recall at the cost of
--   a longer one-time build.  ef_search=80 (applied via SET LOCAL in each
--   transaction) halves the search candidate list relative to ef_construction,
--   which is the recommended starting ratio for recall/latency balance.
--
-- WARNING: REINDEX on 181K vectors takes several minutes.
--          Run during a low-traffic window.
--          This migration does NOT use CONCURRENTLY because it is designed
--          to be executed inside a migration script that wraps statements
--          in a transaction; CONCURRENTLY is incompatible with transactions.

DROP INDEX IF EXISTS agent_memory.idx_frag_embedding;

CREATE INDEX idx_frag_embedding
  ON agent_memory.fragments
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128)
  WHERE (embedding IS NOT NULL);
