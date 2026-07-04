-- migration-009: fragment_links relation_type CHECK 제약 조건에 'co_retrieved' 추가
--
-- co_retrieved: 동일 recall 결과에 함께 반환된 파편 간 Hebbian 연결.
-- weight 컬럼(migration-007)으로 강화 횟수를 누적 관리한다.
--
-- 작성자: 최진호
-- 작성일: 2026-03-11
--
-- 실행: psql $DATABASE_URL -f lib/memory/migration-009-co-retrieved.sql

ALTER TABLE agent_memory.fragment_links
DROP CONSTRAINT IF EXISTS fragment_links_relation_type_check;

ALTER TABLE agent_memory.fragment_links
ADD CONSTRAINT fragment_links_relation_type_check
CHECK (relation_type = ANY (ARRAY[
    'related', 'caused_by', 'resolved_by',
    'part_of', 'contradicts', 'superseded_by', 'co_retrieved'
]));
