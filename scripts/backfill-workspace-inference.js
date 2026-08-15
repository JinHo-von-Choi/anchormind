/**
 * backfill-workspace-inference.js — 전 타입 파편 workspace 비파괴 추론 백필
 *
 * 작성자: 최진호
 * 작성일: 2026-08-15
 *
 * 대상: workspace IS NULL AND valid_to IS NULL AND workspace_inferred IS NULL,
 *       단 is_anchor=true 및 type='preference' 파편은 제외한다.
 *
 * 추론 2단계(결정론적 근거만, 임베딩 유사도 단독 배정 금지):
 *   1단계 릴레이션 전이 — 동일 session_id 또는 동일 case_id 클러스터 내에서
 *     workspace가 채워진 파편들의 압도적 다수결(80% 이상)이 성립하면 그 workspace를
 *     채택한다. confidence는 다수결 비율. case_id 클러스터가 session_id 클러스터보다
 *     범위가 좁아 신뢰도가 높으므로 두 후보가 모두 성립하면 case_id를 우선한다.
 *   2단계 텍스트 매칭 — 1단계로 해소되지 않은 파편에 한해, DB에 실존하는 workspace
 *     이름이 content+keywords 결합 텍스트에서 정확히 1개만 발견될 때에만 채택한다
 *     (backfill-reflect-workspace.js의 유일 매칭 규칙 계승). confidence는 0.6 고정.
 *
 * 비파괴: workspace 컬럼은 직접 UPDATE하지 않는다. workspace_inferred,
 *   inference_confidence, backfill_batch_id 컬럼에만 기록한다(migration-041).
 *   기본은 dryRun(변경 없음). 실제 기록은 --execute 필수.
 *
 * 사용:
 *   node scripts/backfill-workspace-inference.js                          # 미리보기
 *   node scripts/backfill-workspace-inference.js --execute                # 실제 기록
 *   node scripts/backfill-workspace-inference.js --execute --batch-id=xxx # 배치 ID 지정
 */

import { getPrimaryPool } from "../lib/tools/db.js";

const SCHEMA = "agent_memory";

/** 오분류 위험이 큰 범용·플레이스홀더 명칭은 2단계 텍스트 매칭 후보에서 제외 */
const EXCLUDED_WORKSPACES = new Set([
  "default", "batch", "health", "personal", "nerdvana",
  "test-project", "other-project", "proj-a", "proj-b"
]);

/** 릴레이션 전이 다수결 채택 임계값 */
const RELATION_MAJORITY_THRESHOLD = 0.8;

/** 2단계 텍스트 매칭 고정 신뢰도 */
const TEXT_MATCH_CONFIDENCE = 0.6;

const args    = process.argv.slice(2);
const execute = args.includes("--execute");
const batchIdArg = args.find(a => a.startsWith("--batch-id="));
const batchId     = batchIdArg ? batchIdArg.slice("--batch-id=".length) : `backfill-${Date.now()}`;

/**
 * cluster_key(session_id 또는 case_id)별 workspace 다수결을 계산한다.
 *
 * @param {import('pg').Pool} pool
 * @param {"session_id"|"case_id"} column
 * @returns {Promise<Map<string, { workspace: string, ratio: number }>>}
 */
async function buildRelationMajorityMap(pool, column) {
  const { rows } = await pool.query(
    `SELECT ${column} AS cluster_key, workspace, count(*)::int AS cnt
       FROM ${SCHEMA}.fragments
      WHERE ${column} IS NOT NULL AND valid_to IS NULL AND workspace IS NOT NULL
      GROUP BY ${column}, workspace`
  );

  const byCluster = new Map();
  for (const r of rows) {
    if (!byCluster.has(r.cluster_key)) byCluster.set(r.cluster_key, []);
    byCluster.get(r.cluster_key).push({ workspace: r.workspace, cnt: r.cnt });
  }

  const majorityMap = new Map();
  for (const [clusterKey, groups] of byCluster.entries()) {
    const total = groups.reduce((s, g) => s + g.cnt, 0);
    const top    = groups.reduce((a, b) => (b.cnt > a.cnt ? b : a));
    const ratio  = top.cnt / total;
    if (ratio >= RELATION_MAJORITY_THRESHOLD) {
      majorityMap.set(clusterKey, { workspace: top.workspace, ratio });
    }
  }
  return majorityMap;
}

/**
 * content+keywords 결합 텍스트에서 실존 workspace 이름이 정확히 1개만
 * 발견되는지 판정한다. backfill-reflect-workspace.js의 유일 매칭 규칙 재사용.
 *
 * @param {{ content: string, keywords: string[] }} fragment
 * @param {string[]} candidates - 긴 이름 우선 정렬된 실존 workspace 후보 목록
 * @returns {string|null}
 */
