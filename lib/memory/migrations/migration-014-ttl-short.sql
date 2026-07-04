-- migration-014-ttl-short.sql
-- ttl_tier에 'short' 값 추가 (30일 TTL, 낮은 importance 파편 자동 할당)
--
-- 작성자: 최진호
-- 작성일: 2026-03-28

ALTER TABLE agent_memory.fragments
  DROP CONSTRAINT IF EXISTS fragments_ttl_tier_check;

ALTER TABLE agent_memory.fragments
  ADD CONSTRAINT fragments_ttl_tier_check
  CHECK (ttl_tier IN ('short', 'hot', 'warm', 'cold', 'permanent'));
