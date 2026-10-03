/**
 * FragmentWriter.updateInternal 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 내부 메타데이터 갱신은 의미 열을 쓰지 못한다. DB 호출은 대역으로 받아 SQL과 바인딩을 본다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert                             from "node:assert/strict";

const calls = [];
mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool      : () => null,
    queryWithAgentVector: async (agentId, sql, params) => {
      calls.push({ agentId, sql, params });
      return { rowCount: 1, rows: [] };
    }
  }
});

const {
  FragmentWriter,
  InternalUpdateError,
  SEMANTIC_COLUMNS,
  INTERNAL_COLUMNS
} = await import("../../lib/memory/write/FragmentWriter.js");

beforeEach(() => { calls.length = 0; });

describe("FragmentWriter.updateInternal", () => {
  const writer = new FragmentWriter();

  it("의미 열 9개를 정해진 대로 막는다", () => {
    assert.deepEqual([...SEMANTIC_COLUMNS].sort(), [
      "content", "context_summary", "goal", "is_anchor", "key_id", "keywords", "outcome", "topic", "workspace"
    ]);
    assert.equal(INTERNAL_COLUMNS.some(c => SEMANTIC_COLUMNS.includes(c)), false);
  });

  for (const column of ["content", "topic", "keywords", "is_anchor", "workspace", "key_id", "context_summary", "goal", "outcome"]) {
    it(`${column} 갱신을 InternalUpdateError로 거부하고 DB를 부르지 않는다`, async () => {
      await assert.rejects(
        () => writer.updateInternal("f1", { importance: 0.4, [column]: "x" }),
        (err) => err instanceof InternalUpdateError && err.columns.includes(column)
      );
      assert.equal(calls.length, 0);
    });
  }

  it("허용 목록 밖의 열도 거부한다", async () => {
    await assert.rejects(
      () => writer.updateInternal("f1", { "importance = 1, content": "x" }),
      (err) => err instanceof InternalUpdateError
    );
    assert.equal(calls.length, 0);
  });

  it("마스터 범위는 system 문맥으로 id만 조건에 둔다", async () => {
    const ok = await writer.updateInternal("f1", { importance: 0.4, ttl_tier: "cold" });
    assert.equal(ok, true);
    assert.equal(calls[0].agentId, "system");
    assert.match(calls[0].sql, /SET importance = \$2, ttl_tier = \$3 WHERE id = \$1$/);
    assert.deepEqual(calls[0].params, ["f1", 0.4, "cold"]);
  });

  it("키 범위는 소유 파편만 갱신한다", async () => {
    await writer.updateInternal("f1", { assertion_status: "verified" }, { keyId: "key-1" });
    assert.equal(calls[0].agentId, "default");
    assert.match(calls[0].sql, /WHERE id = \$1 AND key_id = \$3$/);
    assert.deepEqual(calls[0].params, ["f1", "verified", "key-1"]);
  });

  it("바꿀 열이 없으면 DB를 부르지 않는다", async () => {
    assert.equal(await writer.updateInternal("f1", {}), false);
    assert.equal(calls.length, 0);
  });

  it("updateTtlTier와 patchAssertion은 updateInternal로 기록한다", async () => {
    await writer.updateTtlTier("f1", "short", "key-1");
    await writer.patchAssertion("f2", "rejected");
    assert.deepEqual(calls[0].params, ["f1", "short", "key-1"]);
    assert.match(calls[0].sql, /SET ttl_tier = \$2 WHERE id = \$1 AND key_id = \$3$/);
    assert.deepEqual(calls[1].params, ["f2", "rejected"]);
    assert.equal(calls[1].agentId, "system");
  });
});
