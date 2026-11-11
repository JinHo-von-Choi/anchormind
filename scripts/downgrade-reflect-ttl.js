/**
 * downgrade-reflect-ttl.js — session_reflect permanent 파편의 TTL 재평가·강등.
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 *
 * 사용: node scripts/downgrade-reflect-ttl.js [--execute]
 *       기본은 dryRun(변경 없음). 실제 UPDATE는 --execute 필수.
 *
 * 구 정책(reflect decision importance 0.8)으로 permanent 승격된 파편을
 * 신 _inferTTL(type, importance) 기준으로 재평가한다. 앵커는 제외.
 */
import { getPrimaryPool }  from "../lib/tools/db.js";
import { FragmentFactory } from "../lib/memory/write/FragmentFactory.js";

const SCHEMA  = "agent_memory";
const args    = process.argv.slice(2);
const execute = args.includes("--execute");

async function main() {
  const pool = getPrimaryPool();
  if (!pool) {
    console.error("DB 풀 미가용 — 종료");
    process.exit(1);
  }
  const factory = new FragmentFactory();

  const { rows } = await pool.query(
    `SELECT id, type, importance, ttl_tier
       FROM ${SCHEMA}.fragments
      WHERE topic = 'session_reflect'
        AND ttl_tier = 'permanent'
        AND is_anchor = false`
  );
  console.log(`대상 permanent reflect 파편 건수: ${rows.length}`);

  let changed = 0;
  for (const row of rows) {
    const next = factory._inferTTL(row.type, Number(row.importance));
    if (next === "permanent") continue;   // 재평가에도 permanent면 유지
    changed++;
    if (execute) {
      await pool.query(
        `UPDATE ${SCHEMA}.fragments SET ttl_tier = $1 WHERE id = $2`,
        [next, row.id]
      );
    } else {
      console.log(`[dryRun] ${row.id}: permanent -> ${next} (type=${row.type}, imp=${row.importance})`);
    }
  }

  console.log(`${execute ? "강등" : "강등 예정"} 건수: ${changed}`);
  await pool.end?.();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
