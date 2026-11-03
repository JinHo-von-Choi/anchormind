-- migration-073-group-member-permissions.sql
--
-- 작성자: 최진호
-- 작성일: 2026-11-04
--
-- 키 그룹 멤버 행마다 권한 목록을 둔다(lib/memory/groupGrants.js).
--   read    같은 그룹에서 share를 가진 다른 멤버의 파편을 읽는다
--   share   내 파편을 같은 그룹에서 read를 가진 다른 멤버가 읽게 한다
--   link    읽을 수 있는 다른 멤버의 파편에 링크를 건다
--   amend   읽을 수 있는 다른 멤버의 파편을 고친다
--   forget  읽을 수 있는 다른 멤버의 파편을 지운다
-- 기존 행은 기본값 read, share, link를 받는다. 이 열이 생기기 전의 그룹 동작과 같다.
--
-- shared_workspaces는 share가 열어 주는 workspace 목록이다. NULL은 전체다. 목록이 있으면 요청의 workspace가
-- 목록 안일 때만 그 멤버의 파편이 읽히며, 그때 그 workspace와 전역(workspace 없음) 파편이 보인다. 키 안에서
-- 전역 파편은 모든 workspace 화면에 함께 보이므로, workspace W를 공유하면 그 멤버의 W 화면을 공유하는 셈이다.
-- 멱등: 열과 제약이 이미 있으면 다시 만들지 않는다.

ALTER TABLE agent_memory.api_key_group_members
  ADD COLUMN IF NOT EXISTS permissions TEXT[] NOT NULL DEFAULT ARRAY['read', 'share', 'link']::text[];

ALTER TABLE agent_memory.api_key_group_members
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

ALTER TABLE agent_memory.api_key_group_members
  ADD COLUMN IF NOT EXISTS shared_workspaces TEXT[];

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'api_key_group_members_permissions_check'
       AND conrelid = 'agent_memory.api_key_group_members'::regclass
  ) THEN
    ALTER TABLE agent_memory.api_key_group_members
      ADD CONSTRAINT api_key_group_members_permissions_check
      CHECK (permissions <@ ARRAY['read', 'share', 'link', 'amend', 'forget']::text[]);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'api_key_group_members_shared_workspaces_check'
       AND conrelid = 'agent_memory.api_key_group_members'::regclass
  ) THEN
    ALTER TABLE agent_memory.api_key_group_members
      ADD CONSTRAINT api_key_group_members_shared_workspaces_check
      CHECK (shared_workspaces IS NULL OR cardinality(shared_workspaces) <= 64);
  END IF;
END $$;
