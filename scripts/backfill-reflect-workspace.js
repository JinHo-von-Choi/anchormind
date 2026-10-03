/**
 * backfill-reflect-workspace.js — reflect 파편 workspace 소급 분류
 *
 * 작성자: 최진호
 * 작성일: 2026-07-27
 *
 * 대상: topic='session_reflect' AND workspace IS NULL AND valid_to IS NULL.
 * 규칙: DB에 실존하는 workspace 이름이 파편의 content+keywords 결합 텍스트에서
 *       정확히 1개만 발견될 때에만 해당 workspace로 이관한다. 0개 또는 2개 이상
 *       매칭(모호)은 NULL 유지. 범용 명칭(호스트명·플레이스홀더)은 후보에서 제외.
 *       기본은 dryRun(변경 없음). 실제 UPDATE는 --execute 필수.
 *       대상 workspace에 같은 키의 같은 본문이 이미 있는 파편은 옮기지 않는다(유일 색인
 *       uq_frag_hash_ws_per_key, uq_frag_hash_ws_master). dryRun은 그 건수를 함께 출력한다.
 *
 * 사용:
 *   node scripts/backfill-reflect-workspace.js            # 미리보기
 *   node scripts/backfill-reflect-workspace.js --execute  # 실제 이관
 */

import path               from "node:path";
import { getPrimaryPool } from "../lib/tools/db.js";

const SCHEMA = "agent_memory";

/** 오분류 위험이 큰 범용·플레이스홀더 명칭은 이관 후보에서 제외 */
const EXCLUDED_WORKSPACES = new Set([
  "default", "batch", "health", "personal", "nerdvana",
  "test-project", "other-project", "proj-a", "proj-b"
]);

/**
 * 옮길 파편과 같은 키(마스터는 key_id NULL)의 같은 본문이 대상 workspace($1)에 이미 있다.
 * 별칭 f는 옮길 파편이다.
 */
export const SAME_CONTENT_IN_TARGET =
  `EXISTS (SELECT 1 FROM ${SCHEMA}.fragments o
            WHERE o.key_id IS NOT DISTINCT FROM f.key_id
              AND o.workspace = $1
              AND o.content_hash = f.content_hash
              AND o.id <> f.id)`;

/**
 * @param {{pool?: Object, execute?: boolean, out?: Function}} [opts]
 * @returns {Promise<{total: number, excluded: number, updated: number}>}
 */
export async function main({
  pool    = getPrimaryPool(),
  execute = process.argv.slice(2).includes("--execute"),
  out     = (line) => console.log(line)
} = {}) {
  if (!pool) {
    throw new Error("DB pool unavailable");
  }

  const { rows: wsRows } = await pool.query(
    `SELECT workspace, count(*)::int AS cnt
       FROM ${SCHEMA}.fragments
      WHERE workspace IS NOT NULL
      GROUP BY workspace`
  );
  const candidates = wsRows
    .map(r => r.workspace)
    .filter(w => !EXCLUDED_WORKSPACES.has(w))
    .sort((a, b) => b.length - a.length);   /** 긴 이름 우선 — 부분 문자열 중복 판정용 */

  const { rows: frags } = await pool.query(
    `SELECT id, content, keywords
       FROM ${SCHEMA}.fragments
      WHERE topic = 'session_reflect' AND workspace IS NULL AND valid_to IS NULL`
  );

  const assignments = new Map();   /** workspace -> [{id, snippet}] */
  let ambiguous     = 0;
  let unmatched     = 0;

  for (const f of frags) {
    const haystack = (String(f.content ?? "") + " " + (f.keywords ?? []).join(" ")).toLowerCase();
    const matched  = [];

    for (const ws of candidates) {
      const needle = ws.toLowerCase();
      if (!haystack.includes(needle)) continue;
      /** 이미 매칭된 더 긴 이름의 부분 문자열이면 중복 판정하지 않음 (예: anchormind-api vs anchormind) */
      if (matched.some(m => m.toLowerCase().includes(needle))) continue;
      matched.push(ws);
    }

    if (matched.length === 1) {
      const ws = matched[0];
      if (!assignments.has(ws)) assignments.set(ws, []);
      assignments.get(ws).push({ id: f.id, snippet: String(f.content ?? "").slice(0, 60) });
    } else if (matched.length > 1) {
      ambiguous++;
    } else {
      unmatched++;
    }
  }

  const total = [...assignments.values()].reduce((s, a) => s + a.length, 0);
  out(`대상 ${frags.length}건 중 이관 ${total} / 모호 ${ambiguous} / 미매칭 ${unmatched}`);
  let excluded = 0;
  for (const [ws, list] of [...assignments.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const { rows: [dup] } = await pool.query(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.fragments f
        WHERE f.id = ANY($2) AND f.workspace IS NULL AND ${SAME_CONTENT_IN_TARGET}`,
      [ws, list.map(s => s.id)]
    );
    excluded += dup.n;
    out(`  ${ws}: ${list.length}건 (대상 workspace에 같은 본문이 있어 제외 ${dup.n}건)`);
    for (const s of list.slice(0, 3)) out(`    - ${s.id} :: ${s.snippet}`);
  }
  out(`같은 본문 제외 합계: ${excluded}건`);

  let updated = 0;
  if (!execute) {
    out("\ndryRun: 변경 없음. 실제 이관은 --execute.");
  } else {
    for (const [ws, list] of assignments.entries()) {
      const ids = list.map(s => s.id);
      const { rowCount } = await pool.query(
        `UPDATE ${SCHEMA}.fragments f SET workspace = $1
          WHERE f.id = ANY($2) AND f.workspace IS NULL AND NOT ${SAME_CONTENT_IN_TARGET}`,
        [ws, ids]
      );
      updated += rowCount;
    }
    out(`\nUPDATE 완료: ${updated}건`);
  }
  return { total, excluded, updated };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main()
    .then(async () => { await getPrimaryPool()?.end?.(); })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
