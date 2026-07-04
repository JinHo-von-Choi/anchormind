-- migration-007: fragment_links에 관계 강도(weight) 컬럼 추가
--
-- weight: 동일 링크가 생성/강화될 때마다 증분되는 정수.
-- createLink() ON CONFLICT 시 weight += 1 처리.
-- getLinkedFragments() 정렬에 weight DESC 우선 적용.

ALTER TABLE agent_memory.fragment_links
  ADD COLUMN IF NOT EXISTS weight INTEGER NOT NULL DEFAULT 1;

-- 기존 링크는 weight=1로 초기화됨 (DEFAULT 처리)
-- 인덱스: weight 기반 정렬 가속
CREATE INDEX IF NOT EXISTS idx_fragment_links_weight
  ON agent_memory.fragment_links (from_id, weight DESC);
