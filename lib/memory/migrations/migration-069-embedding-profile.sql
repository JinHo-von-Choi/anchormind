-- migration-069-embedding-profile.sql
--
-- 작성자: 최진호
-- 작성일: 2026-10-20
--
-- 저장된 임베딩을 만든 설정(제공자, 모델, 차원)을 한 행으로 남긴다. 기동 검사는 차원만 비교하므로
-- 차원이 같은 다른 모델로 바꾸면 의미 공간이 다른 벡터가 섞여도 알 수 없었다. 기동 시 이 행과 현재 설정을
-- 비교해, 차원은 같고 제공자나 모델이 다르면 재임베딩이 필요하다고 경고한다.
-- 파편 행마다 지문을 두지 않는다(저장 공간과 색인 비용). 행이 없으면 첫 기동이 현재 설정으로 채운다.
-- 멱등: CREATE TABLE IF NOT EXISTS

CREATE TABLE IF NOT EXISTS agent_memory.embedding_profile (
    id           SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    provider     TEXT        NOT NULL,
    model        TEXT        NOT NULL,
    dimensions   INTEGER     NOT NULL,
    recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE agent_memory.embedding_profile
  IS '저장된 임베딩을 만든 제공자, 모델, 차원. 재임베딩을 마치면 scripts/check-embedding-consistency.js --record로 갱신한다.';
