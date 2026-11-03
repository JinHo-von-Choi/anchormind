-- migration-079-key-workspace-aliases.sql
--
-- 작성자: 최진호
-- 작성일: 2026-11-04
--
-- 키별 workspace 별칭. 같은 프로젝트가 '/home/u/jobs/proj'와 'proj'처럼 여러 이름으로 갈라졌을 때, 별칭으로 들어온
-- 요청(읽기와 쓰기)을 정식 이름으로 바꾼다(lib/keys/workspace-alias.js). 이미 별칭 이름으로 저장된 파편은
-- memento-mcp workspace merge로 옮긴다. 경로의 마지막 조각을 자동으로 쓰지 않는 이유는 서로 다른 경로가 같은
-- 조각으로 끝나는 경우(임시 작업 디렉터리의 worktree 등)가 많아서다.
-- 멱등: 표가 이미 있으면 다시 만들지 않는다.

CREATE TABLE IF NOT EXISTS agent_memory.key_workspace_aliases (
  key_id     TEXT        NOT NULL REFERENCES agent_memory.api_keys(id) ON DELETE CASCADE,
  alias      TEXT        NOT NULL CHECK (length(alias) BETWEEN 1 AND 4096),
  workspace  TEXT        NOT NULL CHECK (length(workspace) BETWEEN 1 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (key_id, alias),
  CHECK (alias <> workspace)
);
