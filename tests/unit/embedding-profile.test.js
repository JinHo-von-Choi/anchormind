/**
 * 임베딩 프로파일 확인 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-20
 *
 * 저장된 프로파일이 없으면 기록하고, 제공자나 모델이 바뀌면 경고만 하며 기동을 막지 않는지 대역 풀로 확인한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

const { compareEmbeddingProfile, checkEmbeddingProfile, currentEmbeddingProfile } =
  await import("../../scripts/check-embedding-consistency.js");

function poolWith(row, { missing = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (missing) { const e = new Error("relation does not exist"); e.code = "42P01"; throw e; }
      if (sql.includes("SELECT provider")) return { rows: row ? [row] : [] };
      return { rows: [], rowCount: 1 };
    }
  };
}

describe("embedding profile", () => {
  const cur = { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 };

  it("compareEmbeddingProfile: 없음은 record, 같으면 same, 모델이 다르면 model_changed", () => {
    assert.equal(compareEmbeddingProfile(null, cur), "record");
    assert.equal(compareEmbeddingProfile({ ...cur }, cur), "same");
    assert.equal(compareEmbeddingProfile({ ...cur, model: "other" }, cur), "model_changed");
    assert.equal(compareEmbeddingProfile({ ...cur, provider: "gemini" }, cur), "model_changed");
  });

  it("행이 없으면 현재 설정으로 채운다", async () => {
    const pool = poolWith(null);
    assert.equal(await checkEmbeddingProfile(pool), "record");
    const insert = pool.calls.find(c => c.sql.includes("INSERT INTO"));
    const now    = currentEmbeddingProfile();
    assert.deepEqual(insert.params, [now.provider, now.model, now.dimensions]);
  });

  it("모델이 바뀌면 덮어쓰지 않고 경고만 한다", async () => {
    const pool = poolWith({ provider: "x", model: "y", dimensions: 1 });
    assert.equal(await checkEmbeddingProfile(pool), "model_changed");
    assert.equal(pool.calls.some(c => c.sql.includes("INSERT INTO")), false);
  });

  it("record=true는 현재 설정으로 덮어쓴다", async () => {
    const pool = poolWith({ provider: "x", model: "y", dimensions: 1 });
    assert.equal(await checkEmbeddingProfile(pool, { record: true }), "record");
    assert.ok(pool.calls.some(c => c.sql.includes("ON CONFLICT (id) DO UPDATE")));
  });

  it("표가 없으면(마이그레이션 전) 건너뛴다", async () => {
    assert.equal(await checkEmbeddingProfile(poolWith(null, { missing: true })), "skipped");
  });
});
