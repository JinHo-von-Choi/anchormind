-- migration-043-fragment-synthetic-query.sql
--
-- 작성자: 최진호
-- 작성일: 2026-08-28
--
-- fragment_synthetic_query: 파편 저장 시 생성한 역질의와 그 임베딩을 담는 보조 벡터 표.
-- 본문 임베딩만으로는 저장 표기와 회상 표기가 어긋날 때(영문 기술용어 저장 대 한국어 질의)
-- 후보 진입에 실패하므로, 회상 시점에 던져질 만한 질문을 미리 색인해 둔다.
--
-- fragments와 분리한 이유:
--   QuotaChecker가 fragments 행 수로 fragment_limit을 판정하므로 같은 표에 넣으면
--   사용자 할당량을 잠식한다. 또한 보조 벡터는 언제든 재생성 가능한 파생 자료다.
--
-- 임베딩 차원은 EMBEDDING_DIMENSIONS 설정을 따른다. 아래 정의는 현행 기본값 1536이며,
-- 차원을 바꾸는 경우 scripts/check-embedding-consistency.js의 검사 대상에 이 표가
-- 포함되어 있으므로 기동 게이트가 불일치를 잡는다.
--
-- 멱등: CREATE TABLE / INDEX IF NOT EXISTS, 정책은 DROP 후 재생성

CREATE TABLE IF NOT EXISTS agent_memory.fragment_synthetic_query (
    id           BIGSERIAL   PRIMARY KEY,
    fragment_id  TEXT        NOT NULL
                             REFERENCES agent_memory.fragments(id) ON DELETE CASCADE,
    query_text   TEXT        NOT NULL,
    embedding    vector(1536),
    key_id       TEXT,
    agent_id     TEXT        NOT NULL DEFAULT 'default',
    workspace    TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 같은 파편에 같은 질의를 중복 적재하지 않는다. 워커 재시도 시 멱등성 근거.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fsq_fragment_query
    ON agent_memory.fragment_synthetic_query (fragment_id, md5(query_text));

CREATE INDEX IF NOT EXISTS idx_fsq_fragment
    ON agent_memory.fragment_synthetic_query (fragment_id);

CREATE INDEX IF NOT EXISTS idx_fsq_key_id
    ON agent_memory.fragment_synthetic_query (key_id)
    WHERE key_id IS NOT NULL;

-- 벡터 인덱스. 행 수가 늘면 생성 시간이 비례하므로 대량 백필 이후에 재생성하는 편이 낫다.
CREATE INDEX IF NOT EXISTS idx_fsq_embedding_hnsw
    ON agent_memory.fragment_synthetic_query
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 128);

ALTER TABLE agent_memory.fragment_synthetic_query ENABLE ROW LEVEL SECURITY;

-- fragments와 동일한 에이전트 격리 규약을 적용한다.
DROP POLICY IF EXISTS fsq_isolation_policy ON agent_memory.fragment_synthetic_query;
CREATE POLICY fsq_isolation_policy ON agent_memory.fragment_synthetic_query
    USING (
        agent_id = current_setting('app.current_agent_id', true)
        OR agent_id = 'default'
        OR current_setting('app.current_agent_id', true) IN ('system', 'admin')
    );

COMMENT ON TABLE agent_memory.fragment_synthetic_query
  IS '파편별 역질의와 보조 임베딩. 파생 자료이므로 유실 시 백필로 재생성한다.';
COMMENT ON COLUMN agent_memory.fragment_synthetic_query.query_text
  IS '해당 파편을 회상할 때 던져질 만한 질문. 원문의 고유명사를 보존해야 한다.';
