-- 사람이 내린 모순 해소 결정을 별도 감사 레코드로 보존한다.

CREATE TABLE IF NOT EXISTS agent_memory.conflict_resolutions (
  id          BIGSERIAL PRIMARY KEY,
  link_id     BIGINT NOT NULL REFERENCES agent_memory.fragment_links(id) ON DELETE CASCADE,
  decision    TEXT NOT NULL CHECK (decision IN ('keep_left', 'keep_right', 'keep_both', 'defer')),
  reason      TEXT,
  key_id      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (link_id)
);

CREATE INDEX IF NOT EXISTS idx_conflict_resolutions_key_created
  ON agent_memory.conflict_resolutions (key_id, created_at DESC)
  WHERE key_id IS NOT NULL;
