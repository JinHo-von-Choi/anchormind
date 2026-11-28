import { createHash } from "node:crypto";
import { SCHEMA } from "../schema.js";
import { ImportOptionError } from "./importErrors.js";

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fingerprintOf = values => createHash("sha256").update(JSON.stringify(values)).digest("hex");

function ownerFingerprint(actor, role, { keyId, restore, idempotent = false }) {
  return fingerprintOf([actor, role, keyId, restore, idempotent]);
}

export class ImportJobConflict extends Error {
  statusCode = 409;

  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function parseImportJobId(value) {
  if (typeof value !== "string" || !JOB_ID.test(value)) throw new ImportOptionError("resume requires a UUID");
  return value.toLowerCase();
}

/** 같은 주체와 대상에만 원본 업로드 없이 진행 상태를 돌려준다. */
export async function readImportJobStatus(pool, { id, actor }, options) {
  const { rows: [job] } = await pool.query(`
    WITH lookup AS (SELECT hashtextextended($1::text, 2601128) AS lock_key)
    SELECT current_user AS role, j.owner_fingerprint, j.line, j.completed,
           CASE WHEN j.completed THEN j.checkpoint END AS checkpoint,
           EXISTS (SELECT 1 FROM pg_locks l
                    WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
                      AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
                      AND l.classid::bigint = (lookup.lock_key >> 32 & 4294967295)
                      AND l.objid::bigint = (lookup.lock_key & 4294967295)) AS running
      FROM ${SCHEMA}.import_jobs j CROSS JOIN lookup
     WHERE j.id = $1::uuid`, [parseImportJobId(id)]);
  if (!job || job.owner_fingerprint !== ownerFingerprint(actor, job.role, options)) return null;
  const status = job.completed ? "completed" : job.running ? "running" : "pending";
  return { status, line: job.line, checkpoint: job.checkpoint };
}

/** 잡을 한 번에 한 연결에서만 실행한다. 연결이 죽으면 세션 잠금도 해제된다. */
export async function withImportJob(pool, resume, options, run) {
  const id = parseImportJobId(resume.id);
  const client = await pool.connect();
  let acquired = false;
  let discard = false;
  try {
    const { rows: [lock] } = await client.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 2601128)) AS acquired, current_user AS role",
      [id]
    );
    if (!lock.acquired) throw new ImportJobConflict("import_in_progress", "This import is already running");
    acquired = true;
    const { entry, keyId, restore, idempotent } = options;
    const owner = ownerFingerprint(resume.actor, lock.role, options);
    const fingerprint = fingerprintOf([resume.digest, resume.actor, lock.role, [entry, keyId, restore, idempotent]]);
    await client.query(`INSERT INTO ${SCHEMA}.import_jobs (id, fingerprint, owner_fingerprint) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [id, fingerprint, owner]);
    const { rows: [job] } = await client.query(
      `SELECT fingerprint, line, checkpoint, completed FROM ${SCHEMA}.import_jobs WHERE id = $1`, [id]
    );
    if (!job || job.fingerprint !== fingerprint) {
      throw new ImportJobConflict("import_resume_mismatch", "Import UUID belongs to a different file, actor or target");
    }
    const { rows: batches } = await client.query(
      `SELECT fragments, warnings FROM ${SCHEMA}.import_job_batches WHERE job_id = $1 ORDER BY line`, [id]
    );
    return await run({
      id, job, batches,
      async transaction(work) {
        await client.query("BEGIN");
        try {
          await work(client);
          await client.query("COMMIT");
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch {
            discard = true;
          }
          throw error;
        }
      }
    });
  } finally {
    try {
      if (acquired && !discard) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 2601128))", [id]);
    } catch {
      discard = true;
    } finally {
      client.release(discard);
    }
  }
}

/** 파편 매핑과 경고를 배치별로 저장해 앞부분을 매번 다시 쓰지 않는다. */
export async function saveImportBatch(client, id, line, checkpoint, fragments, warnings) {
  await client.query(`INSERT INTO ${SCHEMA}.import_job_batches (job_id, line, fragments, warnings) VALUES ($1, $2, $3, $4)`,
    [id, line, JSON.stringify(fragments), JSON.stringify(warnings)]);
  await client.query(`UPDATE ${SCHEMA}.import_jobs SET line = $2, checkpoint = $3 WHERE id = $1`,
    [id, line, checkpoint]);
}

export async function completeImportJob(client, id, checkpoint) {
  await client.query(`UPDATE ${SCHEMA}.import_jobs SET completed = true, checkpoint = $2 WHERE id = $1`, [id, checkpoint]);
  await client.query(`DELETE FROM ${SCHEMA}.import_job_batches WHERE job_id = $1`, [id]);
}
