/**
 * SqliteVecStore — SQLite + sqlite-vec 스토리지 어댑터 (stub)
 *
 * 작성자: 최진호
 * 작성일: 2026-05-13
 *
 * v4.1에서 본격 구현 예정. 현재는 모든 메서드가 미구현 에러를 던진다.
 * sqlite-vec npm 의존성은 v4.1 이전까지 추가하지 않는다.
 *
 * 구현 시 유의: SQLite는 배열 타입이 없으므로 fragments.keywords와 동일하게
 * api_keys.allowed_workspaces(TEXT[])도 JSON 문자열로 직렬화해 저장하고
 * 조회 시 역직렬화한다. fragments.workspace_source, quality_rationale,
 * workspace_inferred, backfill_batch_id는 TEXT, inference_confidence는
 * REAL로 스칼라 바인딩하면 되므로 별도 변환이 필요 없다.
 *
 * engine        = 'sqlite-vec'
 * vectorSupport = 'extension'
 */

/**
 * @implements {StorageAdapter}
 */
export class SqliteVecStore {
  /** @readonly */
  engine = "sqlite-vec";

  /** @readonly */
  vectorSupport = "extension";

  /**
   * 단순 SQL 쿼리 실행.
   *
   * @param {string} _sql
   * @param {Array}  [_params=[]]
   * @returns {Promise<{rows: Array, rowCount: number}>}
   */
  async query(_sql, _params = []) {
    throw new Error("SqliteVecStore not implemented yet (v4.1)");
  }

  /**
   * 에이전트 컨텍스트 쿼리.
   *
   * @param {string} _agentId
   * @param {string} _sql
   * @param {Array}  [_params=[]]
   * @returns {Promise<{rows: Array, rowCount: number}>}
   */
  async queryAsAgent(_agentId, _sql, _params = []) {
    throw new Error("SqliteVecStore not implemented yet (v4.1)");
  }

  /**
   * 트랜잭션 실행.
   *
   * @param {function} _fn
   * @returns {Promise<any>}
   */
  async transaction(_fn) {
    throw new Error("SqliteVecStore not implemented yet (v4.1)");
  }

  /**
   * 마이그레이션 파일 적용.
   *
   * @param {string} _filePath
   * @param {object} _opsClass
   * @returns {Promise<number>}
   */
  async migrate(_filePath, _opsClass) {
    throw new Error("SqliteVecStore not implemented yet (v4.1)");
  }

  /**
   * 연결 종료.
   *
   * @returns {Promise<void>}
   */
  async close() {
    throw new Error("SqliteVecStore not implemented yet (v4.1)");
  }
}
