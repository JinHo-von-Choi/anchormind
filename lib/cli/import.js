/**
 * CLI: import, JSONL 파편 복원
 *
 * JSONL 파일(또는 stdin)을 읽어 파편은 의미 쓰기 관문(WriteGate)을 거쳐 FragmentWriter로,
 * 링크와 이력은 저장된 id로 바꿔 기록한다. 파편 줄마다 트랜잭션을 연다. 형식 버전 2(머리 줄이 있는
 * export 결과)와 버전 1(머리 줄 없는 파편 줄)을 읽는다.
 *
 * 집계: imported(새로 기록), duplicates(같은 본문이 이미 있음), rejected(유형이 있는 사유로 받아들이지
 * 않음), errors(행 문제가 아닌 실패). 링크와 이력은 따로 센다.
 * --key:        기록 대상 키(key_id). 없으면 마스터 범위. 파일 행의 key_id는 읽지 않는다.
 * --idempotent: 같은 id가 이미 있어 기록이 거부된 행도 duplicates로 센다.
 * --dry-run:    같은 경로로 처리하고 끝에 트랜잭션을 되돌린다. 집계는 실제 실행과 같다.
 * --restore:    저장된 값을 되살린다(형식 버전 2 파일만). 본문 최소 품질 검사와 저장 길이 절삭을
 *               건너뛰고 importance 상한을 적용하지 않는다. 민감 정보 마스킹은 적용한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 * 수정일: 2026-10-03 (의미 쓰기 관문과 FragmentWriter 경유, 형식 버전 2, 정확한 집계)
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
  "Reads format version 2 (header line, fragments, links, versions) and version 1",
  "(fragment lines only; accepted until 2027-10-03).",
  "",
  "Options:",
  "  --input <FILE>        Read from file instead of stdin",
  "  --key <key_id>        Target API key (key_id). Omit for master scope.",
  "                        key_id values inside the file are never read.",
  "  --idempotent          Count a fragment whose id already exists under the same key as a",
  "                        duplicate (otherwise, or under another key, it is id_conflict)",
  "  --dry-run             Process every line the same way, then roll the transaction back",
  "  --restore             Restore stored values (format version 2 only): skips the minimum",
  "                        content check and the storage length cut, keeps importance, ttl_tier",
  "                        and workspace_source as exported. Secret masking still applies.",
  "  --json                Output summary as JSON",
  "",
  "Summary: imported (new rows), duplicates (same content already stored), rejected (typed",
  "reasons), errors (failures that are not about the row). Links and versions are counted apart.",
  "",
  "JSONL fragment line:",
  "  Required: content, topic",
  "  Optional: id, type, keywords, importance, source, agent_id, created_at, valid_from,",
  "            is_anchor, case_id, idempotency_key, goal, outcome, phase, resolution_status,",
  "            assertion_status, context_summary, workspace",
  "",
  "Examples:",
  "  memento-mcp import --input backup.jsonl",
  "  memento-mcp import --input backup.jsonl --idempotent",
  "  cat backup.jsonl | memento-mcp import --dry-run",
  "  memento-mcp import --input backup.jsonl --restore --key <key_id>",
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

/**
 * JSONL 줄을 차례로 가져온다.
 *
 * @param {AsyncIterable<string>|Iterable<string>} lines
 * @param {Object} deps - loadImportRuntime 결과와 pool, idempotent, dryRun
 * @returns {Promise<import("../memory/transfer/ImportReport.js").ImportReport>}
 */
export async function importRows(lines, deps) {
  const [{ ImportReport }, { runImport }, { recordsFromLines }] = await Promise.all([
    import("../memory/transfer/ImportReport.js"),
    import("../memory/transfer/ImportRunner.js"),
    import("../memory/transfer/importRecords.js")
  ]);
  const report = deps.report ?? new ImportReport({ dryRun: deps.dryRun === true, restore: deps.profile?.restore === true });
  const log    = deps.log ?? ((message) => process.stderr.write(`[import] ${message}\n`));
  return runImport(recordsFromLines(lines), { ...deps, report, log });
}

