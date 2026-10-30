-- migration-071-idempotency-agent-scope.sql
--
-- 작성자: 최진호
-- 작성일: 2026-10-31
--
-- 재시도 기록(idempotency_records)의 유일 범위에 agent_id를 넣는다. 같은 API 키를 쓰는 다른 에이전트가
-- 같은 idempotencyKey로 부르면 이전 유일 색인 (scope_key, tool, idempotency_key)로는 앞 에이전트의 응답이
-- 그대로 재생된다. 조회와 기록은 agent_id를 함께 보고, 유일 색인은 (scope_key, agent_id, tool,
-- idempotency_key)로 바꾼다. 기존 행은 이전 색인에서 이미 유일하므로 새 색인에서도 충돌하지 않는다.
-- 다른 질의가 잡은 잠금을 오래 기다리지 않게 lock_timeout을 둔다. 시간 안에 못 잡으면 실패하고
-- 적용 이력에 남지 않으므로 다시 실행한다.
-- 멱등: CREATE UNIQUE INDEX IF NOT EXISTS, DROP INDEX IF EXISTS

SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX IF NOT EXISTS idx_idem_scope_agent_tool_key
    ON agent_memory.idempotency_records (scope_key, agent_id, tool, idempotency_key);

DROP INDEX IF EXISTS agent_memory.idx_idem_scope_tool_key;
