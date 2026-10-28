/**
 * 관리 화면의 파편 상태 집계
 *
 * 작성자: 최진호
 * 작성일: 2026-10-28
 *
 * /stats와 /memory/anomalies가 쓰는 파편 개수를 한 문장으로 센다. 개수마다 따로 세면 조회마다
 * 파편 테이블 전체를 다시 읽고, 숫자마다 집계 시점도 달라진다.
 */

import { SCHEMA }       from "../memory/schema.js";
import { NOT_WM_ROW }   from "../memory/WorkingMemorySql.js";
import { scopedQuery, WORKSPACE_COLUMN } from "./ScopeFilter.js";

/** 마지막 접근이 이 일수보다 오래된 파편을 오래된 파편으로 센다 */
export const STALE_ACCESS_DAYS = 30;

/** 검색 실패(결과 0건) 집계 기간(일) */
export const FAILED_SEARCH_DAYS = 7;

/**
 * 미해결 모순 조건: 같은 키의 contradicts 링크 중 해소 기록이 없고 두 파편이 모두 유효하다.
 * 별칭 link(fragment_links), left_fragment, right_fragment(fragments), resolution(conflict_resolutions)을 쓴다.
 */
export const OPEN_CONFLICT_WHERE = `link.relation_type = 'contradicts'
          AND COALESCE(left_fragment.key_id, '') = COALESCE(right_fragment.key_id, '')
          AND resolution.id IS NULL
          AND left_fragment.valid_to IS NULL AND right_fragment.valid_to IS NULL`;

/**
 * 범위 안 파편의 상태별 개수.
 *
 * - total: 작업 기억 대체 행을 뺀 전체
 * - live: 유효 기간이 끝나지 않은 파편
 * - verified: live 중 품질 검증을 통과한 파편
 * - embeddingBacklog: live 중 임베딩이 아직 없는 파편
 * - qualityPending: 작업 기억 대체 행을 뺀 파편 중 품질 판정 전인 파편
 * - stale: 작업 기억 대체 행을 뺀 파편 중 STALE_ACCESS_DAYS일 넘게 접근이 없는 파편
 *
 * @param {{ query: Function }} pool
 * @param {{ all: boolean, workspaces?: string[] }|null} range 관리 요청 범위
 * @returns {Promise<{ total: number, live: number, verified: number, embeddingBacklog: number, qualityPending: number, stale: number }>}
 */
export async function countFragmentHealth(pool, range) {
  const { rows: [row] } = await pool.query(...scopedQuery(WORKSPACE_COLUMN, range, (ws) => `
    SELECT COUNT(*) FILTER (WHERE ${NOT_WM_ROW})::int                                            AS total,
           COUNT(*) FILTER (WHERE valid_to IS NULL)::int                                         AS live,
           COUNT(*) FILTER (WHERE valid_to IS NULL AND quality_verified)::int                    AS verified,
           COUNT(*) FILTER (WHERE valid_to IS NULL AND embedding IS NULL)::int                   AS embedding_backlog,
           COUNT(*) FILTER (WHERE quality_verified IS NULL AND ${NOT_WM_ROW})::int               AS quality_pending,
           COUNT(*) FILTER (WHERE accessed_at < NOW() - INTERVAL '${STALE_ACCESS_DAYS} days'
                              AND ${NOT_WM_ROW})::int                                            AS stale
      FROM ${SCHEMA}.fragments
     WHERE ${ws}`));
  return {
    total           : row?.total ?? 0,
    live            : row?.live ?? 0,
    verified        : row?.verified ?? 0,
    embeddingBacklog: row?.embedding_backlog ?? 0,
    qualityPending  : row?.quality_pending ?? 0,
    stale           : row?.stale ?? 0
  };
}

/**
 * 범위 안 미해결 모순 수. 범위는 왼쪽 파편의 workspace로 본다(/memory/conflicts 목록과 같다).
 *
 * @param {{ query: Function }} pool
 * @param {{ all: boolean, workspaces?: string[] }|null} range 관리 요청 범위
 * @returns {Promise<number>}
 */
export async function countOpenConflicts(pool, range) {
  const { rows: [row] } = await pool.query(...scopedQuery("left_fragment.workspace", range, (ws) => `
    SELECT COUNT(*)::int AS count
      FROM ${SCHEMA}.fragment_links link
      JOIN ${SCHEMA}.fragments left_fragment ON left_fragment.id = link.from_id
      JOIN ${SCHEMA}.fragments right_fragment ON right_fragment.id = link.to_id
 LEFT JOIN ${SCHEMA}.conflict_resolutions resolution ON resolution.link_id = link.id
     WHERE ${OPEN_CONFLICT_WHERE} AND ${ws}`));
  return row?.count ?? 0;
}
