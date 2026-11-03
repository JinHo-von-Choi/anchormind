-- migration-077-group-fragment-limit.sql
--
-- 작성자: 최진호
-- 작성일: 2026-11-04
--
-- 키 그룹 단위 파편 상한. 그룹 멤버 키 전체의 살아 있는 파편 수가 이 값에 이르면 멤버 키의 새 저장을 거부한다
-- (lib/memory/read/quotaQueries.js lockQuota). NULL은 상한 없음이며 기존 그룹은 모두 NULL로 시작한다.
-- 키 상한(api_keys.fragment_limit)과 함께 적용되고, 둘 중 남은 수가 적은 쪽이 먼저 걸린다.
-- 멱등: 열과 제약이 이미 있으면 다시 만들지 않는다.

SET LOCAL lock_timeout = '3s';

ALTER TABLE agent_memory.api_key_groups
  ADD COLUMN IF NOT EXISTS fragment_limit INTEGER;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'api_key_groups_fragment_limit_check'
       AND conrelid = 'agent_memory.api_key_groups'::regclass
  ) THEN
    ALTER TABLE agent_memory.api_key_groups
      ADD CONSTRAINT api_key_groups_fragment_limit_check CHECK (fragment_limit IS NULL OR fragment_limit >= 0);
  END IF;
END $$;
