/**
 * Memento MCP Admin Console — /stats 조회 공유
 *
 * 작성자: 최진호
 * 작성일: 2026-10-28
 *
 * 로그인 직후, 개요 화면, 상단 새로고침이 /stats를 동시에 부를 때 진행 중인 요청 하나를 같이 쓴다.
 */

import { api }   from "./api.js";
import { state } from "./state.js";

let inflight = null;

/**
 * /stats를 불러 state.stats와 state.lastUpdated를 갱신한다. 진행 중인 요청이 있으면 그 결과를 같이 받는다.
 *
 * @returns {Promise<{ ok: boolean, status: number, data: any }>}
 */
export function loadStats() {
  if (!inflight) {
    inflight = api("/stats")
      .then((res) => {
        if (res.ok) {
          state.stats       = res.data;
          state.lastUpdated = Date.now();
        }
        return res;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}
