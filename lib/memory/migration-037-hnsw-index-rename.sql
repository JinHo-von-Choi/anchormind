-- NOTE: vector_cosine_ops is auto-replaced by migrate.js with the correct
--       ops class (halfvec_cosine_ops when embedding column is halfvec type).
-- Migration 037: HNSW 인덱스명 정합화 + ef_construction 64→128
--
-- Background:
--   운영 인덱스 실제명이 fragments_new_embedding_idx(ef_construction=64)로,
--   코드/migration-019가 기대하는 idx_frag_embedding과 불일치하여 튜닝이 무효였다.
--
-- WARNING: 운영 적용은 저트래픽 윈도에서 아래를 수동 실행한다(트랜잭션 밖, CONCURRENTLY):
--   CREATE INDEX CONCURRENTLY idx_frag_embedding ON agent_memory.fragments
--     USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=128)
--     WHERE (embedding IS NOT NULL);
--   DROP INDEX CONCURRENTLY IF EXISTS agent_memory.fragments_new_embedding_idx;
-- 아래 본문은 신규 설치/테스트 환경(빈 테이블)용이다.

DROP INDEX IF EXISTS agent_memory.fragments_new_embedding_idx;
DROP INDEX IF EXISTS agent_memory.idx_frag_embedding;

CREATE INDEX idx_frag_embedding
  ON agent_memory.fragments
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128)
  WHERE (embedding IS NOT NULL);
