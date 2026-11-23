-- migration-085-part-of-link-index.sql
--
-- 작성자: 최진호
-- 작성일: 2026-11-23
--
-- 살아 있는 part_of 링크만 담는 부분 색인 두 개.
-- MEMENTO_RETENTION_PROTECT_PART_OF를 켜면 만료 삭제, permanent 강등, 압축의 대상 질의가 파편마다 part_of 묶음이
-- 살아 있는지 본다(lib/memory/consolidate/RetentionGuard.js livePartOfIdsSql). part_of 링크는 전체 링크의 극히
-- 일부라서, 이 색인이 없으면 질의마다 링크 표 전체를 훑는다. 색인 조건은 그 질의의 조건과 같아야 쓰인다.
-- 멱등: 색인이 이미 있으면 다시 만들지 않는다.

SET LOCAL lock_timeout = '3s';

CREATE INDEX IF NOT EXISTS idx_fragment_links_part_of_from
    ON agent_memory.fragment_links (from_id, to_id)
 WHERE relation_type = 'part_of' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_fragment_links_part_of_to
    ON agent_memory.fragment_links (to_id, from_id)
 WHERE relation_type = 'part_of' AND deleted_at IS NULL;
