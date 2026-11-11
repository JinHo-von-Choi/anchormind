/**
 * normalize-feedback-tool-names.js — tool_feedback.tool_name 정규화
 *
 * 작성자: 최진호
 * 작성일: 2026-10-13
 *
 * 저장된 tool_feedback 행의 tool_name을 tool_feedback 도구가 저장할 때와 같은 규칙
 * (lib/tools/tool-name.js)으로 바꾼다. 바뀌는 이름별 건수를 출력한다.
 * 기본은 dryRun(변경 없음). 실제 UPDATE는 --execute 필수.
 *
 * 사용:
 *   node scripts/normalize-feedback-tool-names.js            # 미리보기
 *   node scripts/normalize-feedback-tool-names.js --execute  # 실제 갱신
 */

import path                          from "node:path";
import { getPrimaryPool }            from "../lib/tools/db.js";
import { SCHEMA }                    from "../lib/memory/schema.js";
import { normalizeFeedbackToolName } from "../lib/tools/tool-name.js";

/**
 * @param {{pool?: Object, execute?: boolean, out?: Function}} [opts]
 * @returns {Promise<{renamed: number, updated: number}>}
 */
export async function main({
  pool    = getPrimaryPool(),
  execute = process.argv.slice(2).includes("--execute"),
  out     = (line) => console.log(line)
} = {}) {
  if (!pool) {
    throw new Error("DB pool unavailable");
  }

  const { rows } = await pool.query(
    `SELECT tool_name, count(*)::int AS cnt FROM ${SCHEMA}.tool_feedback GROUP BY tool_name`
  );
  const changes = rows
    .map(r => ({ from: r.tool_name, to: normalizeFeedbackToolName(r.tool_name), cnt: r.cnt }))
    .filter(c => c.to !== c.from)
    .sort((a, b) => b.cnt - a.cnt);

  const renamed = changes.reduce((sum, c) => sum + c.cnt, 0);
  out(`바뀌는 이름 ${changes.length}종, ${renamed}건`);
  for (const c of changes) out(`  ${c.from} -> ${c.to}: ${c.cnt}건`);

  let updated = 0;
  if (!execute) {
    out("\ndryRun: 변경 없음. 실제 갱신은 --execute.");
  } else {
    for (const c of changes) {
      const { rowCount } = await pool.query(
        `UPDATE ${SCHEMA}.tool_feedback SET tool_name = $2 WHERE tool_name = $1`,
        [c.from, c.to]
      );
      updated += rowCount;
    }
    out(`\nUPDATE 완료: ${updated}건`);
  }
  return { renamed, updated };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main()
    .then(async () => { await getPrimaryPool()?.end?.(); })
    .catch(async (err) => {
      console.error(err);
      await getPrimaryPool()?.end?.();
      process.exit(1);
    });
}
