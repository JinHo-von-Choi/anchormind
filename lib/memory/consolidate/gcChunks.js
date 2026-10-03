/**
 * GC 청크 반복
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 만료 삭제를 chunk건씩 반복한다. 한 주기의 삭제 수가 cap에 닿거나, 시간 예산이 지나거나, 청크가
 * 요청보다 적게 지우거나(후보 소진), 청크가 실패하면 멈춘다. 시간은 청크 사이에서만 확인하므로
 * 한 청크는 항상 끝까지 실행된다. 이 모듈은 DB를 모르고 삭제 함수와 시계를 주입받는다.
 */

/**
 * @typedef {Object} GcChunkResult
 * @property {number} deleted 지운 행 수
 * @property {"cap"|"budget"|"exhausted"|"error"} stopped 멈춘 이유
 * @property {Error} [error] stopped가 error일 때 청크가 던진 오류
 */

/**
 * @param {Object}   opts
 * @param {number}   opts.cap         한 주기에 지울 수 있는 최대 행 수
 * @param {number}   opts.chunk       청크 하나의 최대 행 수
 * @param {number}   opts.budgetMs    청크를 시작할 수 있는 시간 상한(ms)
 * @param {() => number} [opts.now]   밀리초 시계
 * @param {(limit: number) => Promise<number>} opts.deleteChunk limit건까지 지우고 지운 수를 돌려준다
 * @returns {Promise<GcChunkResult>}
 */
export async function runGcChunks({ cap, chunk, budgetMs, now = Date.now, deleteChunk }) {
  const startedAt = now();
  let deleted     = 0;
  while (true) {
    if (deleted >= cap) return { deleted, stopped: "cap" };
    if (deleted > 0 && now() - startedAt >= budgetMs) return { deleted, stopped: "budget" };
    const limit = Math.min(chunk, cap - deleted);
    let removed;
    try {
      removed = await deleteChunk(limit);
    } catch (error) {
      return { deleted, stopped: "error", error };
    }
    deleted += removed;
    if (removed < limit) return { deleted, stopped: "exhausted" };
  }
}
