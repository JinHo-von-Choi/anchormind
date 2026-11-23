-- migration-084-retention-mode.sql
--
-- 작성자: 최진호
-- 작성일: 2026-11-23
--
-- 키(또는 키의 workspace 하나)마다 자동 정리를 끄고 보존 기간을 따로 정할 수 있게 key_retention_policies를 넓힌다.
--   max_age_days    NULL을 허용한다. NULL은 이 행이 보존 기간을 정하지 않는다는 뜻이다(기간은 다른 행에서 물려받는다).
--   no_expiry       TRUE면 이 범위는 보존 기간으로 만료하지 않는다. workspace 행이면 키 전체 기간을 물려받지 않는다.
--   auto_lifecycle  FALSE면 이 범위에서 정리 주기와 저장 경로가 자동 판단으로 파편을 지우거나 닫거나 permanent를
--                   해제하지 않는다(lib/memory/consolidate/RetentionGuard.js). 보존 기간 만료는 그대로 적용한다.
--   auto_resume_at  자동 정리를 다시 켤 때 실제로 시작하는 시각. 이 시각 전에는 auto_lifecycle=FALSE와 같이 다룬다.
-- 기존 행은 no_expiry=FALSE, auto_lifecycle=TRUE, auto_resume_at=NULL이 되어 의미가 그대로다.
-- 아무 효과가 없는 행(기간도 no_expiry도 없고 자동 정리가 켜져 있으며 재개 시각도 없는 행)은 막는다.
-- 멱등: 열과 제약이 이미 있으면 다시 만들지 않는다.

SET LOCAL lock_timeout = '3s';

ALTER TABLE agent_memory.key_retention_policies ALTER COLUMN max_age_days DROP NOT NULL;
ALTER TABLE agent_memory.key_retention_policies ADD COLUMN IF NOT EXISTS no_expiry      BOOLEAN     NOT NULL DEFAULT FALSE;
ALTER TABLE agent_memory.key_retention_policies ADD COLUMN IF NOT EXISTS auto_lifecycle BOOLEAN     NOT NULL DEFAULT TRUE;
ALTER TABLE agent_memory.key_retention_policies ADD COLUMN IF NOT EXISTS auto_resume_at TIMESTAMPTZ;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'agent_memory.key_retention_policies'::regclass
       AND conname  = 'key_retention_policies_no_expiry_check'
  ) THEN
    ALTER TABLE agent_memory.key_retention_policies
      ADD CONSTRAINT key_retention_policies_no_expiry_check CHECK (NOT no_expiry OR max_age_days IS NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'agent_memory.key_retention_policies'::regclass
       AND conname  = 'key_retention_policies_effect_check'
  ) THEN
    ALTER TABLE agent_memory.key_retention_policies
      ADD CONSTRAINT key_retention_policies_effect_check CHECK (
        max_age_days IS NOT NULL OR no_expiry OR NOT auto_lifecycle OR auto_resume_at IS NOT NULL
      );
  END IF;
END $$;
