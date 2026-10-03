/**
 * 본문 어휘 채널 채움 지표 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 질의 함수를 대역으로 바꿔 채움 비율과 미채움 수 게이지(라벨 없음), 갱신 간격, 스위치와 열 상태를 본다.
 * 게이지 값을 읽으면 수집 함수가 갱신을 부르므로 기준 시각은 현재 시각 이후로 둔다(갱신 간격 안).
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert                                       from "node:assert/strict";

const warnings = [];
const defaultCalls = [];
mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool      : () => null,
    queryWithAgentVector: async (_agent, sql) => { defaultCalls.push(sql); return { rows: [] }; }
  }
});
mock.module("../../lib/logger.js", {
  namedExports: { logWarn: (m) => warnings.push(m), logInfo: () => {}, logError: () => {}, logDebug: () => {} }
});

const {
  refreshLexicalCoverage, resetLexicalCoverage, coverageValues, COVERAGE_TTL_MS, COVERAGE_SQL,
  lexicalCoverageRatio, lexicalTokensMissing
} = await import("../../lib/memory/LexicalCoverage.js");
const { resetLexicalSchema } = await import("../../lib/memory/LexicalSchema.js");

async function gaugeValues(gauge) {
  const { values } = await gauge.get();
  return values;
}

function stubRun({ column = true, row = { total: 0, filled: 0 }, fail = null } = {}) {
  const calls = [];
  const run   = async (sql) => {
    calls.push(sql);
    if (sql.includes("column_present")) return { rows: [{ column_present: column, indexes: [] }] };
    if (fail) throw fail;
    return { rows: [row] };
  };
  return { run, calls };
}

const T0 = Date.now() + 1000;

beforeEach(() => {
  defaultCalls.length = 0;
  resetLexicalSchema();
  resetLexicalCoverage();
  warnings.length = 0;
  delete process.env.MEMENTO_LEXICAL_CHANNEL;
});

afterEach(() => { delete process.env.MEMENTO_LEXICAL_CHANNEL; });

describe("coverageValues", () => {
  it("비율과 미채움 수를 계산하고 현행 파편이 없으면 비율 1", () => {
    assert.deepEqual(coverageValues({ total: "8", filled: "6" }), { ratio: 0.75, missing: 2 });
    assert.deepEqual(coverageValues({ total: 0, filled: 0 }), { ratio: 1, missing: 0 });
    assert.deepEqual(coverageValues(undefined), { ratio: 1, missing: 0 });
  });
});

describe("refreshLexicalCoverage", () => {
  it("열이 있으면 라벨 없는 게이지를 채운다", async () => {
    const { run, calls } = stubRun({ row: { total: 10, filled: 4 } });
    await refreshLexicalCoverage(run, T0);
    assert.ok(calls.includes(COVERAGE_SQL));
    assert.doesNotMatch(COVERAGE_SQL, /key_id/);
    const [ratio]   = await gaugeValues(lexicalCoverageRatio);
    const [missing] = await gaugeValues(lexicalTokensMissing);
    assert.equal(ratio.value, 0.4);
    assert.deepEqual(ratio.labels, {});
    assert.equal(missing.value, 6);
  });

  it("갱신 간격 안에서는 다시 세지 않는다", async () => {
    const { run, calls } = stubRun();
    await refreshLexicalCoverage(run, T0);
    await refreshLexicalCoverage(run, T0 + COVERAGE_TTL_MS - 1);
    assert.equal(calls.filter(sql => sql === COVERAGE_SQL).length, 1);
    await refreshLexicalCoverage(run, T0 + COVERAGE_TTL_MS + 1);
    assert.equal(calls.filter(sql => sql === COVERAGE_SQL).length, 2);
  });

  it("열이 없으면 세지 않고 값을 내보내지 않는다", async () => {
    const { run, calls } = stubRun({ column: false });
    await refreshLexicalCoverage(run, T0);
    assert.equal(calls.includes(COVERAGE_SQL), false);
    assert.ok((await gaugeValues(lexicalTokensMissing)).every(v => v.value === 0));
  });

  it("스위치가 off이면 아무것도 읽지 않는다", async () => {
    process.env.MEMENTO_LEXICAL_CHANNEL = "off";
    const { run, calls } = stubRun({ row: { total: 1, filled: 1 } });
    await refreshLexicalCoverage(run, T0);
    assert.equal(calls.length, 0);
  });

  it("조회 오류는 경고로 남기고 던지지 않는다", async () => {
    const { run } = stubRun({ fail: Object.assign(new Error("timeout"), { code: "57014" }) });
    await refreshLexicalCoverage(run, T0);
    assert.equal(warnings.length, 1);
  });
});
