/**
 * TemporalLinker - 시간 기반 자동 링크 생성기
 *
 * remember() 호출 시, 동일 토픽 내 +-24h 윈도우에 있는
 * 기존 프래그먼트를 찾아 temporal 링크를 생성한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-02
 */

import { queryWithAgentVector } from "../../tools/db.js";
import { keyScopeGroup }        from "../keyScope.js";
import { SCHEMA } from "../schema.js";

const WINDOW_HOURS = 24;
const MAX_LINKS    = 5;

export class TemporalLinker {
  constructor(linkStore) {
    this.linkStore = linkStore;
  }

  /**
   * 신규 프래그먼트와 시간적으로 근접한 동일 토픽 프래그먼트를 찾아 temporal 링크 생성
   *
   * @param {Object} fragment   - 새로 저장된 프래그먼트 {id, topic, created_at, ...}
   * @param {Object} options    - {agentId, keyId, groupKeyIds}
   *   groupKeyIds: API 키 그룹 멤버 ID 배열. 제공되면 그룹 범위 내에서만 이웃 탐색.
   *   keyId 단독 제공 시 [keyId]로 wrapping하여 동일하게 처리.
   *   master key (keyId=null, groupKeyIds=null)일 때는 key_id 조건 생략.
   * @returns {Promise<Array<{toId: string, weight: number}>>}
   */
  async linkTemporalNeighbors(fragment, options = {}) {
    if (!fragment.topic) return [];

    const agentId     = options.agentId || "default";
    const keyId       = options.keyId ?? null;
    const groupKeyIds = options.groupKeyIds ?? (keyId != null ? [keyId] : null);
    const workspace   = fragment.workspace ?? null;

    const params  = [fragment.topic, fragment.id, fragment.created_at, MAX_LINKS];
    const keyFilter = keyScopeGroup(params, "key_id", groupKeyIds).trimStart();

    /** workspace가 양쪽 모두 지정되고 서로 다르면 후보에서 제외 (전역/미지정은 항상 허용) */
    let workspaceFilter = "";
    if (workspace != null) {
      params.push(workspace);
      workspaceFilter = `AND (workspace IS NULL OR workspace = $${params.length})`;
    }

    const neighbors = await queryWithAgentVector(agentId,
      `SELECT id, created_at FROM ${SCHEMA}.fragments
       WHERE topic = $1 AND id != $2
         AND created_at BETWEEN $3::timestamptz - interval '${WINDOW_HOURS} hours'
                             AND $3::timestamptz + interval '${WINDOW_HOURS} hours'
         AND valid_to IS NULL
         ${keyFilter}
         ${workspaceFilter}
       ORDER BY ABS(EXTRACT(EPOCH FROM (created_at - $3::timestamptz))) ASC
       LIMIT $4`,
      params
    );

    const links = await Promise.all(
      neighbors.rows.map(async neighbor => {
        const hoursDiff = Math.abs(
          new Date(fragment.created_at) - new Date(neighbor.created_at)
        ) / (1000 * 60 * 60);
        const weight = Math.max(0.3, 1.0 - hoursDiff / WINDOW_HOURS);

        await this.linkStore.createLink(
          fragment.id, neighbor.id, "temporal", agentId, weight
        );
        return { toId: neighbor.id, weight };
      })
    );

    return links;
  }
}
