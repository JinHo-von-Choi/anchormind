/**
 * Legacy split-fragment cleanup (one-off, dryRun-gated).
 *
 * 작성자: 최진호
 * 작성일: 2026-06-09
 *
 * 기본 dry-run. 실제 삭제는 --apply 와 --yes 를 모두 줄 때만 수행한다.
 * 항상 총 건수와 샘플 10행을 먼저 출력한다.
 *
 * 사용:
 *   node scripts/cleanup-legacy-split-fragments.js            # dry-run (기본)
 *   node scripts/cleanup-legacy-split-fragments.js --apply --yes  # 실제 삭제
 */

import { getPrimaryPool } from "../lib/tools/db.js";

const SCHEMA = "agent_memory";

/**
 * 정리 대상 split 자식 선정 조건(WHERE 절 본문)을 구성한다.
 * @returns {string}
 */
export function buildSelectionWhere() {
  return (
    `source LIKE 'split:%'\n` +
    `       AND importance < 0.4\n` +
    `       AND access_count = 0\n` +
    `       AND NOT EXISTS (\n` +
    `             SELECT 1 FROM ${SCHEMA}.fragments parent\n` +
    `             WHERE parent.id = split_part(fragments.source, ':', 2)::uuid\n` +
    `               AND parent.valid_to IS NULL\n` +
    `       )`
  );
}

/**
 * @param {{apply:boolean, yes:boolean, limit?:number}} opts
 * @returns {Promise<{count:number, deleted:number}>}
 */
export async function runCleanup({ apply = false, yes = false, limit = 5000 } = {}) {
  const pool  = getPrimaryPool();
  const where = buildSelectionWhere();

  const { rows: countRows } = await pool.query(
    `SELECT count(*) AS n FROM ${SCHEMA}.fragments WHERE ${where}`
  );
  const count = Number(countRows[0].n);
  console.log(`[cleanup] 대상 split 자식: ${count}건`);

  const { rows: sample } = await pool.query(
    `SELECT id, content FROM ${SCHEMA}.fragments WHERE ${where} LIMIT 10`
  );
  for (const r of sample) {
    console.log(`  ${r.id}  ${String(r.content).slice(0, 80)}`);
  }

  if (!apply) {
    console.log("[cleanup] dry-run (기본). 삭제하려면 --apply --yes 를 함께 전달.");
    return { count, deleted: 0 };
  }
  if (!yes) {
    console.log("[cleanup] --apply 가 주어졌으나 --yes 미확인. 삭제하지 않음.");
    return { count, deleted: 0 };
  }

  const res = await pool.query(
    `DELETE FROM ${SCHEMA}.fragments WHERE id IN (
       SELECT id FROM ${SCHEMA}.fragments WHERE ${where} LIMIT $1
     )`,
    [limit]
  );
  console.log(`[cleanup] 삭제 완료: ${res.rowCount ?? 0}건`);
  return { count, deleted: res.rowCount ?? 0 };
}

/** CLI 진입점 — import 시에는 실행되지 않는다. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const apply = process.argv.includes("--apply");
  const yes   = process.argv.includes("--yes");
  runCleanup({ apply, yes }).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
