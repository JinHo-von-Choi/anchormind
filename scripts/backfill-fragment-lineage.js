/**
 * backfill-fragment-lineage.js — 분할 자식의 계보와 원본 없는 자식의 근거 상태 소급
 *
 * 작성자: 최진호
 * 작성일: 2026-11-10
 *
 * migration-081 이전의 분할 자식은 source='split:<원본 id>'와 part_of 링크로만 원본을 가리킨다. part_of 링크는
 * 원본이 지워지면 함께 사라진다(fragment_links 외래 키 ON DELETE CASCADE). 이 스크립트는 다음을 한다.
 *
 *   1. source가 split:으로 시작하는 파편마다 fragment_lineage(relation=split) 행을 만든다. 원본이 남아 있으면
 *      원본의 content_hash를 함께 적는다. 이미 있는 행은 건너뛴다.
 *   2. 원본이 없는 열린 자식에 근거 상태를 단다. 감사 기록(admin_audit_events)에 원본 id를 대상으로 한
 *      memory.forget이 있으면 revoked(parent_forgotten), 없으면 parent_missing이다. parent_missing은 주입을
 *      막지 않는 표지다. 이미 근거 상태가 있는 자식은 그대로 둔다.
 *
 * 기본은 미리보기(변경 없음)다. 실제 갱신은 --execute가 필요하다. 두 단계는 한 트랜잭션에서 실행한다.
 *
 * 사용:
 *   node scripts/backfill-fragment-lineage.js            # 미리보기
 *   node scripts/backfill-fragment-lineage.js --execute  # 실제 갱신
 */

import path               from "node:path";
import { getPrimaryPool } from "../lib/tools/db.js";
import { SCHEMA }         from "../lib/memory/schema.js";
import { SUPPORT_STATES, SUPPORT_REASONS, LINEAGE_RELATIONS } from "../lib/memory/write/Lineage.js";

/** 분할 자식과 원본 id. 원본 id는 source의 'split:' 뒤 문자열이다. */
const SPLIT_CHILDREN = `
  SELECT c.id AS child_id, substr(c.source, 7) AS parent_id, c.valid_to IS NULL AS child_open, c.support_state,
         p.id IS NOT NULL AS parent_exists, p.content_hash AS parent_content_hash
    FROM ${SCHEMA}.fragments c
    LEFT JOIN ${SCHEMA}.fragments p ON p.id = substr(c.source, 7)
   WHERE c.source LIKE 'split:%' AND length(c.source) > 6`;

/** 계보 행 생성 */
export const INSERT_LINEAGE_SQL = `
  INSERT INTO ${SCHEMA}.fragment_lineage (child_id, parent_id, relation, parent_content_hash)
  SELECT s.child_id, s.parent_id, '${LINEAGE_RELATIONS.SPLIT}', s.parent_content_hash
    FROM (${SPLIT_CHILDREN}) s
   WHERE s.child_id <> s.parent_id
  ON CONFLICT (child_id, parent_id, relation) DO NOTHING`;

/** 원본 없는 열린 자식과 그 원본이 forget으로 지워졌는지 여부 */
export const ORPHAN_SQL = `
  SELECT s.child_id, s.parent_id,
         EXISTS (SELECT 1 FROM ${SCHEMA}.admin_audit_events a
                  WHERE a.action = 'memory.forget' AND a.target_id = s.parent_id) AS forgotten
    FROM (${SPLIT_CHILDREN}) s
   WHERE NOT s.parent_exists AND s.child_open AND s.support_state IS NULL`;

/** 원본 없는 자식에 근거 상태를 단다. $1 자식 id, $2 상태, $3 사유 */
export const MARK_ORPHAN_SQL = `
  UPDATE ${SCHEMA}.fragments
     SET support_state = $2, support_reason = $3, support_changed_at = NOW()
   WHERE id = ANY($1::text[]) AND support_state IS NULL`;

/**
 * 원본 없는 자식을 상태별로 나눈다.
 *
 * @param {Array<{child_id: string, forgotten: boolean}>} rows
 * @returns {{revoked: string[], missing: string[]}}
 */
export function classifyOrphans(rows) {
  const revoked = [];
  const missing = [];
  for (const row of rows ?? []) (row.forgotten === true ? revoked : missing).push(row.child_id);
  return { revoked, missing };
}

/**
 * @param {{pool?: Object, execute?: boolean, out?: Function}} [opts]
 * @returns {Promise<{children: number, lineageInserted: number, revoked: number, parentMissing: number}>}
 */
export async function main({
  pool    = getPrimaryPool(),
  execute = process.argv.slice(2).includes("--execute"),
  out     = (line) => console.log(line)
} = {}) {
  const { rows: [counts] } = await pool.query(
    `SELECT count(*)::int AS children,
            count(*) FILTER (WHERE NOT parent_exists)::int AS orphans
       FROM (${SPLIT_CHILDREN}) s`);
  const orphanRows = (await pool.query(ORPHAN_SQL)).rows;
  const { revoked, missing } = classifyOrphans(orphanRows);
  const summary = { children: counts.children, lineageInserted: 0, revoked: revoked.length, parentMissing: missing.length };
  out(`[lineage] split children=${counts.children} orphans=${counts.orphans} open orphans: revoked=${revoked.length} parent_missing=${missing.length} mode=${execute ? "execute" : "preview"}`);
  if (!execute) return summary;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    summary.lineageInserted = (await client.query(INSERT_LINEAGE_SQL)).rowCount ?? 0;
    if (revoked.length > 0) {
      await client.query(MARK_ORPHAN_SQL, [revoked, SUPPORT_STATES.REVOKED, SUPPORT_REASONS.PARENT_FORGOTTEN]);
    }
    if (missing.length > 0) {
      await client.query(MARK_ORPHAN_SQL, [missing, SUPPORT_STATES.PARENT_MISSING, SUPPORT_REASONS.PARENT_MISSING]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(rbErr => console.error(`[lineage] rollback failed: ${rbErr.message}`));
    throw err;
  } finally {
    client.release();
  }
  out(`[lineage] lineage rows inserted=${summary.lineageInserted}`);
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`[lineage] ${err.message}`); process.exit(1); });
}
