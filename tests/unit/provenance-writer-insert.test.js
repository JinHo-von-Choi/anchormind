/**
 * FragmentWriter 기록 문장의 출처 열 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 관문이 출처 값을 실은 파편은 INSERT 문장 끝에 origin, observed_client, trust_tier 열과 값이 붙고,
 * 출처 값이 없는 파편은 열과 값의 수가 그대로인지 DB 대역 위에서 본다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert                             from "node:assert/strict";

const statements = [];

const fakeClient = {
  query: async (sql, params = []) => {
    statements.push({ sql, params });
    if (/INSERT INTO\s+\S*fragments/.test(sql)) return { rows: [{ id: "f1", importance: 0.5, created: true }] };
    return { rows: [] };
  }
};

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool      : () => ({}),
    queryWithAgentVector: async () => ({ rows: [] })
  }
});

const { FragmentWriter } = await import("../../lib/memory/write/FragmentWriter.js");
const { WriteGate }      = await import("../../lib/memory/write/WriteGate.js");

beforeEach(() => { statements.length = 0; });

/** 관문을 거친 후보를 만든다. */
async function approved(provenance) {
  const { draft } = await new WriteGate({ provenance: () => provenance }).check({
    entry : "remember",
    op    : "create",
    fields: { content: "Redis 포트는 6380으로 운영한다", topic: "ops", type: "fact", origin: "tool_output" },
    ctx   : { keyId: null, agentId: "default", provenance: { clientName: "cursor", trustCap: 3 } },
    build : (input) => ({ id: "f1", type: "fact", agent_id: "default", key_id: null, keywords: [], importance: 0.5, ...input })
  });
  return draft;
}

const insertStatement = () => statements.find(s => /INSERT INTO\s+\S*fragments/.test(s.sql));

describe("FragmentWriter 출처 열", () => {
  const writer = new FragmentWriter();

  it("출처 값이 있으면 세 열을 덧붙이고 33번부터 값을 싣는다", async () => {
    await writer.insertDetailed(await approved(true), { client: fakeClient });
    const { sql, params } = insertStatement();
    assert.match(sql, /embedding, origin, observed_client, trust_tier\)/);
    assert.match(sql, /NULL, \$33, \$34, \$35::smallint\)/);
    assert.equal(params.length, 35);
    assert.deepEqual(params.slice(32), ["tool_output", "cursor/remember", 2]);
  });

  it("출처 값이 없으면 열과 값의 수가 같다", async () => {
    await writer.insertDetailed(await approved(false), { client: fakeClient });
    const { sql, params } = insertStatement();
    assert.doesNotMatch(sql, /origin|observed_client|trust_tier/);
    assert.equal(params.length, 32);
  });
});
