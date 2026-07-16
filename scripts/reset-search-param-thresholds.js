/**
 * reset-search-param-thresholds.js — P1 버그로 하향 학습된 min_similarity 리셋.
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 *
 * 사용: node scripts/reset-search-param-thresholds.js [--execute]
 *       기본은 dryRun(변경 없음). 실제 UPDATE는 --execute 필수.
 *
 * text/mixed recall 0건 버그 기간에 avg 결과<1로 min_similarity가 하한(0.10)
 * 근처까지 잘못 학습된 행을 config 기본값(0.5)으로 리셋한다.
 */
import { getPrimaryPool } from "../lib/tools/db.js";
import { MEMORY_CONFIG }  from "../config/memory.js";

const SCHEMA   = "agent_memory";
const DEFAULT  = MEMORY_CONFIG.semanticSearch?.minSimilarity ?? 0.5;
const RESET_LT = 0.5;   // min_similarity가 이 값 미만인 행을 리셋 대상으로 간주
const args     = process.argv.slice(2);
const execute  = args.includes("--execute");

async function main() {
  const pool = getPrimaryPool();
  if (!pool) {
    console.error("DB 풀 미가용 — 종료");
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT count(*)::int AS cnt
       FROM ${SCHEMA}.search_param_thresholds
      WHERE min_similarity < $1`,
    [RESET_LT]
  );
  console.log(`리셋 대상 행 수 (min_similarity < ${RESET_LT}): ${rows[0].cnt}`);

  if (!execute) {
    console.log(`[dryRun] 실행 시 위 행들의 min_similarity를 ${DEFAULT}로 리셋합니다. --execute로 적용하세요.`);
    await pool.end?.();
    return;
  }

  const res = await pool.query(
    `UPDATE ${SCHEMA}.search_param_thresholds
        SET min_similarity = $1
      WHERE min_similarity < $2`,
    [DEFAULT, RESET_LT]
  );
  console.log(`리셋 완료: ${res.rowCount}행 -> min_similarity=${DEFAULT}`);
  await pool.end?.();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
