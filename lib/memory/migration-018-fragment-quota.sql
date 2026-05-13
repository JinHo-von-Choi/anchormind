
ALTER TABLE agent_memory.api_keys
  ADD COLUMN IF NOT EXISTS fragment_limit INTEGER DEFAULT 5000;

COMMENT ON COLUMN agent_memory.api_keys.fragment_limit IS
  'Maximum active fragments for this API key. NULL = unlimited, 0 = disabled.';

