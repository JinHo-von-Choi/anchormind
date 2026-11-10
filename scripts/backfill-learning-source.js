/**
 * backfill-learning-source.js — 자동 회고 학습 항목의 source 소급 지정
 *
 * 작성자: 최진호
 * 작성일: 2026-11-10
 *
 * 자동 회고(AutoReflect)는 학습 항목 앞에 "LEARNING:"을 붙인다. 7.3.0까지는 저장한 뒤에 응답 객체의
 * source만 바꿔서, 저장된 행에는 접두어가 본문에 남고 source는 session:<id>였다. context의 Learning 구획은
 * source='learning_extraction'을 읽으므로 이 행들이 나타나지 않았다.
 *
 * 대상: 열린 파편(valid_to IS NULL) 중 본문이 "LEARNING:"으로 시작하는 행.
 * 처리: amend 경로(쓰기 관문, 이력, 해시·토큰·임베딩 재생성)로 접두어를 뗀 본문을 쓰고, 같은 트랜잭션 밖에서
 *       source를 learning_extraction으로 바꾼다. 같은 키에 같은 본문이 이미 있어 amend가 병합하면 source는 바꾸지 않고
 *       병합 건수로 센다.
 * 기본은 미리보기(변경 없음)다. 실제 갱신은 --execute가 필요하다.
 *
 * 사용:
 *   node scripts/backfill-learning-source.js            # 미리보기
 *   node scripts/backfill-learning-source.js --execute  # 실제 갱신
 */

import path               from "node:path";
import { getPrimaryPool } from "../lib/tools/db.js";
import { SCHEMA }         from "../lib/memory/schema.js";
import { LEARNING_PREFIX, LEARNING_SOURCE } from "../lib/memory/processors/ReflectProcessor.js";

/** 대상 행 조회 */
export const CANDIDATE_SQL =
  `SELECT id, content, agent_id, key_id, workspace, source
     FROM ${SCHEMA}.fragments
    WHERE valid_to IS NULL
      AND content LIKE 'LEARNING:%'
    ORDER BY created_at ASC, id ASC`;

/**
 * 접두어를 뗀 본문. 떼고 나서 비면 null이다.
 *
 * @param {string} content
 * @returns {string|null}
 */
export function strippedContent(content) {
  const stripped = String(content ?? "").replace(LEARNING_PREFIX, "").trim();
  return stripped === "" ? null : stripped;
}

/**
 * @param {{pool?: Object, manager?: Object, execute?: boolean, out?: Function}} [opts]
 * @returns {Promise<{candidates: number, updated: number, merged: number, skipped: number, failed: number}>}
 */
export async function main({
  pool    = getPrimaryPool(),
  manager = null,
  execute = process.argv.slice(2).includes("--execute"),
  out     = (line) => console.log(line)
} = {}) {
  const { rows } = await pool.query(CANDIDATE_SQL);
  const summary  = { candidates: rows.length, updated: 0, merged: 0, skipped: 0, failed: 0 };
  out(`[learning-source] candidates=${rows.length} mode=${execute ? "execute" : "preview"}`);

  if (!execute) {
    for (const row of rows.slice(0, 10)) out(`  ${row.id} ${String(row.content).slice(0, 60)}`);
    return summary;
  }

  const mm = manager ?? (await import("../lib/memory/MemoryManager.js")).MemoryManager.getInstance();
  for (const row of rows) {
    const content = strippedContent(row.content);
    if (content === null) { summary.skipped++; continue; }
    try {
      const result = await mm.amend({
        id       : row.id,
        content,
        agentId  : row.agent_id,
        _keyId   : row.key_id ?? null,
        _isMaster: row.key_id == null
      });
      if (result?.merged === true) {
        summary.merged++;
        continue;
      }
      if (result?.updated !== true) {
        summary.failed++;
        out(`  ${row.id} amend not applied: ${result?.error ?? "unknown"}`);
        continue;
      }
      await pool.query(`UPDATE ${SCHEMA}.fragments SET source = $2 WHERE id = $1`, [row.id, LEARNING_SOURCE]);
      summary.updated++;
    } catch (err) {
      summary.failed++;
      out(`  ${row.id} failed: ${err.message}`);
    }
  }
  out(`[learning-source] updated=${summary.updated} merged=${summary.merged} skipped=${summary.skipped} failed=${summary.failed}`);
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`[learning-source] ${err.message}`); process.exit(1); });
}
