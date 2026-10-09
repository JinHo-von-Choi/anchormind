/**
 * SegmentEmbeddingWorker: 대상 판정, 분할-임베딩-저장, 폐기, 실패 백오프, 응답 검증, 복구 스캔
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert                              from "node:assert/strict";

mock.module("../../lib/redis.js", { namedExports: { popFromQueue: async () => null, getQueueLength: async () => 0, redisClient: { status: "stub" } } });
mock.module("../../lib/logger.js", { namedExports: { logDebug: mock.fn(), logInfo: mock.fn(), logWarn: mock.fn(), logError: mock.fn() } });

const { SegmentEmbeddingWorker, isSegmentEligible, validVectors } = await import("../../lib/memory/embedding/SegmentEmbeddingWorker.js");

const CFG = { enabled: true, windowChars: 300, strideChars: 150, minChars: 400, maxSegments: 12, queueKey: "q", batchSize: 5,
              maxSegmentsPerMinute: 100000, recoveryIntervalMs: 600000, recoveryBatch: 50, recoveryWindowHours: 48, maxAttempts: 3 };
const DIMS = 4;
const longText = (n = 700) => Array.from({ length: n / 7 }, (_, i) => `단어${i}번 `).join("").slice(0, n);
const vec = () => Array.from({ length: DIMS }, () => 0.5);

/** 가짜 풀: SELECT는 행을, 트랜잭션 클라이언트는 질의를 기록한다 */
function makeDeps({ row, stale = false, embedFail = false, badVectors = false, recoverIds = [] } = {}) {
  const log = { txn: [], selects: [], embedCalls: 0, begins: 0, commits: 0, rollbacks: 0 };
  const client = {
    query: async (sql, params) => {
      log.txn.push({ sql: String(sql), params });
      if (/^BEGIN/.test(sql)) log.begins++;
      if (/^COMMIT/.test(sql)) log.commits++;
      if (/^ROLLBACK/.test(sql)) log.rollbacks++;
      if (/FOR KEY SHARE/.test(sql)) return { rowCount: stale ? 0 : 1, rows: stale ? [] : [{ id: row.id }] };
      return { rowCount: 1, rows: [] };
    },
    release: () => {}
  };
  const pool = {
    connect: async () => client,
    query: async (sql, params) => {
      log.selects.push({ sql: String(sql), params });
      if (/char_length/.test(sql)) return { rows: recoverIds.map(id => ({ id })) };
      return { rows: row ? [row] : [] };
    }
  };
  const deps = {
    pool: () => pool, cfg: CFG, dims: DIMS, now: () => 1_000_000,
    prepare: t => t, pop: async () => null,
    embed: async texts => { log.embedCalls++; if (embedFail) throw new Error("embedding down"); return badVectors ? texts.slice(1).map(vec) : texts.map(vec); }
  };
  return { deps, log };
}

describe("isSegmentEligible / validVectors", () => {
  it("minChars 이하, 만료, 비문자열은 대상이 아니다", () => {
    assert.equal(isSegmentEligible({ content: "가".repeat(400), valid_to: null }, CFG), false);
    assert.equal(isSegmentEligible({ content: "가".repeat(401), valid_to: null }, CFG), true);
    assert.equal(isSegmentEligible({ content: "가".repeat(900), valid_to: "2026-01-01" }, CFG), false);
    assert.equal(isSegmentEligible({ content: 5 }, CFG), false);
    assert.equal(isSegmentEligible(undefined, CFG), false);
  });

  it("코드 포인트 단위로 길이를 센다(이모지 401개는 대상)", () => {
    assert.equal(isSegmentEligible({ content: "😀".repeat(401), valid_to: null }, CFG), true);
    assert.equal(isSegmentEligible({ content: "😀".repeat(400), valid_to: null }, CFG), false);
  });

  it("개수, 차원, 유한값을 검증한다", () => {
    assert.equal(validVectors([vec(), vec()], 2, DIMS), true);
    assert.equal(validVectors([vec()], 2, DIMS), false);
    assert.equal(validVectors([[1, 2, 3]], 1, DIMS), false);
    assert.equal(validVectors([[1, 2, NaN, 4]], 1, DIMS), false);
    assert.equal(validVectors(null, 1, DIMS), false);
  });
});

