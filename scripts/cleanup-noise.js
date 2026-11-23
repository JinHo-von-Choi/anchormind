#!/usr/bin/env node
/**
 * cleanup-noise.js — agent_memory.fragments 저품질 파편 탐지·삭제
 *
 * 작성자: 최진호
 * 수정일: 2026-04-20 (v2.12.0 문서 현행화 반영)
 *
 * 목적: DB에 축적된 초단문, 빈 세션 요약, NLI 재귀 쓰레기 등 노이즈 파편을
 *       보수적 AND 조건으로 일괄 제거한다.
 * 호출 조건: recall 품질 저하 또는 context 토큰 예산에 노이즈 파편이 영향을 준다고 판단될 때
 * 빈도: 조건부. 필요 시 월 1회 기준
 * 의존: POSTGRES_* 또는 DATABASE_URL
 * 관련 문서: docs/operations/maintenance.md#cleanup-noise
 *
 * 삭제 범주:
 *   1. 초단문 — content < 10자 AND access_count <= 1 AND is_anchor IS NOT TRUE
 *   2. 빈 세션 요약 — type='fact' AND content LIKE '%파편 0개 처리%' AND importance < 0.3
 *   3. NLI 재귀 쓰레기 — content LIKE '[모순 해결]%' AND access_count <= 1 AND importance < 0.3
 *                         (--include-nli 플래그 지정 시에만 활성)
 *
 * 자동 정리가 꺼진 범위(MEMENTO_RETENTION_MODE=manual, 관리 콘솔의 Cleanup Settings, memento-mcp retention)의 파편은
 * 기본으로 건너뛰고 미리보기에 건너뛴 수를 보여 준다. --include-manual을 주면 함께 지운다.
 * 삭제는 forget과 같은 삭제 문장과 삭제 뒤 정리(링크, 사례 사본, 색인)를 거친다.
 *
 * 사용: node scripts/cleanup-noise.js [--dry-run] [--execute] [--include-nli] [--include-manual]
 *       기본 실행은 --dry-run 모드(삭제 없음). 실제 삭제는 --execute 필수.
 *       접속은 POSTGRES_* 환경 변수로 하고, 없으면 DATABASE_URL을 읽는다.
 */
/** 앱 DB 모듈은 POSTGRES_* 환경 변수로 붙는다. DATABASE_URL만 있으면 그 값으로 채운다. */
if (!process.env.POSTGRES_HOST && process.env.DATABASE_URL) {
  const url = new URL(process.env.DATABASE_URL);
  process.env.POSTGRES_HOST     = url.hostname;
  process.env.POSTGRES_PORT     = url.port || "5432";
  process.env.POSTGRES_DB       = decodeURIComponent(url.pathname.replace(/^\//, ""));
  process.env.POSTGRES_USER     = decodeURIComponent(url.username);
  process.env.POSTGRES_PASSWORD = decodeURIComponent(url.password);
}
if (!process.env.POSTGRES_HOST) {
  console.error("POSTGRES_HOST or DATABASE_URL environment variable is required");
  process.exit(1);
}

const { queryWithAgentVector, shutdownPool }            = await import("../lib/tools/db.js");
const { SCHEMA, DEINDEX_COLUMNS }                        = await import("../lib/memory/schema.js");
const { DELETE_LOCKED_SQL, LOCK_FOR_DELETE, fragmentRowLock } = await import("../lib/memory/write/rowLock.js");
const { cleanupDeletedRows }                             = await import("../lib/memory/write/DeleteCleanup.js");
const { lifecycleGuardSql }                              = await import("../lib/memory/consolidate/RetentionGuard.js");

const args          = process.argv.slice(2);
const execute       = args.includes("--execute");
const includeNli    = args.includes("--include-nli");
const includeManual = args.includes("--include-manual");

const CATEGORIES = [
  {
    name:  "Short fragments (<10 chars)",
    where: "length(content) < 10 AND access_count <= 1 AND is_anchor IS NOT TRUE",
    always: true,
  },
  {
    name:  "Empty session summaries",
    where: "type = 'fact' AND content LIKE '%파편 0개 처리%' AND importance < 0.3",
    always: true,
  },
  {
    name:  "NLI recursion garbage",
    where: "content LIKE '[모순 해결]%' AND access_count <= 1 AND importance < 0.3",
    always: false,
  },
];

const query = (sql, params = []) => queryWithAgentVector("system", sql, params);

async function run() {
  const mode = execute ? "Execute mode" : "Dry run mode (use --execute to delete)";
  console.log(`[cleanup-noise] ${mode}\n`);

  /** 자동 정리가 꺼진 범위를 빼는 조건. --include-manual이면 붙이지 않는다. */
  const guard = includeManual ? "" : await lifecycleGuardSql(`${SCHEMA}.fragments`);
  let totalCount   = 0;
  let totalSkipped = 0;

  for (let i = 0; i < CATEGORIES.length; i++) {
    const cat = CATEGORIES[i];
    if (!cat.always && !includeNli) continue;

    const where = `${cat.where}${guard}`;
    const { rows } = await query(
      `SELECT id, LEFT(content, 50) AS preview, type, importance, access_count
         FROM ${SCHEMA}.fragments WHERE ${where}`);
    const skipped = guard
      ? (await query(`SELECT count(*)::int AS n FROM ${SCHEMA}.fragments WHERE ${cat.where}`)).rows[0].n - rows.length
      : 0;

    console.log(`Category ${i + 1}: ${cat.name}`);
    console.log(`  Found: ${rows.length} fragments`);
    if (skipped > 0) console.log(`  Skipped (automatic cleanup off): ${skipped} fragments (use --include-manual to include)`);

    for (const row of rows.slice(0, 5)) {
      const preview = row.preview.replace(/\n/g, " ");
      console.log(
        `  Sample: [${row.id}] "${preview}" (${row.type}, imp=${row.importance}, access=${row.access_count})`
      );
    }
    if (rows.length > 5) console.log(`  ... and ${rows.length - 5} more`);
    console.log();
    totalCount   += rows.length;
    totalSkipped += skipped;

    if (execute && rows.length > 0) {
      const result = await queryWithAgentVector("system",
        `${DELETE_LOCKED_SQL} RETURNING ${DEINDEX_COLUMNS}`, [],
        { lock: fragmentRowLock("cleanup_noise", where, [], LOCK_FOR_DELETE) });
      await cleanupDeletedRows(result.rows, "system");
      console.log(`  Deleted: ${result.rowCount} fragments\n`);
    }
  }

  console.log(execute
    ? `Total: ${totalCount} fragments deleted`
    : `Total: ${totalCount} fragments would be deleted`);
  if (totalSkipped > 0) console.log(`Skipped: ${totalSkipped} fragments in scopes with automatic cleanup off`);
}

try {
  await run();
} catch (err) {
  console.error("[cleanup-noise] Failed:", err.message);
  process.exitCode = 1;
} finally {
  await shutdownPool().catch((err) => console.error("[cleanup-noise] pool shutdown failed:", err.message));
}
