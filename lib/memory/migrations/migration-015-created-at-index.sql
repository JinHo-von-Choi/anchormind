-- Migration 015: created_at index for timeRange queries
CREATE INDEX IF NOT EXISTS idx_frag_created
  ON agent_memory.fragments(created_at DESC);
