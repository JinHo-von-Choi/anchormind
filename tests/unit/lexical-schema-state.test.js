/**
 * 본문 어휘 채널 스키마 상태 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 카탈로그 조회를 대역 함수로 바꿔 열과 GIN 색인 상태의 판정, 참여 규칙, 상태 기억 간격, 경고 횟수를 본다.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert                             from "node:assert/strict";

const warnings = [];
mock.module("../../lib/logger.js", {
  namedExports: {
    logWarn : (msg) => warnings.push(msg),
    logInfo : () => {},
    logError: () => {},
    logDebug: () => {}
  }
});

const {
  evaluateLexicalSchema, lexicalParticipation, loadLexicalSchema, resetLexicalSchema, warnLexicalOnce, peekLexicalSchema,
  LEXICAL_SCHEMA_TTL_MS, LEXICAL_SCHEMA_SQL, LEXICAL_REASONS
} = await import("../../lib/memory/LexicalSchema.js");

beforeEach(() => {
  resetLexicalSchema();
  warnings.length = 0;
});

describe("evaluateLexicalSchema", () => {
  const cases = [
    ["열 없음",               { column_present: false, indexes: [] },                                          { column: false, index: "absent" }],
    ["열만 있음",             { column_present: true,  indexes: [] },                                          { column: true,  index: "absent" }],
    ["유효한 색인",            { column_present: true,  indexes: [{ name: "idx_fragments_content_tokens", valid: true }] },  { column: true, index: "valid" }],
    ["무효 색인",              { column_present: true,  indexes: [{ name: "idx_fragments_content_tokens", valid: false }] }, { column: true, index: "invalid" }],
    ["무효와 유효가 함께",      { column_present: true,  indexes: [{ name: "a", valid: false }, { name: "b", valid: true }] }, { column: true, index: "valid" }],
    ["json 문자열로 온 색인",   { column_present: true,  indexes: "[{\"name\":\"x\",\"valid\":true}]" },         { column: true,  index: "valid" }],
    ["행 없음",               undefined,                                                                      { column: false, index: "absent" }]
  ];
  for (const [name, row, expected] of cases) {
    it(name, () => {
      const state = evaluateLexicalSchema(row);
      assert.equal(state.column, expected.column);
      assert.equal(state.index, expected.index);
    });
  }

  it("색인 이름은 정의로 찾은 결과를 그대로 담는다", () => {
    const state = evaluateLexicalSchema({ column_present: true, indexes: [{ name: "fragments_new_content_tokens_idx", valid: true }] });
    assert.deepEqual(state.indexNames, ["fragments_new_content_tokens_idx"]);
  });
});

describe("lexicalParticipation", () => {
  const table = [
    [{ column: false, index: "absent" },  false, LEXICAL_REASONS.COLUMN_MISSING],
    [{ column: false, index: "valid" },   false, LEXICAL_REASONS.COLUMN_MISSING],
    [{ column: true,  index: "invalid" }, false, LEXICAL_REASONS.INDEX_INVALID],
    [{ column: true,  index: "absent" },  false, LEXICAL_REASONS.INDEX_ABSENT],
    [{ column: true,  index: "valid" },   true,  LEXICAL_REASONS.READY]
  ];
  for (const [schema, participates, reason] of table) {
    it(`${schema.column ? "열 있음" : "열 없음"}, 색인 ${schema.index}`, () => {
      assert.deepEqual(lexicalParticipation(schema), { participates, reason });
    });
  }
});

describe("loadLexicalSchema", () => {
  function stubRun(rows) {
    const calls = [];
    const run   = async (sql, params) => {
      calls.push({ sql, params });
      return { rows };
    };
    return { run, calls };
  }

  it("fragments 표 이름으로 카탈로그를 읽는다", async () => {
    const { run, calls } = stubRun([{ column_present: true, indexes: [] }]);
    await loadLexicalSchema(run, 1000);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sql, LEXICAL_SCHEMA_SQL);
    assert.deepEqual(calls[0].params, ["agent_memory.fragments"]);
  });

  it("기억 간격 안에서는 다시 읽지 않고, 간격이 지나면 다시 읽는다", async () => {
    const { run, calls } = stubRun([{ column_present: true, indexes: [] }]);
    await loadLexicalSchema(run, 1000);
    await loadLexicalSchema(run, 1000 + LEXICAL_SCHEMA_TTL_MS - 1);
    assert.equal(calls.length, 1);
    await loadLexicalSchema(run, 1000 + LEXICAL_SCHEMA_TTL_MS);
    assert.equal(calls.length, 2);
  });

  it("동시 요청은 한 번의 조회를 나눠 쓴다", async () => {
    const { run, calls } = stubRun([{ column_present: true, indexes: [{ name: "i", valid: true }] }]);
    const [a, b] = await Promise.all([loadLexicalSchema(run, 5), loadLexicalSchema(run, 5)]);
    assert.equal(calls.length, 1);
    assert.equal(a.index, "valid");
    assert.equal(b.index, "valid");
  });

  it("조회 오류를 그대로 던지고 다음 호출이 다시 읽는다", async () => {
    let fail = true;
    const run = async () => {
      if (fail) throw Object.assign(new Error("boom"), { code: "57014" });
      return { rows: [{ column_present: true, indexes: [] }] };
    };
    await assert.rejects(loadLexicalSchema(run, 1), /boom/);
    fail = false;
    const state = await loadLexicalSchema(run, 2);
    assert.equal(state.column, true);
  });
});

describe("warnLexicalOnce", () => {
  it("사유마다 한 번만 경고한다", () => {
    warnLexicalOnce(LEXICAL_REASONS.INDEX_INVALID);
    warnLexicalOnce(LEXICAL_REASONS.INDEX_INVALID);
    warnLexicalOnce(LEXICAL_REASONS.COLUMN_MISSING);
    assert.equal(warnings.length, 2);
  });

  it("준비 상태는 경고하지 않는다", () => {
    warnLexicalOnce(LEXICAL_REASONS.READY);
    assert.equal(warnings.length, 0);
  });
});

describe("peekLexicalSchema", () => {
  it("기억한 상태가 간격 안이면 돌려주고 아니면 null이며 질의하지 않는다", async () => {
    assert.equal(peekLexicalSchema(1), null);
    await loadLexicalSchema(async () => ({ rows: [{ column_present: true, indexes: [] }] }), 100);
    assert.equal(peekLexicalSchema(100 + LEXICAL_SCHEMA_TTL_MS - 1).column, true);
    assert.equal(peekLexicalSchema(100 + LEXICAL_SCHEMA_TTL_MS), null);
  });
});
