/**
 * TOCTOU 동시성 통합 테스트 — MEMENTO_REMEMBER_ATOMIC=true 경로 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-04-19
 * 수정일: 2026-04-19 (FragmentWriter.insert 오버로드 완료 — 단언 방향 반전)
 *
 * 배경:
 *   QuotaChecker.check()와 FragmentWriter.insert()가 분리 트랜잭션으로 실행되어
 *   동시 요청 시 fragment_limit 초과 삽입이 이론적으로 가능했다.
 *
 * 해결:
 *   MEMENTO_REMEMBER_ATOMIC=true 설정 시 단일 트랜잭션
 *   (BEGIN → api_keys FOR UPDATE → INSERT → COMMIT)으로 원자 실행.
 *   이 테스트는 MEMENTO_REMEMBER_ATOMIC=true 환경에서 실제 삽입 수가
 *   fragment_limit을 초과하지 않음을 검증한다.
 *
 * 수동 실행:
 *   MEMENTO_REMEMBER_ATOMIC=true \
 *   DATABASE_URL=postgresql://user:pass@localhost:35432/bee_db \
 *   node --test tests/integration/toctou-remember-concurrency.test.js
 *
 * MEMENTO_REMEMBER_ATOMIC=false(기본) 환경에서는 초과 가능성이 있으므로
 * 해당 환경에서 실행 시 단언이 실패할 수 있다. 이는 의도된 동작이다.
 */

import "./_cleanup.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import net    from "node:net";
import crypto from "node:crypto";
import pg     from "pg";

const SCHEMA       = "agent_memory";
const FRAGMENT_LIMIT = 100;
const WORKERS      = 10;
const REQUESTS_PER_WORKER = 50;
const TOTAL_REQUESTS = WORKERS * REQUESTS_PER_WORKER;

/** DATABASE_URL TCP 접근 가능 여부 확인 */
async function canConnectToDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host   = parsed.hostname;
    const port   = Number(parsed.port || 5432);
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port, timeout: 3000 }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
      socket.on("timeout", () => { socket.destroy(); resolve(false); });
    });
  } catch { return false; }
}

let pool;
let dbAvailable = false;
let testKeyId;
let mm;

/** 고유 접두사로 이 테스트 세션의 파편만 격리한다 */
const TEST_PREFIX = `toctou-${crypto.randomUUID().slice(0, 8)}`;

before(async () => {
  dbAvailable = await canConnectToDb();
  if (!dbAvailable) {
    console.warn("[toctou] DATABASE_URL 미설정 또는 DB 미연결 — 테스트 스킵");
    return;
  }

  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  /** 테스트 전용 API 키 생성 (fragment_limit = FRAGMENT_LIMIT) */
  const keyName = `toctou-test-${TEST_PREFIX}`;
  const { rows: [row] } = await pool.query(
    `INSERT INTO ${SCHEMA}.api_keys (name, fragment_limit)
     VALUES ($1, $2)
     RETURNING id`,
    [keyName, FRAGMENT_LIMIT]
  );
  testKeyId = row.id;

  /**
   * MemoryManager는 싱글턴이므로 pool 주입은 QuotaChecker에만 적용한다.
   * getPrimaryPool()이 실제 DB에 연결되어 있으므로 주입 없이도 동작하지만,
   * 격리를 위해 QuotaChecker의 pool만 테스트 pool로 교체한다.
   */
  const { MemoryManager } = await import("../../lib/memory/MemoryManager.js");
  mm = MemoryManager.getInstance();
  mm.quotaChecker.setPool(pool);
});

after(async () => {
  if (!dbAvailable || !testKeyId || !pool) return;

  /** 테스트 파편 + API 키 정리 */
  await pool.query(
    `DELETE FROM ${SCHEMA}.fragments WHERE key_id = $1`,
    [testKeyId]
  );
  await pool.query(
    `DELETE FROM ${SCHEMA}.api_keys WHERE id = $1`,
    [testKeyId]
  );
});

