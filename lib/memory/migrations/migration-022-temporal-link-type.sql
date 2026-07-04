-- migration-022: fragment_links relation_type CHECK 제약 조건에 'temporal' 추가
--
-- temporal: 동일 토픽 내 +-24h 윈도우에서 시간적으로 근접한 파편 간 자동 링크.
-- weight는 시간 거리에 반비례 (0.3~1.0).
--
-- 작성자: 최진호
-- 작성일: 2026-04-02
--
-- 실행: psql $DATABASE_URL -f lib/memory/migration-022-temporal-link-type.sql

ALTER TABLE agent_memory.fragment_links
DROP CONSTRAINT IF EXISTS fragment_links_relation_type_check;

ALTER TABLE agent_memory.fragment_links
ADD CONSTRAINT fragment_links_relation_type_check
CHECK (relation_type = ANY (ARRAY[
    'related', 'caused_by', 'resolved_by',
    'part_of', 'contradicts', 'superseded_by', 'co_retrieved', 'temporal'
]));
