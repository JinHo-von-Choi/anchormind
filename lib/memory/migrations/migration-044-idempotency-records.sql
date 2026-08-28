-- migration-044-idempotency-records.sql
--
-- 작성자: 최진호
-- 작성일: 2026-08-28
--
-- idempotency_records: 파편을 만들지 않는 쓰기 도구의 재시도 안전 장치.
--
-- remember는 fragments.idempotency_key로 재호출을 흡수하지만, amend는 기존 파편을
-- 고치고 tool_feedback은 피드백을 기록할 뿐이라 키를 얹을 행이 없다. 네트워크가
-- 끊겨 응답을 못 받은 클라이언트가 재시도하면 이력이 두 번 쌓이거나 가중치가
-- 두 번 움직인다.
--
-- 전용 표로 분리한 이유:
--   QuotaChecker가 fragments 행 수로 사용자 할당량을 판정하므로 같은 표에 넣으면
--   할당량을 잠식한다. 또한 이 기록은 재시도 창이 지나면 값이 없어 만료 대상이다.
--
-- 키 범위는 (key_id, tool, idempotency_key)다. 서로 다른 API 키가 같은 키 문자열을
-- 써도 충돌하지 않아야 하고, 같은 키를 다른 도구에 재사용해도 섞이지 않아야 한다.
-- key_id가 NULL인 마스터 호출도 하나의 범위로 묶이도록 COALESCE로 정규화한다.
--
-- 멱등: CREATE TABLE / INDEX IF NOT EXISTS, 정책은 DROP 후 재생성

CREATE TABLE IF NOT EXISTS agent_memory.idempotency_records (
    id              BIGSERIAL   PRIMARY KEY,
    scope_key       TEXT        NOT NULL,
    tool            TEXT        NOT NULL,
    idempotency_key TEXT        NOT NULL,
    response        JSONB       NOT NULL,
    agent_id        TEXT        NOT NULL DEFAULT 'default',
    key_id          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
);

-- 재호출 판정에 쓰이는 유일 제약. scope_key는 COALESCE(key_id, '') 값을 담는다.
CREATE UNIQUE INDEX IF NOT EXISTS idx_idem_scope_tool_key
    ON agent_memory.idempotency_records (scope_key, tool, idempotency_key);

-- 만료 회수용.
CREATE INDEX IF NOT EXISTS idx_idem_expires_at
    ON agent_memory.idempotency_records (expires_at);

ALTER TABLE agent_memory.idempotency_records ENABLE ROW LEVEL SECURITY;

-- fragments와 동일한 에이전트 격리 규약을 적용한다.
DROP POLICY IF EXISTS idem_isolation_policy ON agent_memory.idempotency_records;
CREATE POLICY idem_isolation_policy ON agent_memory.idempotency_records
    USING (
        agent_id = current_setting('app.current_agent_id', true)
        OR agent_id = 'default'
        OR current_setting('app.current_agent_id', true) IN ('system', 'admin')
    );

COMMENT ON TABLE agent_memory.idempotency_records
  IS '파편을 만들지 않는 쓰기 도구의 재시도 기록. 만료되면 지워도 무방하다.';
COMMENT ON COLUMN agent_memory.idempotency_records.scope_key
  IS 'COALESCE(key_id, '''') 정규화 값. 유일 제약이 NULL을 서로 다른 값으로 보지 않게 한다.';
COMMENT ON COLUMN agent_memory.idempotency_records.response
  IS '첫 호출의 응답 본문. 재호출은 이 값을 그대로 돌려준다.';
