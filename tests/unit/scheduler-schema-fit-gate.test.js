/**
 * 통합 실행 게이트 판정 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 세 지표(미해결 caseId 최대 누적, 최근 related 링크 수, 마지막 실행 이후 파편 수)와
 * mode(off, all, any) 조합의 판정을 본다. 풀은 지표 값을 돌려주는 대역이다.
 */

import { describe, it, after } from "node:test";
import assert                  from "node:assert/strict";

const { evaluateSchemaFitGate }                      = await import("../../lib/scheduler.js");
const { teardownTestResources, assertCleanShutdown } = await import("../_lifecycle.js");

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

/** 질의 순서(case, link, fragment)대로 값을 돌려주고 받은 질의를 기록하는 풀 대역 */
function poolWith({ caseMax, related, fragments }) {
  const answers = [{ max_cnt: caseMax }, { cnt: related }, { cnt: fragments }];
  const calls   = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [answers[calls.length - 1]] };
    }
  };
}

const CFG = { pendingCaseFragmentsMin: 5, recentRelatedLinksMin: 10, fragmentsSinceLastRunMin: 20 };

describe("evaluateSchemaFitGate", () => {
  it("mode off는 질의 없이 통과한다", async () => {
    const pool = { query: async () => { throw new Error("질의하면 안 된다"); } };
    assert.equal(await evaluateSchemaFitGate(pool, { ...CFG, mode: "off" }, null), true);
  });

  it("mode all은 세 조건이 모두 충족돼야 통과한다", async () => {
    assert.equal(await evaluateSchemaFitGate(poolWith({ caseMax: 5, related: 10, fragments: 20 }), { ...CFG, mode: "all" }, null), true);
    assert.equal(await evaluateSchemaFitGate(poolWith({ caseMax: 5, related: 9, fragments: 20 }), { ...CFG, mode: "all" }, null), false);
  });

  it("mode any는 한 조건만 충족돼도 통과한다", async () => {
    assert.equal(await evaluateSchemaFitGate(poolWith({ caseMax: 0, related: 0, fragments: 20 }), { ...CFG, mode: "any" }, null), true);
    assert.equal(await evaluateSchemaFitGate(poolWith({ caseMax: 4, related: 9, fragments: 19 }), { ...CFG, mode: "any" }, null), false);
  });

  it("지표 값이 비어 있으면 0으로 본다", async () => {
    const pool = { query: async () => ({ rows: [{}] }) };
    assert.equal(await evaluateSchemaFitGate(pool, { ...CFG, mode: "any" }, null), false);
  });

  it("마지막 실행 시각이 없으면 epoch를, 있으면 그 시각을 파편 수 질의에 넘긴다", async () => {
    const first = poolWith({ caseMax: 0, related: 0, fragments: 0 });
    await evaluateSchemaFitGate(first, { ...CFG, mode: "any" }, null);
    assert.deepEqual(first.calls[2].params, ["1970-01-01T00:00:00Z"]);

    const later = poolWith({ caseMax: 0, related: 0, fragments: 0 });
    await evaluateSchemaFitGate(later, { ...CFG, mode: "any" }, "2026-10-01T00:00:00Z");
    assert.deepEqual(later.calls[2].params, ["2026-10-01T00:00:00Z"]);
  });
});
