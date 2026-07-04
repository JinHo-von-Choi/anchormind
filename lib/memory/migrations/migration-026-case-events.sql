-- migration-026-case-events.sql
-- case_events (semantic milestone) + case_event_edges DAG + fragment_evidence
-- 작성자: 최진호
-- 작성일: 2026-04-03


CREATE TABLE IF NOT EXISTS agent_memory.case_events (
    event_id       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id        TEXT         NOT NULL,
    session_id     TEXT,
    sequence_no    INTEGER      NOT NULL DEFAULT 0,
    event_type     TEXT         NOT NULL
                   CHECK (event_type IN (
                       'milestone_reached',
                       'hypothesis_proposed',
                       'hypothesis_rejected',
                       'decision_committed',
                       'error_observed',
                       'fix_attempted',
                       'verification_passed',
                       'verification_failed'
                   )),
    summary        TEXT         NOT NULL,
    entity_keys    TEXT[]       NOT NULL DEFAULT '{}',
    source_fragment_id TEXT,
    source_search_event_id BIGINT,
    key_id         INTEGER,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ce_case_id
    ON agent_memory.case_events (case_id);

CREATE INDEX IF NOT EXISTS idx_ce_session_id
    ON agent_memory.case_events (session_id)
    WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ce_event_type
    ON agent_memory.case_events (event_type);

CREATE INDEX IF NOT EXISTS idx_ce_created_at
    ON agent_memory.case_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ce_entity_keys
    ON agent_memory.case_events USING GIN (entity_keys);

CREATE TABLE IF NOT EXISTS agent_memory.case_event_edges (
    from_event_id UUID REFERENCES agent_memory.case_events(event_id) ON DELETE CASCADE,
    to_event_id   UUID REFERENCES agent_memory.case_events(event_id) ON DELETE CASCADE,
    edge_type     TEXT NOT NULL CHECK (edge_type IN ('caused_by', 'resolved_by', 'preceded_by', 'contradicts')),
    confidence    REAL NOT NULL DEFAULT 1.0,
    PRIMARY KEY (from_event_id, to_event_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_cee_from
    ON agent_memory.case_event_edges (from_event_id);

CREATE INDEX IF NOT EXISTS idx_cee_to
    ON agent_memory.case_event_edges (to_event_id);

CREATE TABLE IF NOT EXISTS agent_memory.fragment_evidence (
    fragment_id TEXT  NOT NULL REFERENCES agent_memory.fragments(id) ON DELETE CASCADE,
    event_id    UUID  NOT NULL REFERENCES agent_memory.case_events(event_id) ON DELETE CASCADE,
    kind        TEXT  NOT NULL CHECK (kind IN ('supports', 'contradicts', 'produced_by')),
    confidence  REAL  NOT NULL DEFAULT 1.0,
    PRIMARY KEY (fragment_id, event_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_fe_fragment_id
    ON agent_memory.fragment_evidence (fragment_id);

CREATE INDEX IF NOT EXISTS idx_fe_event_id
    ON agent_memory.fragment_evidence (event_id);