/** 요약 한 줄 이상을 사람이 읽는 형태로 만든다. */
function formatSummary(summary) {
  const mode   = summary.dryRun ? " [dry-run]" : "";
  const lines  = [
    `Import complete${mode}: Imported ${summary.imported} / Duplicates ${summary.duplicates} / Rejected ${summary.rejected} / Errors ${summary.errors}`
  ];
  const l = summary.links;
  const v = summary.versions;
  if (l.imported + l.duplicates + l.rejected + l.errors > 0) {
    lines.push(`Links: Imported ${l.imported} / Duplicates ${l.duplicates} / Rejected ${l.rejected} / Errors ${l.errors}`);
  }
  if (v.imported + v.duplicates + v.rejected + v.errors > 0) {
    lines.push(`Versions: Imported ${v.imported} / Duplicates ${v.duplicates} / Rejected ${v.rejected} / Errors ${v.errors}`);
  }
  const reasons = Object.entries(summary.rejected_by_reason);
  if (reasons.length > 0) lines.push(`Rejected by reason: ${reasons.map(([k, n]) => `${k}=${n}`).join(", ")}`);
  if (summary.transformed > 0) {
    const byReason = Object.entries(summary.transformed_by_reason).map(([k, n]) => `${k}=${n}`).join(", ");
    lines.push(`Transformed on import: ${summary.transformed} (${byReason})`);
  }
  for (const w of summary.warnings) lines.push(`Warning: ${w.code}`);
  return lines.join("\n");
}

/**
 * 되살리기 가져오기의 감사 한 줄. 끝났는지(completed)와 오류로 멈췄는지(failed)와 그때까지의 집계를
 * 남긴다.
 *
 * @param {Object}  summary - ImportReport.toJSON() 결과
 * @param {Object}  options
 * @param {string|null} options.keyId
 * @param {boolean} options.dryRun
 * @param {"completed"|"failed"} options.outcome
 * @param {Function} [options.audit] - logAudit 대체(시험용)
 * @returns {Promise<void>}
 */
export async function auditRestoreImport(summary, { keyId, dryRun, outcome, audit }) {
  const write = audit ?? (await import("../logging/audit.js")).logAudit;
  await write("cli import restore", {
    success: outcome === "completed",
    details: `restore=trusted outcome=${outcome} dryRun=${dryRun} key=${keyId ?? "master"} imported=${summary.imported} `
      + `duplicates=${summary.duplicates} rejected=${summary.rejected} errors=${summary.errors} transformed=${summary.transformed}`,
    actor  : { keyId: "cli" }
  });
}

/**
 * 가져오기를 실행한다. 되살리기이면 끝나든 오류로 멈추든 그때까지 기록한 내용을 감사에 남긴다.
 *
 * @param {import("../memory/transfer/ImportReport.js").ImportReport} report
 * @param {{keyId: string|null, dryRun: boolean, restore: boolean, audit?: Function}} options
 * @param {() => Promise<unknown>} execute
 */
export async function runAudited(report, options, execute) {
  let outcome = "failed";
  try {
    await execute();
    outcome = "completed";
  } finally {
    if (options.restore) await auditRestoreImport(report.toJSON(), { ...options, outcome });
  }
}

export default async function importCmd(args) {
  const inputFile  = args.input   || null;
  const idempotent = args.idempotent === true;
  const dryRun     = args["dry-run"] === true || args.dryRun === true;
  const restore    = args.restore === true;
  const keyId      = typeof args.key === "string" && args.key !== "" ? args.key : null;

  const inStream = openInputStream(inputFile);
  const rl = readline.createInterface({ input: inStream, crlfDelay: Infinity });

  const pool = new pg.Pool({
    host: DB_HOST, port: DB_PORT, database: DB_NAME,
    user: DB_USER, password: DB_PASSWORD, max: 3,
  });

  try {
    const { loadImportRuntime, targetKeyExists } = await import("../memory/transfer/importRuntime.js");
    const { ImportReport }                       = await import("../memory/transfer/ImportReport.js");
    if (keyId && !(await targetKeyExists(pool, keyId))) {
      console.error(`[import] Unknown key_id: ${keyId}`);
      process.exit(1);
    }
    const runtime = await loadImportRuntime("cli", { keyId, restore });
    const report  = new ImportReport({ dryRun, restore });
    await runAudited(report, { keyId, dryRun, restore }, () => importRows(rl, { ...runtime, pool, idempotent, dryRun, report }));
    const summary = report.toJSON();

    console.log(args.json ? JSON.stringify(summary, null, 2) : formatSummary(summary));
  } catch (err) {
    console.error(`[import] ${err.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}
