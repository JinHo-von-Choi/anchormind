/**
 * CLI: export, 파편 JSONL 백업
 *
 * MemoryManager 직접 경유 없이 PostgreSQL raw query로 파편을 읽어
 * JSONL(한 줄에 하나의 기록) 형식으로 stdout 또는 파일로 출력한다.
 *
 * 형식 버전 2(기본): 머리 줄, 파편 줄(전 열), 링크 줄, 선택 이력 줄, 끝 줄.
 * 형식 버전 1: 파편 줄만. 열은 id, content, topic, type, keywords, importance, source, agent_id,
 *   created_at, is_anchor, case_id, idempotency_key, goal, outcome, phase, resolution_status,
 *   assertion_status.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 * 수정일: 2026-10-03 (형식 버전 2, 링크와 이력, id 순 묶음 읽기)
 */

import pg   from "pg";
import fs   from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD } from "../config.js";
import { keyScopeCondition } from "../memory/keyScope.js";
import { negotiateExportVersion, ExportVersionError } from "../memory/transfer/exportFormat.js";
import { exportRecords } from "../memory/transfer/FragmentExporter.js";

export const usage = [
  "Usage: memento-mcp export [options]",
  "",
  "Export memory fragments as JSONL (one JSON per line).",
  "",
  "Options:",
  "  --key <key_id>        API key filter (key_id). Omit for master (all fragments).",
  "  --topic <name>        Filter by topic",
  "  --type <type>         Filter by fragment type (fact|decision|error|preference|procedure|relation|episode)",
  "  --since <ISO>         Filter created_at >= ISO timestamp (e.g. 2026-01-01)",
  "  --limit <n>           Max fragments to export (default: unlimited)",
  "  --output <FILE>       Write to file instead of stdout",
  "  --format-version <n>  Export format version: 2 (default) or 1 (fragment lines only)",
  "  --no-links            Version 2: leave out link lines",
  "  --include-versions    Version 2: add fragment history lines",
  "  --json                Wrap output in a JSON array (not JSONL)",
  "",
  "Examples:",
  "  memento-mcp export > backup.jsonl",
  "  memento-mcp export --topic infra --type fact --output infra-facts.jsonl",
  "  memento-mcp export --since 2026-04-01 --limit 500",
  "  memento-mcp export --key <key_id> --output my-fragments.jsonl",
  "  memento-mcp export --format-version 1 --output legacy.jsonl",
].join("\n");

/** 필터 인수로 WHERE 조건식과 바인딩, 머리 줄에 적을 조건을 만든다. 잘못된 값이면 종료한다. */
function buildFilter(args) {
  const conditions = ["valid_to IS NULL"];
  const params     = [];
  const scope      = {};

  if (args.key) {
    conditions.push(keyScopeCondition(params, "key_id", args.key));
    scope.key_id = args.key;
  }
  if (args.topic) {
    params.push(args.topic);
    conditions.push(`topic = $${params.length}`);
    scope.topic = args.topic;
  }
  if (args.type) {
    params.push(args.type);
    conditions.push(`type = $${params.length}`);
    scope.type = args.type;
  }
  if (args.since) {
    const ts = new Date(args.since);
    if (isNaN(ts.getTime())) {
      console.error(`[export] Invalid --since value: "${args.since}". Use ISO format (e.g. 2026-01-01).`);
      process.exit(1);
    }
    params.push(ts.toISOString());
    conditions.push(`created_at >= $${params.length}::timestamptz`);
    scope.since = ts.toISOString();
  }
  return { where: conditions.join(" AND "), params, scope };
}

/** 출력 스트림에 쓴다. 버퍼가 차면 비워질 때까지 기다린다. */
async function writeOut(stream, text) {
  if (!stream.write(text)) await once(stream, "drain");
}

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
  const filter       = buildFilter(args);

  const hardLimit = args.limit ? parseInt(args.limit, 10) : null;
  if (hardLimit !== null && (isNaN(hardLimit) || hardLimit <= 0)) {
    console.error(`[export] --limit must be a positive integer, got: ${args.limit}`);
    process.exit(1);
  }

  let version;
  try {
    version = negotiateExportVersion({ requested: args["format-version"] ?? args.formatVersion });
  } catch (err) {
    if (!(err instanceof ExportVersionError)) throw err;
    console.error(`[export] ${err.message}`);
    process.exit(1);
  }

  let exported = 0;
  let first    = true;
  try {
    const records = exportRecords({
      query          : (sql, params) => pool.query(sql, params),
      where          : filter.where,
      params         : filter.params,
      version,
      includeLinks   : args.links !== false,
      includeVersions: args["include-versions"] === true || args.includeVersions === true,
      max            : hardLimit,
      scope          : filter.scope
    });

    if (useJsonArray) await writeOut(outStream, "[\n");
    for await (const record of records) {
      if (record.record === undefined || record.record === "fragment") exported++;
      if (useJsonArray) {
        await writeOut(outStream, `${first ? "" : ",\n"}${JSON.stringify(record, null, 2)}`);
        first = false;
      } else {
        await writeOut(outStream, JSON.stringify(record) + "\n");
      }
    }
    if (useJsonArray) await writeOut(outStream, "\n]\n");

    process.stderr.write(`Exported ${exported} fragments (format version ${version})\n`);

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
