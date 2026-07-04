-- migration-012-quality-verified.sql
-- quality_verified: MemoryEvaluator 'keep' 판정 여부
-- NULL=미평가, TRUE=검증됨, FALSE=discard/downgrade 판정
--
-- 기존 파편 처리:
--   is_anchor=TRUE → quality_verified=TRUE
--   importance>=0.9 → quality_verified=TRUE
--   나머지 → NULL (미검증)
--
-- 실행: psql $DATABASE_URL -f lib/memory/migration-012-quality-verified.sql

ALTER TABLE agent_memory.fragments
  ADD COLUMN IF NOT EXISTS quality_verified BOOLEAN DEFAULT NULL;

UPDATE agent_memory.fragments
SET quality_verified = TRUE
WHERE is_anchor = TRUE OR importance >= 0.9;

CREATE INDEX IF NOT EXISTS idx_fragments_quality_verified
  ON agent_memory.fragments (quality_verified)
  WHERE quality_verified IS NOT NULL;
