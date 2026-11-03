-- migration-074-admin-binding-group-scope.sql
--
-- 작성자: 최진호
-- 작성일: 2026-11-04
--
-- 관리자 역할 바인딩에 키 그룹 범위(group_id)를 둔다. workspace 이름은 키마다 따로 쓰는 이름이라, workspace만으로
-- 묶은 바인딩은 같은 이름을 쓰는 모든 키의 파편을 열어 준다. 그래서 workspace 바인딩은 그룹 범위와 함께만 만든다.
--   group_id 없음, workspace 없음   설치 전체(전역)
--   group_id 있음, workspace 없음   그 그룹 멤버 키의 모든 workspace
--   group_id 있음, workspace 있음   그 그룹 멤버 키의 그 workspace
-- 그룹 범위가 없는 workspace 바인딩은 새로 만들지 못한다(검사 제약은 NOT VALID라 기존 행은 검사하지 않는다).
-- 기존 행은 판정에서 아무 능력도 주지 않는다(lib/admin/AdminAuthz.js).
-- 그룹을 지우면 그 그룹 범위 바인딩도 지운다.
-- 멱등: 열, 색인, 제약이 이미 있으면 다시 만들지 않는다.

ALTER TABLE agent_memory.admin_role_bindings
  ADD COLUMN IF NOT EXISTS group_id TEXT REFERENCES agent_memory.api_key_groups(id) ON DELETE CASCADE;

DROP INDEX IF EXISTS agent_memory.idx_admin_role_bindings_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_role_bindings_unique_scope
    ON agent_memory.admin_role_bindings (user_id, role, COALESCE(group_id, ''), COALESCE(workspace, ''));

CREATE INDEX IF NOT EXISTS idx_admin_role_bindings_group
    ON agent_memory.admin_role_bindings (group_id) WHERE group_id IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'admin_role_bindings_workspace_needs_group'
       AND conrelid = 'agent_memory.admin_role_bindings'::regclass
  ) THEN
    ALTER TABLE agent_memory.admin_role_bindings
      ADD CONSTRAINT admin_role_bindings_workspace_needs_group
      CHECK (workspace IS NULL OR group_id IS NOT NULL) NOT VALID;
  END IF;
END $$;
