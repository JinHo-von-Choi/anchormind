/**
 * MorphemeIndex NULL 캐시 치유·프로바이더 가드 회귀 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-08-12
 *
 * - embedding NULL 행을 캐시 히트로 오인하지 않고 재계산·조건부 UPDATE로 치유한다.
 * - 동시 호출이 같은 형태소를 중복 임베딩 요청하지 않는다(inFlight).
 * - 프로바이더 계층 장애 시 단건 fallback 증폭 없이 쿨다운으로 전환한다.
 */

import { describe, it, mock } from "node:test";
import assert                 from "node:assert/strict";

let batchCalls  = [];
let singleCalls = [];
let batchImpl   = async (batch) => batch.map(() => [0.1, 0.2, 0.3]);

mock.module("../../lib/tools/embedding.js", {
  namedExports: {
    EMBEDDING_ENABLED      : true,
    generateBatchEmbeddings: async (batch) => { batchCalls.push(batch); return batchImpl(batch); },
    generateEmbedding      : async (m) => { singleCalls.push(m); return [0.1, 0.2, 0.3]; },
    vectorToSql            : (v) => `[${v.join(",")}]`,
    prepareTextForEmbedding: (t) => t,
  }
});

/** 쿼리 로그를 남기는 가짜 pool. SELECT는 항상 빈 결과(유효 임베딩 없음)를 반환한다. */
function makePool() {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/^\s*SELECT/i.test(sql)) return { rows: [] };
      return { rows: [], rowCount: params?.length ?? 0 };
    }
  };
}

const poolRef = { current: makePool() };
mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => poolRef.current,
    queryWithAgentVector: async () => ({ rows: [] }),
    withTransaction: async (_p, fn) => fn(poolRef.current),
    buildSearchPath: () => "agent_memory, public",
  }
});

const { MorphemeIndex } = await import("../../lib/memory/embedding/MorphemeIndex.js");

describe("MorphemeIndex NULL 캐시 치유", () => {

  it("SELECT가 embedding IS NOT NULL 조건으로 NULL 행을 miss 취급한다", async () => {
    poolRef.current = makePool();
    batchCalls = [];
    const index = new MorphemeIndex();

    const vectors = await index.getOrRegisterEmbeddings(["널형태소"]);

    const select = poolRef.current.queries.find(q => /^\s*SELECT/i.test(q.sql));
    assert.ok(/embedding IS NOT NULL/.test(select.sql), "SELECT에 NULL 제외 조건이 없다");
    assert.equal(batchCalls.length, 1, "miss 형태소가 재계산되지 않았다");
    assert.equal(vectors.length, 1);
  });

  it("INSERT가 NULL 행 한정 조건부 UPDATE로 치유한다", async () => {
    poolRef.current = makePool();
    const index = new MorphemeIndex();

    await index.getOrRegisterEmbeddings(["치유대상"]);

    const insert = poolRef.current.queries.find(q => /INSERT INTO/i.test(q.sql));
    assert.ok(insert, "INSERT가 실행되지 않았다");
    assert.ok(/DO UPDATE SET embedding = EXCLUDED\.embedding/i.test(insert.sql),
      "조건부 UPDATE 절이 없다 (DO NOTHING이면 NULL이 영구 잔존한다)");
    assert.ok(/WHERE morpheme_dict\.embedding IS NULL/i.test(insert.sql),
      "유효 임베딩 보존 조건(WHERE ... IS NULL)이 없다");
  });

  it("동시 호출이 같은 형태소를 중복 임베딩 요청하지 않는다 (inFlight)", async () => {
    poolRef.current = makePool();
    batchCalls = [];
    batchImpl  = async (batch) => {
      await new Promise(r => setTimeout(r, 50));
      return batch.map(() => [0.1, 0.2, 0.3]);
    };
    const index = new MorphemeIndex();

    await Promise.all([
      index.getOrRegisterEmbeddings(["동시형태소"]),
      index.getOrRegisterEmbeddings(["동시형태소"]),
    ]);

    const requested = batchCalls.flat().filter(m => m === "동시형태소");
    assert.equal(requested.length, 1, `중복 임베딩 요청 발생: ${requested.length}회`);
    batchImpl = async (batch) => batch.map(() => [0.1, 0.2, 0.3]);
  });

  it("프로바이더 장애 시 단건 fallback 없이 쿨다운으로 전환하고 후속 시도를 생략한다", async () => {
    poolRef.current = makePool();
    batchCalls  = [];
    singleCalls = [];
    batchImpl   = async () => { throw new Error("429 Too Many Requests: rate limit exceeded"); };
    const index = new MorphemeIndex();

    await index.getOrRegisterEmbeddings(["장애형태소"]);

    assert.equal(singleCalls.length, 0, "프로바이더 장애가 단건 fallback으로 증폭됐다");
    assert.equal(batchCalls.length, 1);

    /** 쿨다운 활성 상태: 새 형태소도 배치 호출 자체가 생략돼야 한다 */
    await index.getOrRegisterEmbeddings(["쿨다운중형태소"]);
    assert.equal(batchCalls.length, 1, "쿨다운 중 신규 임베딩 시도가 발생했다");
  });
});