function matchUniqueWorkspaceByText(fragment, candidates) {
  const haystack = (String(fragment.content ?? "") + " " + (fragment.keywords ?? []).join(" ")).toLowerCase();
  const matched  = [];

  for (const ws of candidates) {
    const needle = ws.toLowerCase();
    if (!haystack.includes(needle)) continue;
    /** 이미 매칭된 더 긴 이름의 부분 문자열이면 중복 판정하지 않음 (예: anchormind-api vs anchormind) */
    if (matched.some(m => m.toLowerCase().includes(needle))) continue;
    matched.push(ws);
  }

  return matched.length === 1 ? matched[0] : null;
}

async function main() {
  const pool = getPrimaryPool();
  if (!pool) {
    console.error("DB pool unavailable");
    process.exit(1);
  }

  const [caseMajorityMap, sessionMajorityMap] = await Promise.all([
    buildRelationMajorityMap(pool, "case_id"),
    buildRelationMajorityMap(pool, "session_id")
  ]);

  const { rows: wsRows } = await pool.query(
    `SELECT workspace, count(*)::int AS cnt
       FROM ${SCHEMA}.fragments
      WHERE workspace IS NOT NULL
      GROUP BY workspace`
  );
  const textCandidates = wsRows
    .map(r => r.workspace)
    .filter(w => !EXCLUDED_WORKSPACES.has(w))
    .sort((a, b) => b.length - a.length);   /** 긴 이름 우선 — 부분 문자열 중복 판정용 */

  const { rows: targets } = await pool.query(
    `SELECT id, session_id, case_id, content, keywords
       FROM ${SCHEMA}.fragments
      WHERE workspace IS NULL
        AND valid_to IS NULL
        AND workspace_inferred IS NULL
        AND is_anchor IS NOT TRUE
        AND (type IS NULL OR type <> 'preference')`
  );

  /** workspace -> [{ id, stage, confidence, snippet }] */
  const assignments = new Map();
  let relationCount  = 0;
  let textCount      = 0;
  let unresolved     = 0;

  for (const f of targets) {
    let decision = null;

    const caseHit    = f.case_id    ? caseMajorityMap.get(f.case_id)       : null;
    const sessionHit  = f.session_id ? sessionMajorityMap.get(f.session_id) : null;

    /** case_id 클러스터가 session_id 클러스터보다 범위가 좁아 우선 채택 */
    const relationHit = caseHit || sessionHit;
    if (relationHit) {
      decision = { workspace: relationHit.workspace, stage: "relation", confidence: relationHit.ratio };
      relationCount++;
    } else {
      const textHit = matchUniqueWorkspaceByText(f, textCandidates);
      if (textHit) {
        decision = { workspace: textHit, stage: "text", confidence: TEXT_MATCH_CONFIDENCE };
        textCount++;
      }
    }

    if (!decision) {
      unresolved++;
      continue;
    }

    if (!assignments.has(decision.workspace)) assignments.set(decision.workspace, []);
    assignments.get(decision.workspace).push({
      id        : f.id,
      stage     : decision.stage,
      confidence: decision.confidence,
      snippet   : String(f.content ?? "").slice(0, 60)
    });
  }

  const total = [...assignments.values()].reduce((s, a) => s + a.length, 0);
  console.log(`배치 ${batchId}`);
  console.log(`대상 ${targets.length}건 중 추론 ${total}건 (릴레이션 ${relationCount} / 텍스트 ${textCount}) / 미해소 ${unresolved}건`);
  for (const [ws, list] of [...assignments.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${ws}: ${list.length}건`);
    for (const s of list.slice(0, 3)) {
      console.log(`    - ${s.id} :: [${s.stage}, confidence=${s.confidence.toFixed(2)}] ${s.snippet}`);
    }
  }

  if (!execute) {
    console.log("\ndryRun — 변경 없음. 실제 기록은 --execute.");
  } else {
    let written = 0;
    for (const [ws, list] of assignments.entries()) {
      for (const item of list) {
        const { rowCount } = await pool.query(
          `UPDATE ${SCHEMA}.fragments
              SET workspace_inferred   = $1,
                  inference_confidence = $2,
                  backfill_batch_id    = $3
            WHERE id = $4 AND workspace IS NULL AND workspace_inferred IS NULL`,
          [ws, item.confidence, batchId, item.id]
        );
        written += rowCount;
      }
    }
    console.log(`\n기록 완료: ${written}건 (workspace_inferred, batch_id=${batchId})`);
  }

  await pool.end?.();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
