-- 검색 이벤트의 테넌트 귀속 복구와 설명 가능한 회상 프로젝션
-- 원문 질의·본문은 저장하지 않고 선택된 파편 ID와 비식별 선택 근거만 기록한다.

SET LOCAL lock_timeout = '3s';

ALTER TABLE agent_memory.search_events
  ALTER COLUMN key_id TYPE TEXT USING key_id::text,
  ADD COLUMN IF NOT EXISTS selected_fragment_ids TEXT[],
  ADD COLUMN IF NOT EXISTS selection_reasons JSONB;

COMMENT ON COLUMN agent_memory.search_events.selected_fragment_ids
  IS 'recall이 최종 선택한 파편 ID. 본문과 원문 질의는 기록하지 않는다';
COMMENT ON COLUMN agent_memory.search_events.selection_reasons
  IS '파편별 설명 코드·출처·신뢰 등급의 비식별 프로젝션';