describe("SegmentEmbeddingWorker.processFragment", () => {
  let row;
  beforeEach(() => { row = { id: "f1", content: longText(), content_hash: "h1", valid_to: null }; });

  it("분할해 임베딩하고 한 트랜잭션에서 부모를 잡고 해시를 확인한 뒤 기존 구간을 지우고 새 구간을 넣는다", async () => {
    const { deps, log } = makeDeps({ row });
    const w = new SegmentEmbeddingWorker(deps);
    assert.equal(await w.processFragment("f1"), true);
    const sqls = log.txn.map(t => t.sql.replace(/\s+/g, " "));
    assert.ok(sqls[0].startsWith("BEGIN"));
    const idxLock = sqls.findIndex(s => /FOR KEY SHARE/.test(s)), idxDel = sqls.findIndex(s => /DELETE FROM .*fragment_segment/.test(s)), idxIns = sqls.findIndex(s => /INSERT INTO .*fragment_segment/.test(s));
    assert.ok(idxLock > 0 && idxDel > idxLock && idxIns > idxDel);
    assert.equal(log.commits, 1);
    const ins = log.txn[idxIns];
    assert.equal(ins.params[0], "f1");
    assert.equal(ins.params[1], "h1");
    assert.equal(ins.params[2], w.version);
    assert.ok(w.stats.segments >= 2);
    assert.equal(w.stats.fragments, 1);
  });

  it("임베딩 호출은 트랜잭션 밖에서 한다(BEGIN 이전)", async () => {
    const { deps, log } = makeDeps({ row });
    let beginsAtEmbed = null;
    const embed = deps.embed;
    deps.embed = async t => { beginsAtEmbed = log.begins; return embed(t); };
    await new SegmentEmbeddingWorker(deps).processFragment("f1");
    assert.equal(beginsAtEmbed, 0);
  });

  it("임베딩 사이에 본문이 바뀌었으면(해시 불일치) 아무것도 쓰지 않고 폐기한다", async () => {
    const { deps, log } = makeDeps({ row, stale: true });
    const w = new SegmentEmbeddingWorker(deps);
    assert.equal(await w.processFragment("f1"), false);
    assert.equal(w.stats.stale, 1);
    assert.ok(!log.txn.some(t => /DELETE|INSERT/.test(t.sql)));
  });

  it("짧은 파편이나 없는 파편은 건너뛴다", async () => {
    const short = makeDeps({ row: { ...row, content: "짧다" } });
    assert.equal(await new SegmentEmbeddingWorker(short.deps).processFragment("f1"), false);
    assert.equal(short.log.embedCalls, 0);
    const none = makeDeps({ row: null });
    assert.equal(await new SegmentEmbeddingWorker(none.deps).processFragment("f1"), false);
  });

  it("응답 검증에 실패하면(개수 불일치) 쓰지 않고 실패로 센다", async () => {
    const { deps, log } = makeDeps({ row, badVectors: true });
    const w = new SegmentEmbeddingWorker(deps);
    assert.equal(await w.processFragment("f1"), false);
    assert.equal(w.stats.failed, 1);
    assert.equal(log.begins, 0);
  });

  it("실패하면 백오프 동안 건너뛰고 상한(3회)에서 멈춘다", async () => {
    let clock = 1_000_000;
    const { deps, log } = makeDeps({ row, embedFail: true });
    deps.now = () => clock;
    const w = new SegmentEmbeddingWorker(deps);
    await w.processFragment("f1");
    assert.equal(log.embedCalls, 1);
    await w.processFragment("f1");                    // 백오프 중
    assert.equal(log.embedCalls, 1);
    clock += 31_000; await w.processFragment("f1");   // 1회 대기 후 2번째 시도
    assert.equal(log.embedCalls, 2);
    clock += 61_000; await w.processFragment("f1");   // 3번째 시도
    assert.equal(log.embedCalls, 3);
    clock += 10 * 3600_000; await w.processFragment("f1");   // 상한 초과: 더 이상 시도하지 않는다
    assert.equal(log.embedCalls, 3);
  });

  it("성공하면 실패 기록이 지워진다", async () => {
    const { deps } = makeDeps({ row });
    const w = new SegmentEmbeddingWorker(deps);
    w.failures.set("f1", { attempts: 1, nextAt: 0 });
    await w.processFragment("f1");
    assert.equal(w.failures.has("f1"), false);
  });
});

describe("SegmentEmbeddingWorker 큐와 복구", () => {
  it("_shouldStart는 enabled가 true일 때만 참이다", () => {
    const off = new SegmentEmbeddingWorker({ ...makeDeps({}).deps, cfg: { ...CFG, enabled: false } });
    assert.equal(off._shouldStart(), false);
  });

  it("enqueue는 비활성이면 큐에 올리지 않는다", async () => {
    const pushed = [];
    const off = new SegmentEmbeddingWorker({ ...makeDeps({}).deps, cfg: { ...CFG, enabled: false } });
    assert.equal(await off.enqueue("f1", async (q, d) => pushed.push([q, d])), false);
    const on = new SegmentEmbeddingWorker(makeDeps({}).deps);
    assert.equal(await on.enqueue("f1", async (q, d) => pushed.push([q, d])), true);
    assert.deepEqual(pushed, [["q", { fragmentId: "f1" }]]);
  });

  it("큐가 비면 복구 주기가 지났을 때만 복구 스캔을 한 번 돌린다", async () => {
    const row = { id: "r1", content: longText(), content_hash: "h", valid_to: null };
    const { deps, log } = makeDeps({ row, recoverIds: ["r1"] });
    let clock = 1_000_000;
    deps.now = () => clock;
    const w = new SegmentEmbeddingWorker(deps);
    assert.equal(await w._processBatch(), 1);                       // 첫 회차: 주기 경과
    assert.equal(log.selects.filter(s => /char_length/.test(s.sql)).length, 1);
    assert.equal(await w._processBatch(), 0);                       // 직후: 주기 미경과
    assert.equal(log.selects.filter(s => /char_length/.test(s.sql)).length, 1);
  });

  it("복구 스캔은 최근 생성분만 보고 현재 해시/버전의 구간이 없는 파편을 고른다", async () => {
    const { deps, log } = makeDeps({ row: null, recoverIds: [] });
    const w = new SegmentEmbeddingWorker(deps);
    await w.recover();
    const q = log.selects.find(s => /char_length/.test(s.sql));
    assert.match(q.sql, /created_at > NOW\(\) - make_interval/);
    assert.match(q.sql, /NOT EXISTS/);
    assert.match(q.sql, /s\.source_content_hash = f\.content_hash/);
    assert.match(q.sql, /s\.seg_version = \$3/);
    assert.match(q.sql, /s\.embedding IS NOT NULL/);
    assert.equal(q.params[2], w.version);
  });
});
