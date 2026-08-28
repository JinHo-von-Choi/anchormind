/**
 * CLI: export — 파편 JSONL 백업
 *
 * MemoryManager 직접 경유 없이 PostgreSQL raw query로 파편을 읽어
 * JSONL(한 줄에 하나의 파편 JSON) 형식으로 stdout 또는 파일로 출력한다.
 *
 * 출력 필드:
 *   id, content, topic, type, keywords, importance, source, agent_id,
 *   created_at, is_anchor, case_id, idempotency_key,
 *   goal, outcome, phase, resolution_status, assertion_status
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 */

import pg   from "pg";
import fs   from "node:fs";
import path from "node:path";
import { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD } from "../config.js";
import { keyScopeCondition } from "../memory/keyScope.js";
import { SCHEMA } from "../memory/schema.js";

const BATCH_SIZE = 200; /** 커서 없이 LIMIT/OFFSET 배치 */

export const usage = [
  "Usage: memento-mcp export [options]",
  "",
  "Export memory fragments as JSONL (one JSON per line).",
  "",
  "Options:",
  "  --key <mmcp_xxx>      API key filter (key_id). Omit for master (all fragments).",
  "  --topic <name>        Filter by topic",
  "  --type <type>         Filter by fragment type (fact|decision|error|preference|procedure|relation)",
  "  --since <ISO>         Filter created_at >= ISO timestamp (e.g. 2026-01-01)",
  "  --limit <n>           Max fragments to export (default: unlimited)",
  "  --output <FILE>       Write to file instead of stdout",
  "  --json                Wrap output in a JSON array (not JSONL)",
  "",
  "Examples:",
  "  memento-mcp export > backup.jsonl",
  "  memento-mcp export --topic infra --type fact --output infra-facts.jsonl",
  "  memento-mcp export --since 2026-04-01 --limit 500",
  "  memento-mcp export --key mmcp_xxx --output my-fragments.jsonl",
].join("\n");

export default async function exportCmd(args) {
  const pool = new pg.Pool({
    host: DB_HOST, port: DB_PORT, database: DB_NAME,
    user: DB_USER, password: DB_PASSWORD, max: 2,
  });

  /** 출력 스트림 결정 */
  const outputFile = args.output;
  const outStream  = outputFile
    ? fs.createWriteStream(path.resolve(outputFile), { encoding: "utf8" })
    : process.stdout;

  const useJsonArray = args.json === true;

  /** 필터 파라미터 구성 */
  const conditions = ["valid_to IS NULL"];
  const params     = [];

  if (args.key) {
    conditions.push(keyScopeCondition(params, "key_id", args.key));
  }
  if (args.topic) {
    params.push(args.topic);
    conditions.push(`topic = $${params.length}`);
  }
  if (args.type) {
    params.push(args.type);
    conditions.push(`type = $${params.length}`);
  }
  if (args.since) {
    const ts = new Date(args.since);
    if (isNaN(ts.getTime())) {
      console.error(`[export] Invalid --since value: "${args.since}". Use ISO format (e.g. 2026-01-01).`);
      process.exit(1);
    }
    params.push(ts.toISOString());
    conditions.push(`created_at >= $${params.length}::timestamptz`);
  }

  const hardLimit  = args.limit ? parseInt(args.limit, 10) : null;
  if (hardLimit !== null && (isNaN(hardLimit) || hardLimit <= 0)) {
    console.error(`[export] --limit must be a positive integer, got: ${args.limit}`);
    process.exit(1);
  }

  const SELECT_FIELDS = `
    id, content, topic, type, keywords, importance, source, agent_id,
    created_at, is_anchor, case_id, idempotency_key,
    goal, outcome, phase, resolution_status, assertion_status
  `;

  let exported  = 0;
  let offset    = 0;
  let done      = false;
  const allRows = useJsonArray ? [] : null;

  try {
    await pool.query(`SET search_path TO ${SCHEMA}, public`);

    if (useJsonArray) {
      /** JSON 배열 모드: 전량 수집 후 출력 */
      while (!done) {
        const batchLimit = hardLimit !== null
          ? Math.min(BATCH_SIZE, hardLimit - exported)
          : BATCH_SIZE;

        const batchParams = [...params, batchLimit, offset];
        const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
        const sql = `
          SELECT ${SELECT_FIELDS}
          FROM   ${SCHEMA}.fragments
          ${whereClause}
          ORDER  BY created_at ASC
          LIMIT  $${batchParams.length - 1}
          OFFSET $${batchParams.length}
        `;

        const { rows } = await pool.query(sql, batchParams);
        for (const row of rows) allRows.push(row);
        exported += rows.length;
        offset   += rows.length;

        if (rows.length < BATCH_SIZE) done = true;
        if (hardLimit !== null && exported >= hardLimit) done = true;
      }

      outStream.write(JSON.stringify(allRows, null, 2));
      if (outputFile) outStream.write("\n");

    } else {
      /** JSONL 모드: 한 줄씩 스트리밍 출력 */
      while (!done) {
        const batchLimit = hardLimit !== null
          ? Math.min(BATCH_SIZE, hardLimit - exported)
          : BATCH_SIZE;

        const batchParams = [...params, batchLimit, offset];
        const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
        const sql = `
          SELECT ${SELECT_FIELDS}
          FROM   ${SCHEMA}.fragments
          ${whereClause}
          ORDER  BY created_at ASC
          LIMIT  $${batchParams.length - 1}
          OFFSET $${batchParams.length}
        `;

        const { rows } = await pool.query(sql, batchParams);
        for (const row of rows) {
          const line = JSON.stringify(row);
          if (outputFile) {
            outStream.write(line + "\n");
          } else {
            process.stdout.write(line + "\n");
          }
        }
        exported += rows.length;
        offset   += rows.length;

        if (rows.length < BATCH_SIZE) done = true;
        if (hardLimit !== null && exported >= hardLimit) done = true;
      }
    }

    process.stderr.write(`Exported ${exported} fragments\n`);

    if (outputFile) {
      await new Promise((resolve, reject) => {
        outStream.end(err => (err ? reject(err) : resolve()));
      });
    }

  } catch (err) {
    console.error(`[export] ${err.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}
