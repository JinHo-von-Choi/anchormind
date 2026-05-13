-- migration-017-episodic.sql
-- Episode type과 context_summary, session_id 컬럼 추가


-- 1. type CHECK 제약 조건 변경: episode 추가
ALTER TABLE agent_memory.fragments
  DROP CONSTRAINT IF EXISTS fragments_type_check;

ALTER TABLE agent_memory.fragments
  ADD CONSTRAINT fragments_type_check
  CHECK (type IN ('fact','decision','error','preference','procedure','relation','episode'));

-- 2. context_summary 컬럼 추가
ALTER TABLE agent_memory.fragments
  ADD COLUMN IF NOT EXISTS context_summary TEXT;

-- 3. session_id 컬럼 추가
ALTER TABLE agent_memory.fragments
  ADD COLUMN IF NOT EXISTS session_id TEXT;

-- 4. session_id 인덱스
CREATE INDEX IF NOT EXISTS idx_fragments_session_id
  ON agent_memory.fragments (session_id)
  WHERE session_id IS NOT NULL;

