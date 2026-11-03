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
import { autoLinkOwnerKeys }    from "../groupGrants.js";
import { SCHEMA } from "../schema.js";
import { backgroundTaskDuration } from "../background-metrics.js";

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
   * @param {Object} options    - {agentId, keyId, groupGrants}
   *   이웃은 자기 키와 groupGrants.link의 멤버 키 파편에서 고른다.
   *   master key (keyId=null)는 마스터 파편(key_id NULL)끼리만 잇는다.
   * @returns {Promise<Array<{toId: string, weight: number}>>}
   */
  async linkTemporalNeighbors(fragment, options = {}) {
    if (!fragment.topic) return [];
    const end = backgroundTaskDuration.startTimer({ task: "temporal_linker" });
    try {
      return await this.#linkNeighbors(fragment, options);
    } finally {
      end();
    }
  }

  /**
   * @param {Object} fragment
   * @param {Object} options
   * @returns {Promise<Array<{toId: string, weight: number}>>}
   */
  async #linkNeighbors(fragment, options) {

    const agentId     = options.agentId || "default";
    const keyId       = options.keyId ?? null;
    const workspace   = fragment.workspace ?? null;

    /**
     * 이웃은 자기 키와 link 권한을 받은 멤버 키의 파편에서만 고른다. 마스터는 마스터 파편끼리만 잇는다.
     * 읽을 수 있다고 링크까지 걸면 link 권한 없이 다른 멤버의 그래프를 바꾸게 된다.
     */
    const params  = [fragment.topic, fragment.id, fragment.created_at, MAX_LINKS];
    const owners  = autoLinkOwnerKeys(keyId, options.groupGrants);
    const keyFilter = owners === null ? "AND key_id IS NULL" : keyScopeGroup(params, "key_id", owners).trimStart();

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

    const links = neighbors.rows.map(neighbor => {
      const hoursDiff = Math.abs(
        new Date(fragment.created_at) - new Date(neighbor.created_at)
      ) / (1000 * 60 * 60);
      return { toId: neighbor.id, weight: Math.max(0.3, 1.0 - hoursDiff / WINDOW_HOURS) };
    });

    /** 같은 새 파편의 링크를 한 트랜잭션에서 쓴다. 따로 띄우면 같은 파편 잠금을 두고 서로 기다린다. */
    await this.linkStore.createLinks(
      links.map(({ toId, weight }) => ({ fromId: fragment.id, toId, relationType: "temporal", weight })),
      agentId,
      { producer: "temporal", lockTimeoutMs: 0 }
    );
    return links;
  }
}
