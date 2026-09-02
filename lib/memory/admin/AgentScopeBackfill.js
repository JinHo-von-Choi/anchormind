import { getPrimaryPool } from "../../tools/db.js";
import { SCHEMA } from "../schema.js";

const REQUIRED_COLUMNS = [
  ["fragment_versions", "agent_id"],
  ["fragment_versions", "workspace"],
  ["case_events", "agent_id"],
  ["case_events", "workspace"]
];

/** migration-046의 nullable snapshot 컬럼이 모두 적용됐는지 확인한다. */
export async function hasAgentScopeSnapshotSchema(pool = getPrimaryPool()) {
  if (!pool) return false;
  const { rows } = await pool.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = $1
        AND (table_name, column_name) IN (
          ('fragment_versions', 'agent_id'),
          ('fragment_versions', 'workspace'),
          ('case_events', 'agent_id'),
          ('case_events', 'workspace')
        )`,
    [SCHEMA]
  );
  const found = new Set(rows.map(row => `${row.table_name}.${row.column_name}`));
  return REQUIRED_COLUMNS.every(([table, column]) => found.has(`${table}.${column}`));
}

/** 본문과 식별자를 노출하지 않는 legacy snapshot 사전 영향 집계. */
export async function getAgentScopeBackfillStatus(pool = getPrimaryPool()) {
  if (!await hasAgentScopeSnapshotSchema(pool)) {
    return { migrationReady: false };
  }

  const versions = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE fv.agent_id IS NULL)::int AS pending,
            COUNT(*) FILTER (WHERE fv.agent_id IS NULL AND f.id IS NOT NULL)::int AS backfillable
       FROM ${SCHEMA}.fragment_versions fv
       LEFT JOIN ${SCHEMA}.fragments f ON f.id = fv.fragment_id`
  );
  const events = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE ce.agent_id IS NULL)::int AS pending,
            COUNT(*) FILTER (
              WHERE ce.agent_id IS NULL AND ce.source_fragment_id IS NOT NULL AND f.id IS NOT NULL
            )::int AS backfillable,
            COUNT(*) FILTER (
              WHERE ce.agent_id IS NULL AND ce.source_fragment_id IS NULL
            )::int AS "sourceMissing",
            COUNT(*) FILTER (
              WHERE ce.agent_id IS NULL AND ce.source_fragment_id IS NOT NULL AND f.id IS NULL
            )::int AS "sourceDeleted"
       FROM ${SCHEMA}.case_events ce
       LEFT JOIN ${SCHEMA}.fragments f ON f.id = ce.source_fragment_id`
  );

  return {
    migrationReady: true,
    fragmentVersions: versions.rows[0],
    caseEvents: events.rows[0]
  };
}

/** 공유 범위로 바꾸려는 파편의 version/event snapshot이 모두 복구됐는지 확인한다. */
export async function getPendingScopeSnapshotCounts(fragmentIds, pool = getPrimaryPool()) {
  if (!Array.isArray(fragmentIds) || fragmentIds.length === 0) {
    return { fragmentVersions: 0, caseEvents: 0, total: 0 };
  }
  if (!await hasAgentScopeSnapshotSchema(pool)) {
    throw new Error("migration-046 must be applied before agent scope normalization");
  }
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int
          FROM ${SCHEMA}.fragment_versions
         WHERE fragment_id = ANY($1::text[])
           AND agent_id IS NULL) AS "fragmentVersions",
       (SELECT COUNT(*)::int
          FROM ${SCHEMA}.case_events
         WHERE source_fragment_id = ANY($1::text[])
           AND agent_id IS NULL) AS "caseEvents"`,
    [fragmentIds]
  );
  const fragmentVersions = rows[0]?.fragmentVersions ?? 0;
  const caseEvents = rows[0]?.caseEvents ?? 0;
  return { fragmentVersions, caseEvents, total: fragmentVersions + caseEvents };
}

export function assertBackfillComplete(status) {
  const pending = (status?.fragmentVersions?.backfillable ?? 0)
    + (status?.caseEvents?.backfillable ?? 0);
  if (pending > 0) {
    throw new Error(
      `snapshot backfill left ${pending} backfillable row(s); rerun after concurrent writers finish`
    );
  }
}

async function backfillFragmentVersionBatch(pool, batchSize) {
  const result = await pool.query(
    `WITH batch AS (
       SELECT fv.id, f.agent_id, f.workspace
         FROM ${SCHEMA}.fragment_versions fv
         JOIN ${SCHEMA}.fragments f ON f.id = fv.fragment_id
        WHERE fv.agent_id IS NULL
        ORDER BY fv.id
        LIMIT $1
        FOR UPDATE OF fv SKIP LOCKED
     )
     UPDATE ${SCHEMA}.fragment_versions fv
        SET agent_id = batch.agent_id,
            workspace = batch.workspace
       FROM batch
      WHERE fv.id = batch.id`,
    [batchSize]
  );
  return result.rowCount ?? 0;
}

async function backfillCaseEventBatch(pool, batchSize) {
  const result = await pool.query(
    `WITH batch AS (
       SELECT ce.event_id, f.agent_id, f.workspace
         FROM ${SCHEMA}.case_events ce
         JOIN ${SCHEMA}.fragments f ON f.id = ce.source_fragment_id
        WHERE ce.agent_id IS NULL
        ORDER BY ce.event_id
        LIMIT $1
        FOR UPDATE OF ce SKIP LOCKED
     )
     UPDATE ${SCHEMA}.case_events ce
        SET agent_id = batch.agent_id,
            workspace = batch.workspace
       FROM batch
      WHERE ce.event_id = batch.event_id`,
    [batchSize]
  );
  return result.rowCount ?? 0;
}

/** 신뢰 가능한 source fragment가 남은 snapshot만 짧은 트랜잭션으로 backfill한다. */
export async function backfillAgentScopeSnapshots({ batchSize = 500 } = {}, pool = getPrimaryPool()) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new Error("batchSize must be an integer between 1 and 10000");
  }
  if (!await hasAgentScopeSnapshotSchema(pool)) {
    throw new Error("migration-046 must be applied before snapshot backfill");
  }

  let fragmentVersions = 0;
  let caseEvents = 0;
  for (;;) {
    const updated = await backfillFragmentVersionBatch(pool, batchSize);
    fragmentVersions += updated;
    if (updated < batchSize) break;
  }
  for (;;) {
    const updated = await backfillCaseEventBatch(pool, batchSize);
    caseEvents += updated;
    if (updated < batchSize) break;
  }
  return { fragmentVersions, caseEvents };
}
