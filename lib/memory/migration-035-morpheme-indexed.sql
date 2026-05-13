-- migration-035-morpheme-indexed.sql
--
-- 작성자: 최진호
-- 작성일: 2026-04-27
--
-- 목적: morpheme_indexed 컬럼 추가 + 백필 + sparse index
--
--   fragments.morpheme_indexed BOOLEAN NOT NULL DEFAULT false
--   기존 행 중 keywords IS NOT NULL인 경우 true로 백필.
--   CREATE INDEX CONCURRENTLY 불가(트랜잭션 내 실행)이므로 일반 partial index 사용.
--   부분 인덱스(WHERE morpheme_indexed = false)로 미완료 파편 스캔 비용 최소화.
--
-- 멱등: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS


SET search_path TO agent_memory;

-- 1) 컬럼 추가 (이미 존재하면 skip)
ALTER TABLE fragments
  ADD COLUMN IF NOT EXISTS morpheme_indexed BOOLEAN NOT NULL DEFAULT false;

-- 2) 백필: keywords IS NOT NULL 인 기존 행을 true로 갱신
--    morpheme_indexed = false 행만 갱신하여 재실행 안전 보장
UPDATE fragments
   SET morpheme_indexed = true
 WHERE keywords IS NOT NULL
   AND morpheme_indexed = false;

-- 3) sparse partial index: morpheme_indexed=false 파편 빠른 스캔
CREATE INDEX IF NOT EXISTS idx_fragments_morpheme_indexed
    ON fragments (morpheme_indexed)
    WHERE morpheme_indexed = false;

