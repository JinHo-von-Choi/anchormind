/**
 * CLI: import — JSONL 파편 복원
 *
 * JSONL 파일(또는 stdin)을 읽어 각 줄을 JSON.parse 후
 * PostgreSQL fragments 테이블에 직접 INSERT한다.
 *
 * --idempotent: 파편의 idempotency_key 또는 id를 기준으로
 *               이미 존재하는 경우 INSERT 생략(ON CONFLICT DO NOTHING).
 * --dry-run:    실제 INSERT 없이 검증만 수행.
 *
 * 외부 의존성 없음. node:readline 표준 모듈만 사용.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 */

import pg       from "pg";
import fs       from "node:fs";
import path     from "node:path";
import readline from "node:readline";
import { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD } from "../config.js";
import { SCHEMA } from "../memory/schema.js";

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

/** 파편 행에서 INSERT 파라미터 추출 */
function rowToParams(row) {
  return {
    id                : row.id               || crypto.randomUUID(),
    content           : row.content,
    topic             : row.topic,
    type              : row.type             || "fact",
    keywords          : Array.isArray(row.keywords) ? row.keywords : [],
    importance        : typeof row.importance === "number" ? row.importance : 0.5,
    source            : row.source           || "import",
    agent_id          : row.agent_id         || "cli",
    created_at        : row.created_at       || null,
    is_anchor         : row.is_anchor        === true,
    case_id           : row.case_id          || null,
    idempotency_key   : row.idempotency_key  || null,
    goal              : row.goal             || null,
    outcome           : row.outcome          || null,
    phase             : row.phase            || null,
    resolution_status : row.resolution_status || null,
    assertion_status  : row.assertion_status  || null,
    content_hash      : null, /** DB 기본값 또는 trigger로 채움 */
    ttl_tier          : "warm",
  };
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

  let lineNum  = 0;
  let imported = 0;
  let skipped  = 0;
  let errors   = 0;

  try {
    if (!dryRun) {
      await pool.query(`SET search_path TO ${SCHEMA}, public`);
    }

    for await (const line of rl) {
      lineNum++;
      const trimmed = line.trim();
      if (!trimmed) continue; /** 빈 줄 건너뜀 */

      let row;
      try {
        row = JSON.parse(trimmed);
      } catch {
        process.stderr.write(`[import] Line ${lineNum}: JSON parse error — skipping\n`);
        errors++;
        continue;
      }

      if (!row.content || !row.topic) {
        process.stderr.write(
          `[import] Line ${lineNum}: missing required field(s) 'content' and/or 'topic' — skipping\n`
        );
        errors++;
        continue;
      }

      const p = rowToParams(row);

      if (dryRun) {
        imported++;
        continue;
      }

      try {
        if (idempotent) {
          /** ON CONFLICT DO NOTHING: idempotency_key 또는 id로 중복 방지 */
          const { rowCount } = await pool.query(
            `INSERT INTO ${SCHEMA}.fragments
              (id, content, topic, type, keywords, importance, source, agent_id,
               ttl_tier, is_anchor, case_id, idempotency_key,
               goal, outcome, phase, resolution_status, assertion_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
             ON CONFLICT (id) DO NOTHING`,
            [
              p.id, p.content, p.topic, p.type, p.keywords, p.importance,
              p.source, p.agent_id, p.ttl_tier, p.is_anchor, p.case_id,
              p.idempotency_key, p.goal, p.outcome, p.phase,
              p.resolution_status, p.assertion_status,
            ]
          );

          if (rowCount === 0) {
            skipped++;
          } else {
            imported++;
          }
        } else {
          await pool.query(
            `INSERT INTO ${SCHEMA}.fragments
              (id, content, topic, type, keywords, importance, source, agent_id,
               ttl_tier, is_anchor, case_id, idempotency_key,
               goal, outcome, phase, resolution_status, assertion_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [
              p.id, p.content, p.topic, p.type, p.keywords, p.importance,
              p.source, p.agent_id, p.ttl_tier, p.is_anchor, p.case_id,
              p.idempotency_key, p.goal, p.outcome, p.phase,
              p.resolution_status, p.assertion_status,
            ]
          );
          imported++;
        }
      } catch (err) {
        process.stderr.write(`[import] Line ${lineNum}: DB error — ${err.message}\n`);
        errors++;
      }
    }

    const summary = {
      imported,
      skipped,
      errors,
      dryRun,
      lines: lineNum,
    };

    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      const mode = dryRun ? " [dry-run]" : "";
      console.log(`Import complete${mode}: Imported ${imported} / Skipped ${skipped} / Errors ${errors}`);
    }

  } catch (err) {
    console.error(`[import] ${err.message}`);
    process.exit(1);
  } finally {
    if (pool) await pool.end();
  }
}
