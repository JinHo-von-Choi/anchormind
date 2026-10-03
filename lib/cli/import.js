/**
 * CLI: import, JSONL 파편 복원
 *
 * JSONL 파일(또는 stdin)을 읽어 각 줄을 JSON.parse 후 의미 쓰기 관문(WriteGate)을 거쳐
 * FragmentWriter로 fragments 테이블에 기록한다. 행마다 트랜잭션을 연다.
 *
 * 같은 본문이 이미 있는 행은 기존 파편을 가리키므로 skipped로 센다.
 * --idempotent: 같은 id가 이미 있어 기록이 거부된 행도 skipped로 센다.
 * --dry-run:    실제 기록 없이 관문 검증만 수행.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 * 수정일: 2026-10-03 (의미 쓰기 관문과 FragmentWriter 경유)
 */

import pg       from "pg";
import fs       from "node:fs";
import path     from "node:path";
import readline from "node:readline";
import { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD } from "../config.js";

export const usage = [
  "Usage: memento-mcp import [options]",
  "       memento-mcp import < backup.jsonl",
  "",
  "Import memory fragments from JSONL (one JSON per line).",
  "",
  "Options:",
  "  --input <FILE>        Read from file instead of stdin",
  "  --idempotent          Skip fragments that already exist (by idempotency_key or id)",
  "  --dry-run             Validate only, do not insert",
  "  --json                Output summary as JSON",
  "",
  "JSONL format (per line):",
  "  Required: content, topic",
  "  Optional: id, type, keywords, importance, source, agent_id, created_at,",
  "            is_anchor, case_id, idempotency_key, goal, outcome, phase,",
  "            resolution_status, assertion_status",
  "",
  "Examples:",
  "  memento-mcp import --input backup.jsonl",
  "  memento-mcp import --input backup.jsonl --idempotent",
  "  cat backup.jsonl | memento-mcp import --dry-run",
  "  memento-mcp import < backup.jsonl --idempotent --json",
].join("\n");

/** 입력 스트림 생성 */
function openInputStream(inputFile) {
  if (inputFile) {
    const resolved = path.resolve(inputFile);
    if (!fs.existsSync(resolved)) {
      console.error(`[import] File not found: ${resolved}`);
      process.exit(1);
    }
    return fs.createReadStream(resolved, { encoding: "utf8" });
  }
  if (process.stdin.isTTY) {
    console.error("[import] No input: provide --input <FILE> or pipe JSONL via stdin.");
    process.exit(1);
  }
  return process.stdin;
}

/** PostgreSQL unique_violation */
const UNIQUE_VIOLATION = "23505";

/**
 * 가져오기 기록에 쓰는 의존성. 서버 로거와 메모리 모듈은 가져오기를 실행할 때만 불러온다.
 *
 * @returns {Promise<Object>}
 */
async function loadImportDeps() {
  const [{ importFragment, IMPORT_DEFAULTS }, { WriteGate, WRITE_ENTRIES }, { FragmentWriter }, { withTransaction }] = await Promise.all([
    import("../memory/write/FragmentImporter.js"),
    import("../memory/write/WriteGate.js"),
    import("../memory/write/FragmentWriter.js"),
    import("../tools/db.js")
  ]);
  return {
    importFragment,
    withTransaction,
    defaults: IMPORT_DEFAULTS.cli,
    entry   : WRITE_ENTRIES.CLI_IMPORT,
    gate    : new WriteGate(),
    writer  : new FragmentWriter()
  };
}

/**
 * 한 행을 기록하고 결과를 분류한다.
 *
 * @returns {Promise<"imported"|"skipped"|"error">}
 */
async function importRow(row, lineNum, deps) {
  const { importFragment, withTransaction, pool, idempotent, dryRun, entry, gate, writer, defaults } = deps;
  try {
    const outcome = dryRun
      ? await importFragment(row, { entry, gate, defaults, dryRun: true })
      : await withTransaction(pool, (client) => importFragment(row, { entry, gate, writer, client, defaults }));

    if (outcome.status === "rejected") {
      process.stderr.write(`[import] Line ${lineNum}: rejected (${outcome.reason}), skipping\n`);
      return "error";
    }
    return outcome.status === "imported" ? "imported" : "skipped";
  } catch (err) {
    if (idempotent && err.code === UNIQUE_VIOLATION) return "skipped";
    process.stderr.write(`[import] Line ${lineNum}: DB error: ${err.message}\n`);
    return "error";
  }
}

/**
 * JSONL 줄을 차례로 가져온다.
 *
 * @param {AsyncIterable<string>} lines
 * @param {Object} deps - loadImportDeps 결과와 pool, idempotent, dryRun
 * @returns {Promise<{imported: number, skipped: number, errors: number, lines: number}>}
 */
export async function importRows(lines, deps) {
  const counts = { imported: 0, skipped: 0, errors: 0, lines: 0 };

  for await (const line of lines) {
    counts.lines++;
    const trimmed = line.trim();
    if (!trimmed) continue; /** 빈 줄 건너뜀 */

    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`[import] Line ${counts.lines}: JSON parse error, skipping\n`);
      counts.errors++;
      continue;
    }

    if (!row.content || !row.topic) {
      process.stderr.write(
        `[import] Line ${counts.lines}: missing required field(s) 'content' and/or 'topic', skipping\n`
      );
      counts.errors++;
      continue;
    }

    const result = await importRow(row, counts.lines, deps);
    if (result === "imported")     counts.imported++;
    else if (result === "skipped") counts.skipped++;
    else                           counts.errors++;
  }
  return counts;
}

export default async function importCmd(args) {
  const inputFile  = args.input   || null;
  const idempotent = args.idempotent === true;
  const dryRun     = args["dry-run"] === true || args.dryRun === true;

  const inStream = openInputStream(inputFile);
  const rl = readline.createInterface({ input: inStream, crlfDelay: Infinity });

  const pool = dryRun ? null : new pg.Pool({
    host: DB_HOST, port: DB_PORT, database: DB_NAME,
    user: DB_USER, password: DB_PASSWORD, max: 3,
  });

  try {
    const deps   = await loadImportDeps();
    const counts = await importRows(rl, { ...deps, pool, idempotent, dryRun });
    const summary = { imported: counts.imported, skipped: counts.skipped, errors: counts.errors, dryRun, lines: counts.lines };

    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      const mode = dryRun ? " [dry-run]" : "";
      console.log(`Import complete${mode}: Imported ${summary.imported} / Skipped ${summary.skipped} / Errors ${summary.errors}`);
    }

  } catch (err) {
    console.error(`[import] ${err.message}`);
    process.exit(1);
  } finally {
    if (pool) await pool.end();
  }
}
