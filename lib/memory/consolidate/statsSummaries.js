/**
 * 저장 통계(memory_stats)의 workspace, 키, 세션 분포 요약
 *
 * 작성자: 최진호
 * 작성일: 2026-10-20
 *
 * MemoryConsolidator.getStats()가 집계 쿼리 결과를 응답 모양으로 바꿀 때 쓰는 순수 변환 함수다.
 * DB 의존이 없어 단위 시험에서 직접 검증한다.
 */

const WORKSPACE_DISTRIBUTION_TOP_N = 20;

/**
 * workspace별 파편 수 분포를 상위 N개 + NULL 건수 형태로 요약한다. 행에 앵커 수(anchors)와 앵커 본문
 * 토큰 합(anchor_tokens)이 있으면 workspace마다 함께 싣는다.
 * DB 의존이 없는 순수 변환 함수라 단위 테스트에서 직접 검증 가능하다.
 *
 * @param {Array<{workspace: string|null, cnt: number|string, anchors?: number|string, anchor_tokens?: number|string}>} rows
 * @returns {{top: Array<{workspace: string, count: number, anchors?: number, anchor_tokens?: number}>,
 *            null_count: number, null_anchors?: number, null_anchor_tokens?: number, distinct_count: number}}
 */
export function summarizeWorkspaceDistribution(rows) {
  let nullCount = 0;
  let nullAnchors = 0;
  let nullAnchorTokens = 0;
  let withAnchors = false;
  const named   = [];

  for (const row of rows) {
    const count = parseInt(row.cnt, 10) || 0;
    const anchorFields = row.anchors === undefined ? {} : {
      anchors      : parseInt(row.anchors, 10) || 0,
      anchor_tokens: parseInt(row.anchor_tokens, 10) || 0
    };
    if (row.anchors !== undefined) withAnchors = true;
    if (row.workspace === null || row.workspace === undefined) {
      nullCount += count;
      nullAnchors += anchorFields.anchors ?? 0;
      nullAnchorTokens += anchorFields.anchor_tokens ?? 0;
    } else {
      named.push({ workspace: row.workspace, count, ...anchorFields });
    }
  }

  named.sort((a, b) => b.count - a.count);

  return {
    top           : named.slice(0, WORKSPACE_DISTRIBUTION_TOP_N),
    null_count    : nullCount,
    ...(withAnchors ? { null_anchors: nullAnchors, null_anchor_tokens: nullAnchorTokens } : {}),
    distinct_count: named.length
  };
}

/**
 * 키(key_id)별 workspace 기입률(workspace IS NOT NULL 비율)을 계산한다.
 *
 * @param {Array<{key_id: string|null, key_name: string|null, total: number|string, with_workspace: number|string}>} rows
 * @returns {Array<{key_id: string|null, key_name: string|null, total: number, with_workspace: number, fill_rate: number}>}
 */
export function summarizeKeyWorkspaceFillRate(rows) {
  return rows.map(row => {
    const total         = parseInt(row.total, 10) || 0;
    const withWorkspace = parseInt(row.with_workspace, 10) || 0;
    return {
      key_id        : row.key_id ?? null,
      key_name      : row.key_name ?? null,
      total,
      with_workspace: withWorkspace,
      fill_rate     : total > 0 ? parseFloat((withWorkspace / total).toFixed(3)) : 0
    };
  });
}

/**
 * 최근 30일 세션당 파편 수의 p50/p90/max 분포를 계산한다.
 * nearest-rank 방식(오름차순 정렬 후 ceil(p * n) - 1 인덱스)을 사용한다.
 *
 * @param {number[]} counts - 세션별 파편 수 배열
 * @returns {{p50: number|null, p90: number|null, max: number|null, sample_sessions: number}}
 */
export function summarizeSessionFragmentDistribution(counts) {
  const n = counts.length;
  if (n === 0) {
    return { p50: null, p90: null, max: null, sample_sessions: 0 };
  }

  const sorted = [...counts].sort((a, b) => a - b);
  const pick   = p => sorted[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];

  return {
    p50            : pick(0.5),
    p90            : pick(0.9),
    max            : sorted[n - 1],
    sample_sessions: n
  };
}
