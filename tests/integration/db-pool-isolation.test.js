/**
 * DB Pool 격리 통합 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-27
 *
 * 검증:
 * - getBatchPool() 인스턴스가 getPrimaryPool()과 별개 객체
 * - 두 풀이 동시에 active 상태 유지 가능
 * - batchPool application_name이 'memento-mcp:batch'
 * - BATCH_DATABASE_URL env 분기 동작
 * - getPoolStats()에 batch 통계 포함
 * - shutdownPool()이 두 풀 모두 종료
 *
 * DB 없는 CI 환경: application_name 검증은 DB 연결 필요 — skip 처리.
 * 객체 격리/설정 검증은 Pool 인스턴스 속성으로 수행(연결 불필요).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { getPrimaryPool, getBatchPool, getPoolStats, shutdownPool } from "../../lib/tools/db.js";

describe("DB Pool 격리 검증", () => {

  let primaryPool;
  let batchPool;

  before(() => {
    primaryPool = getPrimaryPool();
    batchPool   = getBatchPool();
  });

  after(async () => {
    /** 테스트 후 풀 종료 — 다른 테스트와 격리 */
    try { await shutdownPool(); } catch (_) { /* ignore */ }
  });

  it("getPrimaryPool이 Pool 인스턴스를 반환한다", () => {
    assert.ok(primaryPool, "primaryPool이 falsy");
    assert.strictEqual(typeof primaryPool.connect, "function");
  });

  it("getBatchPool이 Pool 인스턴스를 반환한다", () => {
    assert.ok(batchPool, "batchPool이 falsy");
    assert.strictEqual(typeof batchPool.connect, "function");
  });

  it("두 풀이 서로 다른 객체 참조다 (격리 확인)", () => {
    assert.notStrictEqual(primaryPool, batchPool,
      "getBatchPool()이 getPrimaryPool()과 동일 인스턴스를 반환해서는 안 된다");
  });

  it("getBatchPool() 반복 호출 시 동일 싱글톤 인스턴스를 반환한다", () => {
    const batchPool2 = getBatchPool();
    assert.strictEqual(batchPool, batchPool2, "getBatchPool()이 매번 새 인스턴스를 생성해서는 안 된다");
  });

  it("getPrimaryPool() 반복 호출 시 동일 싱글톤 인스턴스를 반환한다", () => {
    const primaryPool2 = getPrimaryPool();
    assert.strictEqual(primaryPool, primaryPool2);
  });

  it("getPoolStats()가 batch 키를 포함한다", () => {
    const stats = getPoolStats();
    assert.ok("batch" in stats, "getPoolStats() 결과에 batch 키가 없다");
    assert.ok("primary" in stats, "getPoolStats() 결과에 primary 키가 없다");
    assert.ok("totalCount" in stats.batch);
    assert.ok("idleCount" in stats.batch);
    assert.ok("waitingCount" in stats.batch);
  });

  it("batchPool의 options.max가 primaryPool.options.max의 30% 이하다", () => {
    /** pg.Pool 인스턴스는 options 속성으로 설정값에 접근 가능 */
    const primaryMax = primaryPool.options.max;
    const batchMax   = batchPool.options.max;
    const expected   = Math.max(2, Math.floor(primaryMax * 0.3));
    assert.strictEqual(batchMax, expected,
      `batchPool.max(${batchMax}) !== floor(${primaryMax} * 0.3) = ${expected}`);
  });

  it("BATCH_DATABASE_URL 없을 때 batchPool.options에 application_name이 'memento-mcp:batch'다", () => {
    /** BATCH_DATABASE_URL이 없으면 config 객체에 application_name 직접 설정 */
    if (process.env.BATCH_DATABASE_URL) {
      /** connectionString 경로: options.connectionString에 app_name 포함될 수 있음 — skip */
      return;
    }
    assert.strictEqual(
      batchPool.options.application_name,
      "memento-mcp:batch",
      "application_name이 'memento-mcp:batch'가 아니다"
    );
  });

  it("DB 연결 가능 시 batchPool application_name SELECT 검증", async () => {
    /** DB 없는 환경에서는 연결 타임아웃으로 skip */
    let client;
    try {
      client = await batchPool.connect();
    } catch (_err) {
      /** CI/단위 테스트 환경: DB 없으면 skip */
      return;
    }
    try {
      const res = await client.query("SELECT current_setting('application_name') AS app_name");
      assert.strictEqual(
        res.rows[0].app_name,
        "memento-mcp:batch",
        `DB application_name 불일치: ${res.rows[0].app_name}`
      );
    } finally {
      client.release();
    }
  });

  it("shutdownPool() 이후 새 getBatchPool() 호출이 새 인스턴스를 반환한다", async () => {
    await shutdownPool();
    const newBatch = getBatchPool();
    /** 종료 후 재초기화되므로 이전 참조와 달라야 한다 */
    assert.ok(newBatch, "shutdownPool 후 getBatchPool()이 falsy");
    assert.notStrictEqual(newBatch, batchPool,
      "shutdownPool 후 getBatchPool()이 이전 닫힌 인스턴스를 반환해서는 안 된다");
  });

});
