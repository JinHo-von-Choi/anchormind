-- migration-006-superseded-by-constraint.sql
-- fragment_links relation_type CHECK 제약 조건에 'superseded_by' 추가
--
-- 작성자: 최진호
-- 작성일: 2026-03-08
--
-- 실행: psql $DATABASE_URL -f lib/memory/migration-006-superseded-by-constraint.sql

ALTER TABLE agent_memory.fragment_links
DROP CONSTRAINT IF EXISTS fragment_links_relation_type_check;

ALTER TABLE agent_memory.fragment_links
ADD CONSTRAINT fragment_links_relation_type_check
CHECK (relation_type = ANY (ARRAY[
    'related', 'caused_by', 'resolved_by',
    'part_of', 'contradicts', 'superseded_by', 'co_retrieved'
]));