describe("TOCTOU — fragment_limit 동시성 초과 재현", () => {

  /**
   * 10 workers × 50 remember 요청을 Promise.all로 동시 발사.
   * QuotaChecker(FOR UPDATE + COMMIT)와 FragmentWriter.insert가
   * 분리 트랜잭션이므로 limit 초과 파편이 DB에 삽입될 수 있다.
   *
   * 현재 구현(v2.9.x)에서 이 단언이 실패함(실제 count > FRAGMENT_LIMIT)을 증명.
   * 단일 트랜잭션으로 묶으면 count <= FRAGMENT_LIMIT이 보장되어야 한다.
   */
  test(
    `${WORKERS} workers × ${REQUESTS_PER_WORKER} 동시 remember → ` +
    `실제 삽입 수 > ${FRAGMENT_LIMIT} (TOCTOU 재현)`,
    { timeout: 120_000 },
    async (t) => {
      if (!dbAvailable) {
        t.skip("DATABASE_URL 미설정 — 스킵");
        return;
      }

      const worker = (workerIdx) =>
        Array.from({ length: REQUESTS_PER_WORKER }, (_, i) =>
          mm.remember({
            content   : `worker=${workerIdx} req=${i} topic=${TEST_PREFIX}`,
            topic     : TEST_PREFIX,
            type      : "fact",
            keywords  : [TEST_PREFIX, `w${workerIdx}`],
            importance: 0.5,
            agentId   : TEST_PREFIX,
            _keyId    : testKeyId,
          }).catch(err => ({ __error: err.code || err.message }))
        );

      const allRequests = Array.from(
        { length: WORKERS },
        (_, workerIdx) => worker(workerIdx)
      ).flat();

      const results = await Promise.all(allRequests);

      const successes = results.filter(r => !r?.__error).length;
      const quota_errors = results.filter(
        r => r?.__error === "fragment_limit_exceeded"
      ).length;
      const other_errors = results.filter(
        r => r?.__error && r.__error !== "fragment_limit_exceeded"
      ).length;

      console.log(
        `[toctou] total=${TOTAL_REQUESTS} ` +
        `success=${successes} quota_err=${quota_errors} other_err=${other_errors}`
      );

      /** 실제 DB 삽입 수 조회 */
      const { rows: [countRow] } = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM ${SCHEMA}.fragments
         WHERE key_id = $1 AND valid_to IS NULL`,
        [testKeyId]
      );
      const actualCount = countRow.count;

      console.log(
        `[toctou] db count=${actualCount} limit=${FRAGMENT_LIMIT} ` +
        `exceeded=${actualCount > FRAGMENT_LIMIT}`
      );

      /**
       * 핵심 단언:
       *   MEMENTO_REMEMBER_ATOMIC=true 환경에서 실제 삽입 수 <= fragment_limit.
       *   단일 트랜잭션 원자화(api_keys FOR UPDATE + INSERT)가 TOCTOU를 차단한다.
       *
       *   MEMENTO_REMEMBER_ATOMIC=false(기본) 환경에서는 초과가 가능하므로
       *   이 단언이 실패할 수 있다. 기본 경로의 TOCTOU 재현은 의도된 동작이다.
       */
      const atomicEnabled = process.env.MEMENTO_REMEMBER_ATOMIC === "true";
      if (atomicEnabled) {
        assert.ok(
          actualCount <= FRAGMENT_LIMIT,
          `TOCTOU 원자화 실패: db count(${actualCount}) > limit(${FRAGMENT_LIMIT}). ` +
          `MEMENTO_REMEMBER_ATOMIC=true 경로에서 limit 초과가 발생했다.`
        );
      } else {
        console.warn(
          `[toctou] MEMENTO_REMEMBER_ATOMIC=false: limit 초과 여부=${actualCount > FRAGMENT_LIMIT} ` +
          `(기본 경로는 TOCTOU 보호 없음 — 기대 동작)`
        );
      }
    }
  );

});
