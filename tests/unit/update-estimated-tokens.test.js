/**
 * 본문 갱신 시 estimated_tokens를 새 본문의 토큰 수로 맞춘다
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

const { FragmentWriter } = await import("../../lib/memory/write/FragmentWriter.js");
const { countTokens }    = await import("../../lib/memory/write/FragmentFactory.js");

/** 중복 본문 조회만 받는 클라이언트 대역 */
const client = { query: async () => ({ rows: [] }) };

describe("FragmentWriter 갱신의 estimated_tokens", () => {
  it("content를 바꾸면 estimated_tokens를 새 본문의 countTokens 값으로 쓴다", async () => {
    const content = "수정된 본문은 토큰 수가 달라진다. The amended content has a different token count.";
    const diff    = await new FragmentWriter()._diffUpdatableFields(client, "frag-1", { key_id: null }, { content });

    const index = diff.setClauses.findIndex(clause => clause.startsWith("estimated_tokens = $"));
    assert.ok(index >= 0, "estimated_tokens SET 절이 없다");
    const param = Number(diff.setClauses[index].match(/\$(\d+)/)[1]);
    assert.equal(diff.params[param - 1], countTokens(content));
  });

  it("content를 바꾸지 않으면 estimated_tokens를 건드리지 않는다", async () => {
    const diff = await new FragmentWriter()._diffUpdatableFields(client, "frag-1", { key_id: null }, { topic: "t" });
    assert.ok(!diff.setClauses.some(clause => clause.startsWith("estimated_tokens")));
  });
});
