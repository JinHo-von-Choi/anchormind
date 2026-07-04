-- migration-036-split-attempt-failed-at.sql
--
-- 작성자: 최진호
-- 작성일: 2026-06-09
--
-- 목적: 분할 실패 backoff 컬럼 추가.
--   splitLongFragments가 분할에 실패(LLM 실패 / 게이트 부분 산출)한 원본에
--   실패 시각을 기록하여, 후보 쿼리가 backoff 윈도우 내 재선정을 제외한다.
--   무한 재분할 루프(매 6h 동일 파편 재시도)를 차단한다.
--
-- 멱등: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS

SET search_path TO agent_memory;

ALTER TABLE fragments
  ADD COLUMN IF NOT EXISTS split_attempt_failed_at TIMESTAMPTZ NULL;

-- backoff 윈도우 외 후보를 빠르게 스캔하기 위한 partial index
CREATE INDEX IF NOT EXISTS idx_fragments_split_attempt_failed_at
    ON fragments (split_attempt_failed_at)
    WHERE split_attempt_failed_at IS NOT NULL;
