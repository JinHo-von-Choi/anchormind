/**
 * backfill-split-keywords.js — split 자식 파편 키워드 소급 생성
 *
 * 작성자: 최진호
 * 작성일: 2026-08-02
 *
 * 대상: source LIKE 'split:%' AND keywords가 비어 있는 파편.
 * 규칙: 정상 저장 경로와 동일하게 FragmentFactory.extractKeywords(content) 결과를
 *       채운다. 추출 결과가 비면 해당 파편은 건너뛴다(빈 배열로 덮어쓰지 않음).
 *       기본은 dryRun(변경 없음). 실제 UPDATE는 --execute 필수.
 *
 * 사용:
 *   node scripts/backfill-split-keywords.js            # 미리보기
 *   node scripts/backfill-split-keywords.js --execute  # 실제 반영
 */

import { getPrimaryPool }  from "../lib/tools/db.js";
import { FragmentFactory } from "../lib/memory/write/FragmentFactory.js";

const SCHEMA    = "agent_memory";
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

  const { rows } = await pool.query(
    `SELECT id, content
       FROM ${SCHEMA}.fragments
      WHERE source LIKE 'split:%'
        AND coalesce(cardinality(keywords), 0) = 0`
  );

  const planned = [];
  let empty     = 0;

  for (const f of rows) {
    const keywords = factory.extractKeywords(String(f.content ?? ""));
    if (!keywords.length) {
      empty++;
      continue;
    }
    planned.push({ id: f.id, keywords, snippet: String(f.content ?? "").slice(0, 50) });
  }

  console.log(`대상 ${rows.length}건 중 추출 성공 ${planned.length} / 추출 불가 ${empty}`);
  for (const p of planned.slice(0, 5)) {
    console.log(`  - ${p.id} :: [${p.keywords.join(", ")}] :: ${p.snippet}`);
  }

  if (!execute) {
    console.log("\ndryRun — 변경 없음. 실제 반영은 --execute.");
    await pool.end?.();
    return;
  }

  /** 파편마다 키워드 배열이 다르므로 행 단위로 갱신한다. 진행 상황은 배치 경계에서 출력. */
  let updated = 0;
  for (const [i, p] of planned.entries()) {
    const { rowCount } = await pool.query(
      `UPDATE ${SCHEMA}.fragments
          SET keywords = $2::text[]
        WHERE id = $1
          AND coalesce(cardinality(keywords), 0) = 0`,
      [p.id, p.keywords]
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
