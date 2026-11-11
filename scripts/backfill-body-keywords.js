/**
 * backfill-body-keywords.js — 본문 식별자가 누락된 파편에 키워드 소급 병합
 *
 * 작성자: 최진호
 * 작성일: 2026-08-02
 *
 * 대상: 본문에 코드 식별자(camelCase/snake_case)가 있으나 keywords 배열에는
 *       식별자가 하나도 없는 유효 파편. 5.4.1 이하에서 사용자가 keywords를
 *       지정하면 본문 추출이 수행되지 않아 발생했다.
 * 규칙: 기존 keywords를 앞에 두고 본문 추출 결과를 중복 제거하여 병합한다.
 *       기존 키워드는 절대 제거하지 않으며 병합 결과가 기존과 같으면 건너뛴다.
 *       기본은 dryRun. 실제 UPDATE는 --execute 필수.
 *
 * 사용:
 *   node scripts/backfill-body-keywords.js            # 미리보기
 *   node scripts/backfill-body-keywords.js --execute  # 실제 반영
 */

import { getPrimaryPool }                      from "../lib/tools/db.js";
import { FragmentFactory, mergeKeywords }      from "../lib/memory/write/FragmentFactory.js";

const SCHEMA     = "agent_memory";
const BATCH_SIZE = 500;

const args    = process.argv.slice(2);
const execute = args.includes("--execute");

async function main() {
  const pool = getPrimaryPool();
  if (!pool) {
    console.error("DB pool unavailable");
    process.exit(1);
  }

  const factory = new FragmentFactory();

  /** 본문에 식별자가 있으나 keywords에는 없는 파편만 대상으로 한다. */
  const { rows } = await pool.query(
    `SELECT id, content, keywords
       FROM ${SCHEMA}.fragments
      WHERE valid_to IS NULL
        AND content ~ '[a-z][A-Z]'
        AND NOT EXISTS (SELECT 1 FROM unnest(keywords) k WHERE k ~ '[a-z][A-Z]')`
  );

  const planned = [];
  let unchanged = 0;

  for (const f of rows) {
    const existing = Array.isArray(f.keywords) ? f.keywords : [];
    const merged   = mergeKeywords(existing, factory.extractKeywords(String(f.content ?? "")));

    if (merged.length === existing.length) {
      unchanged++;
      continue;
    }
    planned.push({ id: f.id, merged, added: merged.slice(existing.length) });
  }

  console.log(`대상 ${rows.length}건 중 병합 대상 ${planned.length} / 변화 없음 ${unchanged}`);
  for (const p of planned.slice(0, 5)) {
    console.log(`  - ${p.id} :: +[${p.added.join(", ")}]`);
  }

  if (!execute) {
    console.log("\ndryRun — 변경 없음. 실제 반영은 --execute.");
    await pool.end?.();
    return;
  }

  let updated = 0;
  for (const [i, p] of planned.entries()) {
    const { rowCount } = await pool.query(
      `UPDATE ${SCHEMA}.fragments SET keywords = $2::text[] WHERE id = $1`,
      [p.id, p.merged]
    );
    updated += rowCount;
    if ((i + 1) % BATCH_SIZE === 0) console.log(`  진행 ${i + 1}/${planned.length}`);
  }

  console.log(`\nUPDATE 완료: ${updated}건`);
  await pool.end?.();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
