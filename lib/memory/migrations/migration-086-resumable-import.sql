-- 재개 작업의 진척을 가져온 데이터와 함께 커밋한다.
CREATE TABLE IF NOT EXISTS agent_memory.import_jobs (
    id uuid PRIMARY KEY,
    fingerprint text NOT NULL,
    owner_fingerprint text NOT NULL,
    line integer NOT NULL DEFAULT 0,
    checkpoint jsonb,
    completed boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS agent_memory.import_job_batches (
    job_id uuid NOT NULL REFERENCES agent_memory.import_jobs(id) ON DELETE CASCADE,
    line integer NOT NULL,
    fragments jsonb NOT NULL,
    warnings jsonb NOT NULL,
    PRIMARY KEY (job_id, line)
);
