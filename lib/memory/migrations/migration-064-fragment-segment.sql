-- migration-064-fragment-segment.sql
--
-- 작성자: 최진호
-- 작성일: 2026-10-09
--
-- fragment_segment: 긴 파편 본문을 겹치는 구간으로 나눈 구간별 임베딩을 담는 파생 벡터 표.
-- 본문 하나를 벡터 하나로 만들면 최대 1000자 본문 속의 곁다리 언급이 주된 화제에 희석되어 질문과 멀어진다.
-- 구간 벡터를 따로 두고 조각별 최대 유사도를 쓰면 이를 회수한다 (MEMENTO_SEGMENT_EMBEDDING_ENABLED).
--
-- fragments와 분리한 이유는 fragment_synthetic_query와 같다.
--   QuotaChecker가 fragments 행 수로 fragment_limit을 판정하므로 같은 표에 넣으면 사용자 할당량을 잠식한다.
--   구간은 언제든 재생성 가능한 파생 자료다.
--
-- 키/에이전트/워크스페이스 열을 두지 않는다. 격리 판정은 검색 SQL이 JOIN한 부모 fragments의 열로만 한다.
-- 비정규화 사본은 부모와 어긋날 수 있고 어긋나면 누출이나 누락이 된다.
--
-- 신선도: source_content_hash가 부모 content_hash와 같고 seg_version이 현재 분할 설정의 버전과 같은 행만
-- 유효하다. 한 조각의 구간은 한 트랜잭션에 모두 쓰므로 부분 적재는 없다.
--
-- 임베딩 차원은 EMBEDDING_DIMENSIONS 설정을 따른다. 아래 정의는 현행 기본값 1536이며, 차원을 바꾸는 경우
-- scripts/post-migrate-flexible-embedding-dims.js와 scripts/check-embedding-consistency.js가 이 표를 함께 다룬다.
--
-- 멱등: CREATE TABLE / INDEX IF NOT EXISTS, 정책은 DROP 후 재생성

CREATE TABLE IF NOT EXISTS agent_memory.fragment_segment (
    id                   BIGSERIAL   PRIMARY KEY,
    fragment_id          TEXT        NOT NULL
                                     REFERENCES agent_memory.fragments(id) ON DELETE CASCADE,
    seg_idx              INTEGER     NOT NULL,
    seg_start            INTEGER     NOT NULL,
    seg_end              INTEGER     NOT NULL,
    embedding            vector(1536),
    source_content_hash  TEXT        NOT NULL,
    seg_version          TEXT        NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_fseg_fragment_idx UNIQUE (fragment_id, seg_idx)
);

-- 벡터 인덱스. 행 수가 많으면 생성 시간이 비례하므로 대량 백필 이후에 재생성하는 편이 낫다.
CREATE INDEX IF NOT EXISTS idx_fseg_embedding_hnsw
    ON agent_memory.fragment_segment
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 128)
    WHERE embedding IS NOT NULL;

ALTER TABLE agent_memory.fragment_segment ENABLE ROW LEVEL SECURITY;

-- 부모 파편이 보이는 구간만 보인다. fragments의 에이전트 격리 정책이 그대로 적용된다.
DROP POLICY IF EXISTS fseg_isolation_policy ON agent_memory.fragment_segment;
CREATE POLICY fseg_isolation_policy ON agent_memory.fragment_segment
    USING (EXISTS (SELECT 1 FROM agent_memory.fragments f WHERE f.id = fragment_segment.fragment_id));

COMMENT ON TABLE agent_memory.fragment_segment
  IS '긴 파편 본문의 구간별 임베딩. 파생 자료이므로 유실 시 워커 복구 스캔으로 재생성한다.';
COMMENT ON COLUMN agent_memory.fragment_segment.seg_version
  IS '분할 규칙 버전과 설정(창 길이, 간격, 최대 구간 수). 설정이 바뀌면 기존 행은 낡은 것으로 판정된다.';
