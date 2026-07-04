-- migration-010: ACT-R EMA 활성화 근사를 위한 fragments 컬럼 추가
--
-- ema_activation   : 지수 이동 평균 기반 ACT-R 기저 활성화 근사값
-- ema_last_updated : 마지막 EMA 갱신 시각 (incrementAccess 호출 시 갱신)
--
-- 작성자: 최진호
-- 작성일: 2026-03-11
--
-- 실행: psql $DATABASE_URL -f lib/memory/migration-010-ema-activation.sql

ALTER TABLE agent_memory.fragments
  ADD COLUMN IF NOT EXISTS ema_activation    FLOAT    DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS ema_last_updated  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_fragments_ema_activation
  ON agent_memory.fragments (ema_activation DESC);
