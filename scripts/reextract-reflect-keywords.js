/**
 * reextract-reflect-keywords.js — session_reflect 파편 keywords 재추출.
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 *
 * 사용: node scripts/reextract-reflect-keywords.js [--execute]
 *       기본은 dryRun(변경 없음). 실제 UPDATE는 --execute 필수.
 *
 * reflect 파편(topic='session_reflect')은 keywords가 100% 자동추출이므로
 * 신 extractKeywords 정책(조사 스트리핑·식별자 보존)으로 안전하게 재계산한다.
 */
import { getPrimaryPool }   from "../lib/tools/db.js";
import { FragmentFactory }  from "../lib/memory/write/FragmentFactory.js";

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
    `SELECT id, content, keywords
       FROM ${SCHEMA}.fragments
      WHERE topic = 'session_reflect'`
  );
  console.log(`대상 reflect 파편 건수: ${rows.length}`);

  let changed = 0;
  for (const row of rows) {
    const next = factory.extractKeywords(row.content || "");
    const prev = Array.isArray(row.keywords) ? row.keywords : [];
    const diff = JSON.stringify(prev) !== JSON.stringify(next);
    if (!diff) continue;
    changed++;
    if (execute) {
      await pool.query(
        `UPDATE ${SCHEMA}.fragments SET keywords = $1 WHERE id = $2`,
        [next, row.id]
      );
    } else {
      console.log(`[dryRun] ${row.id}: ${JSON.stringify(prev)} -> ${JSON.stringify(next)}`);
    }
  }

  console.log(`${execute ? "갱신" : "변경 예정"} 건수: ${changed}`);
  await pool.end?.();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
