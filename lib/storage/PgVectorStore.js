/**
 * PgVectorStore — PostgreSQL + pgvector 스토리지 어댑터
 *
 * 작성자: 최진호
 * 작성일: 2026-05-13
 *
 * lib/tools/db.js의 getPrimaryPool() 및 queryWithAgentVector()를
 * StorageAdapter 인터페이스에 맞게 위임 호출하는 래퍼 클래스.
 *
 * query()/queryAsAgent()는 SQL 문자열과 파라미터 배열을 그대로 전달하는
 * 범용 통로다. fragments.workspace_source, quality_rationale,
 * workspace_inferred, inference_confidence, backfill_batch_id와
 * api_keys.allowed_workspaces(TEXT[])는 호출자가 구성한 SQL/파라미터를
 * node-pg가 컬럼 타입에 맞춰 직접 바인딩하므로 이 어댑터에 별도 매핑이
 * 필요하지 않다. TEXT[]는 JS 배열을 그대로 파라미터로 전달하면 된다.
 *
 * engine     = 'pgvector'
 * vectorSupport = 'native'
 */

import { getPrimaryPool, queryWithAgentVector } from "../tools/db.js";

/**
 * @implements {StorageAdapter}
 */
export class PgVectorStore {
  /** @readonly */
  engine = "pgvector";

  /** @readonly */
  vectorSupport = "native";

  /**
   * 단순 SQL 쿼리 실행.
   * Primary 풀에서 클라이언트를 획득하여 실행 후 반환.
   *
   * @param {string}  sql    - 실행할 SQL 문자열
   * @param {Array}   [params=[]] - 바인딩 파라미터
   * @returns {Promise<{rows: Array, rowCount: number}>}
   */
  async query(sql, params = []) {
    const pool   = getPrimaryPool();
    const result = await pool.query(sql, params);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  }

  /**
   * 에이전트 컨텍스트 + pgvector 타입 지원 쿼리.
   * SET LOCAL app.current_agent_id 및 hnsw.ef_search 설정 포함.
   *
   * @param {string}  agentId - 에이전트 식별자
   * @param {string}  sql     - 실행할 SQL 문자열
   * @param {Array}   [params=[]] - 바인딩 파라미터
   * @returns {Promise<{rows: Array, rowCount: number}>}
   */
  async queryAsAgent(agentId, sql, params = []) {
    const result = await queryWithAgentVector(agentId, sql, params);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  }

  /**
   * 트랜잭션 실행.
   * Primary 풀에서 클라이언트를 획득하여 BEGIN/COMMIT/ROLLBACK을 관리하고
   * fn(client)의 반환값을 그대로 반환.
   *
   * @param {function(import('pg').PoolClient): Promise<any>} fn
   * @returns {Promise<any>}
   */
  async transaction(fn) {
    const pool   = getPrimaryPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 마이그레이션 파일을 읽어 적용.
   * filePath의 SQL 파일을 읽고 opsClass의 apply(sql) 메서드를 호출.
   * 현재 구현은 단순 위임이며 실제 파싱·체크섬 관리는 opsClass에 위임.
   *
   * @param {string} filePath  - SQL 마이그레이션 파일 경로
   * @param {object} opsClass  - { apply(sql): Promise<number> } 인터페이스를 가진 객체
   * @returns {Promise<number>} - 적용된 구문 수
   */
  async migrate(filePath, opsClass) {
    const { readFile } = await import("node:fs/promises");
    const sql          = await readFile(filePath, "utf8");
    return opsClass.apply(sql);
  }

  /**
   * Primary 풀 연결 종료.
   * 어댑터를 통해 getPrimaryPool()이 반환한 풀의 end()를 호출.
   * shutdownPool()이 별도로 존재하므로, 어댑터 레벨에서는 풀만 종료.
   *
   * @returns {Promise<void>}
   */
  async close() {
    const pool = getPrimaryPool();
    await pool.end();
  }
}
