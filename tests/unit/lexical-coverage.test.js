/**
 * 본문 어휘 채널 키별 채움 지표 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 질의 함수를 대역으로 바꿔 키별 채움 비율과 미채움 수 게이지, 갱신 간격, 스위치와 열 상태를 본다.
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
  refreshLexicalCoverage, resetLexicalCoverage, coverageRows, COVERAGE_TTL_MS, COVERAGE_SQL,
  lexicalCoverageRatio, lexicalTokensMissing, MASTER_LABEL
} = await import("../../lib/memory/LexicalCoverage.js");
const { resetLexicalSchema } = await import("../../lib/memory/LexicalSchema.js");

async function gaugeValues(gauge) {
  const { values } = await gauge.get();
  return Object.fromEntries(values.map(v => [v.labels.key_id, v.value]));
}

function stubRun({ column = true, rows = [], fail = null } = {}) {
  const calls = [];
  const run   = async (sql, params) => {
    calls.push(sql);
    if (sql.includes("column_present")) return { rows: [{ column_present: column, indexes: [] }] };
    if (fail) throw fail;
    return { rows };
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

describe("coverageRows", () => {
  it("키별 비율과 미채움 수를 계산하고 마스터 파편은 master 라벨이다", () => {
    assert.deepEqual(coverageRows([
      { key_id: "k1", total: "4", filled: "3" },
      { key_id: null, total: "2", filled: "2" },
      { key_id: "k2", total: "0", filled: "0" }
    ]), [
      { keyId: "k1", ratio: 0.75, missing: 1 },
      { keyId: MASTER_LABEL, ratio: 1, missing: 0 },
      { keyId: "k2", ratio: 1, missing: 0 }
    ]);
  });
});

describe("refreshLexicalCoverage", () => {
  it("열이 있으면 키별 게이지를 채운다", async () => {
    const { run, calls } = stubRun({ rows: [{ key_id: "k1", total: 10, filled: 4 }, { key_id: null, total: 5, filled: 5 }] });
    await refreshLexicalCoverage(run, T0);
    assert.ok(calls.includes(COVERAGE_SQL));
    assert.deepEqual(await gaugeValues(lexicalCoverageRatio), { k1: 0.4, [MASTER_LABEL]: 1 });
    assert.deepEqual(await gaugeValues(lexicalTokensMissing), { k1: 6, [MASTER_LABEL]: 0 });
  });

  it("갱신 간격 안에서는 다시 세지 않는다", async () => {
    const { run, calls } = stubRun({ rows: [] });
    await refreshLexicalCoverage(run, T0);
    await refreshLexicalCoverage(run, T0 + COVERAGE_TTL_MS - 1);
    assert.equal(calls.filter(sql => sql === COVERAGE_SQL).length, 1);
    await refreshLexicalCoverage(run, T0 + COVERAGE_TTL_MS + 1);
    assert.equal(calls.filter(sql => sql === COVERAGE_SQL).length, 2);
  });

  it("이전에 있던 키가 사라지면 그 라벨을 지운다", async () => {
    await refreshLexicalCoverage(stubRun({ rows: [{ key_id: "gone", total: 1, filled: 0 }] }).run, T0);
    await refreshLexicalCoverage(stubRun({ rows: [{ key_id: "k1", total: 1, filled: 1 }] }).run, T0 + COVERAGE_TTL_MS);
    assert.deepEqual(Object.keys(await gaugeValues(lexicalCoverageRatio)), ["k1"]);
  });

  it("열이 없으면 세지 않고 게이지를 비운다", async () => {
    const { run, calls } = stubRun({ column: false });
    await refreshLexicalCoverage(run, T0);
    assert.equal(calls.includes(COVERAGE_SQL), false);
    assert.deepEqual(await gaugeValues(lexicalCoverageRatio), {});
  });

  it("스위치가 off이면 아무것도 읽지 않는다", async () => {
    process.env.MEMENTO_LEXICAL_CHANNEL = "off";
    const { run, calls } = stubRun({ rows: [{ key_id: "k1", total: 1, filled: 1 }] });
    await refreshLexicalCoverage(run, T0);
    assert.equal(calls.length, 0);
  });

  it("조회 오류는 경고로 남기고 던지지 않는다", async () => {
    const { run } = stubRun({ fail: Object.assign(new Error("timeout"), { code: "57014" }) });
    await refreshLexicalCoverage(run, T0);
    assert.equal(warnings.length, 1);
  });
});
