-- 파편 출처, 관측 클라이언트, 신뢰 등급, 검토 상태 열
--
-- 작성자: 최진호
-- 작성일: 2026-10-03
--
-- origin은 클라이언트가 주장한 출처이고, observed_client는 서버가 관측한 클라이언트 이름과 쓰기
-- 진입점 이름이다. source(라벨)와 assertion_status(검증 상태)와는 역할이 다르다. trust_tier는
-- 0 격리, 1 낮음, 2 보통, 3 높음이며 NULL은 코드에서 2로 해석한다. 기존 행은 다시 쓰지 않는다.
-- review_state와 review_reason은 검토 대기열이 쓰는 자리다.
--
-- 다섯 열 모두 기본값 없는 nullable 열이라 표를 다시 쓰지 않는다. CHECK 제약은 NOT VALID로 붙여
-- 기존 행을 훑지 않고 새로 쓰는 행에만 적용한다. 기존 행은 모두 NULL이라 나중에
-- VALIDATE CONSTRAINT를 실행해도 위반이 없다. 열 추가와 제약 추가는 짧게 표 전체 잠금을 잡으므로
-- 잠금 대기를 3초로 제한한다(docs/operations/online-migration.md).

SET LOCAL lock_timeout = '3s';

ALTER TABLE agent_memory.fragments
  ADD COLUMN IF NOT EXISTS origin          TEXT,
  ADD COLUMN IF NOT EXISTS observed_client TEXT,
  ADD COLUMN IF NOT EXISTS trust_tier      SMALLINT,
  ADD COLUMN IF NOT EXISTS review_state    TEXT,
  ADD COLUMN IF NOT EXISTS review_reason   TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'agent_memory.fragments'::regclass
       AND conname  = 'fragments_origin_check'
  ) THEN
    ALTER TABLE agent_memory.fragments
      ADD CONSTRAINT fragments_origin_check CHECK (
        origin IS NULL OR origin IN (
          'user_stated', 'agent_inferred', 'tool_output', 'external_content', 'consolidation', 'import'
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'agent_memory.fragments'::regclass
       AND conname  = 'fragments_trust_tier_check'
  ) THEN
    ALTER TABLE agent_memory.fragments
      ADD CONSTRAINT fragments_trust_tier_check CHECK (
        trust_tier IS NULL OR trust_tier BETWEEN 0 AND 3
      ) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN agent_memory.fragments.origin
  IS '클라이언트가 주장한 출처(user_stated, agent_inferred, tool_output, external_content, consolidation, import). 서버 진입점은 정해진 값. NULL은 주장 없음';
COMMENT ON COLUMN agent_memory.fragments.observed_client
  IS '서버가 관측한 클라이언트 이름(initialize clientInfo.name)과 쓰기 진입점 이름. 이름이 없으면 unknown 또는 internal';
COMMENT ON COLUMN agent_memory.fragments.trust_tier
  IS '신뢰 등급 0 격리, 1 낮음, 2 보통, 3 높음. 주장 출처의 등급과 키 상한 중 작은 값. NULL은 2로 해석';
COMMENT ON COLUMN agent_memory.fragments.review_state
  IS '검토 대기열 상태. NULL은 검토 대상 아님';
COMMENT ON COLUMN agent_memory.fragments.review_reason
  IS '검토 대기열에 오른 사유';
