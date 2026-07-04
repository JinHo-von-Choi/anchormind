-- Migration 016: agent_id + topic 복합 인덱스
--
-- agent_id 단일 인덱스(idx_frag_agent)는 이미 존재하나,
-- 멀티테넌트 환경에서 agent_id + topic 복합 조건 쿼리가 빈번하므로
-- 커버링 인덱스를 추가하여 순차 스캔을 방지한다.

CREATE INDEX IF NOT EXISTS idx_frag_agent_topic
  ON agent_memory.fragments(agent_id, topic);
