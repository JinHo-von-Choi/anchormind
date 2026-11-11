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
 * 의존: DATABASE_URL
 * 관련 문서: docs/operations/maintenance.md#cleanup-noise
 *
 * 삭제 범주:
 *   1. 초단문 — content < 10자 AND access_count <= 1 AND is_anchor IS NOT TRUE
 *   2. 빈 세션 요약 — type='fact' AND content LIKE '%파편 0개 처리%' AND importance < 0.3
 *   3. NLI 재귀 쓰레기 — content LIKE '[모순 해결]%' AND access_count <= 1 AND importance < 0.3
 *                         (--include-nli 플래그 지정 시에만 활성)
 *
 * 사용: node scripts/cleanup-noise.js [--dry-run] [--execute] [--include-nli]
 *       기본 실행은 --dry-run 모드(삭제 없음). 실제 삭제는 --execute 필수.
 */
import pg from "pg";

const DB_URL = process.env.DATABASE_URL;

if (!DB_URL) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

const args       = process.argv.slice(2);
const execute    = args.includes("--execute");
const includeNli = args.includes("--include-nli");

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

async function run() {
  const pool   = new pg.Pool({ connectionString: DB_URL });
  const client = await pool.connect();

  try {
    const mode = execute ? "Execute mode" : "Dry run mode (use --execute to delete)";
    console.log(`[cleanup-noise] ${mode}\n`);

    let totalCount = 0;

    for (let i = 0; i < CATEGORIES.length; i++) {
      const cat = CATEGORIES[i];

      if (!cat.always && !includeNli) continue;

      const label = `Category ${i + 1}: ${cat.name}`;

      const selectSql = `
        SELECT id, LEFT(content, 50) AS preview, type, importance, access_count
        FROM agent_memory.fragments
        WHERE ${cat.where}
      `;

      const { rows } = await client.query(selectSql);
      console.log(label);
      console.log(`  Found: ${rows.length} fragments`);

      for (const row of rows.slice(0, 5)) {
        const preview = row.preview.replace(/\n/g, " ");
        console.log(
          `  Sample: [${row.id}] "${preview}" (${row.type}, imp=${row.importance}, access=${row.access_count})`
        );
      }

      if (rows.length > 5) {
        console.log(`  ... and ${rows.length - 5} more`);
      }

      console.log();
      totalCount += rows.length;

      if (execute && rows.length > 0) {
        const deleteSql = `DELETE FROM agent_memory.fragments WHERE ${cat.where}`;
        const result    = await client.query(deleteSql);
        console.log(`  Deleted: ${result.rowCount} fragments\n`);
      }
    }

    if (execute) {
      console.log(`Total: ${totalCount} fragments deleted`);
    } else {
      console.log(`Total: ${totalCount} fragments would be deleted`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error("[cleanup-noise] Failed:", err.message);
  process.exit(1);
});
