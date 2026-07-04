-- migration-023: fragment_links.weight 컬럼을 integer → real(float4)로 변경
-- TemporalLinker가 max(0.3, 1.0 - hours/24) 형태의 float 가중치를 저장해야 하므로 타입 확장.
-- 기존 integer 값(1, 2 등)은 묵시적 캐스팅으로 그대로 유지된다.

ALTER TABLE agent_memory.fragment_links
  ALTER COLUMN weight TYPE real USING weight::real;

ALTER TABLE agent_memory.fragment_links
  ALTER COLUMN weight SET DEFAULT 1.0;
