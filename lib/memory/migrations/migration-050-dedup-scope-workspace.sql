-- migration-050-dedup-scope-workspace.sql
-- 작성자: 최진호
-- 작성일: 2026-10-03
-- 목적: content_hash 중복 판정 범위를 키와 workspace 단위로 두는 유일 색인 2개.
--
--   uq_frag_hash_ws_per_key : 키 보유(key_id IS NOT NULL) 파편, (key_id, content_hash, workspace)
--   uq_frag_hash_ws_master  : 마스터(key_id IS NULL) 파편, (content_hash, workspace)
--
-- workspace NULL과 ''는 같은 칸이다(COALESCE).
-- 운영 DB는 scripts/ops/online-index.mjs 로 두 색인을 먼저 만든다(scripts/ops/index-manifest.json).
-- 아래 IF NOT EXISTS 문은 이미 만든 색인을 건너뛴다.
-- 키 범위 색인(uq_frag_hash_per_key, uq_frag_hash_master)은 이 파일에서 지우지 않는다.
-- 두 범위 색인이 함께 있는 동안 쓰기 경로는 키 범위로 판정하고, 키 범위 색인은 운영 단계로 지운다
-- (docs/operations/online-migration.md 「중복 판정 범위 전환」).

SET LOCAL lock_timeout = '3s';

CREATE UNIQUE INDEX IF NOT EXISTS uq_frag_hash_ws_per_key
    ON agent_memory.fragments (key_id, content_hash, (COALESCE(workspace, ''))) WHERE key_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_frag_hash_ws_master
    ON agent_memory.fragments (content_hash, (COALESCE(workspace, ''))) WHERE key_id IS NULL;
