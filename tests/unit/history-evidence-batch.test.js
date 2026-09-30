/**
 * 이력 재구성의 근거 파편 일괄 조회 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
 *
 * 1. CaseEventStore.getEvidenceByEvents 는 이벤트 수와 무관하게 질의 1회로 묶고 event_id 별로 나눈다
 * 2. 단건 getEvidenceByEvent 는 같은 결과 형태(event_id 없는 행 배열)를 유지한다
 * 3. HistoryReconstructor 는 근거를 한 번에 조회하고, 실패 시 evidence_error 를 붙여 알린다
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert                             from "node:assert/strict";

const calls    = [];
const warnings = [];
let   nextRows = [];

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool : () => ({
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: nextRows.map(r => ({ ...r })) };
      }
    }),
    withTransaction: async () => { throw new Error("not used"); }
  }
});
mock.module("../../lib/logger.js", {
  namedExports: { logWarn: message => warnings.push(String(message)), logInfo: () => {}, logDebug: () => {}, logError: () => {} }
});
mock.module("../../lib/memory/signals/CaseRewardBackprop.js", {
  namedExports: { getBackprop: () => ({ backprop: async () => {} }) }
});

const { CaseEventStore }       = await import("../../lib/memory/CaseEventStore.js");
const { HistoryReconstructor } = await import("../../lib/memory/read/HistoryReconstructor.js");

const EV_A = "00000000-0000-4000-8000-00000000000a";
const EV_B = "00000000-0000-4000-8000-00000000000b";
const EV_C = "00000000-0000-4000-8000-00000000000c";

beforeEach(() => {
  calls.length    = 0;
  warnings.length = 0;
  nextRows        = [];
});

describe("CaseEventStore 근거 일괄 조회", () => {
  it("여러 이벤트를 질의 1회로 조회하고 event_id 별로 묶는다", async () => {
    nextRows = [
      { event_id: EV_A, fragment_id: "f1", content: "c1", type: "fact", topic: "t", keywords: [], kind: "supports", confidence: 0.9 },
      { event_id: EV_A, fragment_id: "f2", content: "c2", type: "fact", topic: "t", keywords: [], kind: "supports", confidence: 0.5 },
      { event_id: EV_B, fragment_id: "f3", content: "c3", type: "fact", topic: "t", keywords: [], kind: "refutes",  confidence: 0.7 }
    ];
    const grouped = await new CaseEventStore().getEvidenceByEvents([EV_A, EV_B, EV_C], { keyId: "key-a" });

    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /fe\.event_id = ANY\(\$1::uuid\[\]\)/);
    assert.deepEqual(calls[0].params[0], [EV_A, EV_B, EV_C]);
    assert.deepEqual(grouped.get(EV_A).map(r => r.fragment_id), ["f1", "f2"]);
    assert.deepEqual(grouped.get(EV_B).map(r => r.fragment_id), ["f3"]);
    assert.equal(grouped.has(EV_C), false);
    assert.equal("event_id" in grouped.get(EV_A)[0], false, "행에서 묶음 키를 뺀다");
  });

  it("빈 입력은 질의하지 않는다", async () => {
    const grouped = await new CaseEventStore().getEvidenceByEvents([], null);
    assert.equal(grouped.size, 0);
    assert.equal(calls.length, 0);
  });

  it("단건 조회는 같은 행 형태의 배열을 돌려준다", async () => {
    nextRows = [{ event_id: EV_A, fragment_id: "f1", content: "c1", type: "fact", topic: "t", keywords: [], kind: "supports", confidence: 0.9 }];
    const rows = await new CaseEventStore().getEvidenceByEvent(EV_A, "key-a");
    assert.deepEqual(rows, [{ fragment_id: "f1", content: "c1", type: "fact", topic: "t", keywords: [], kind: "supports", confidence: 0.9 }]);
    assert.equal(calls.length, 1);

    nextRows = [];
    assert.deepEqual(await new CaseEventStore().getEvidenceByEvent(EV_B, "key-a"), []);
  });
});

describe("HistoryReconstructor 근거 첨부", () => {
  function makeReconstructor(caseEventStore) {
    const hr = new HistoryReconstructor({}, {}, caseEventStore);
    hr._fetchTimelineParameterized = async () => [];
    hr._fetchLinks                 = async () => [];
    return hr;
  }

  it("이벤트 수와 무관하게 근거 조회를 한 번만 부르고 이벤트마다 첨부한다", async () => {
    const seen  = [];
    const store = {
      getByCase           : async () => [{ event_id: EV_A }, { event_id: EV_B }, { event_id: EV_C }],
      getEdgesByEvents    : async () => [],
      getEvidenceByEvent  : async () => { throw new Error("단건 조회를 부르면 안 된다"); },
      getEvidenceByEvents : async (ids, scope) => {
        seen.push({ ids, scope });
        return new Map([[EV_A, [{ fragment_id: "f1" }]], [EV_C, [{ fragment_id: "f9" }]]]);
      }
    };
    const out = await makeReconstructor(store).reconstruct({ caseId: "case-a", agentId: "default", keyId: "key-a" });

    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].ids, [EV_A, EV_B, EV_C]);
    assert.equal(seen[0].scope.keyId, "key-a");
    assert.deepEqual(out.case_events.map(e => e.evidence.map(r => r.fragment_id)), [["f1"], [], ["f9"]]);
    assert.ok(out.case_events.every(e => e.evidence_error === undefined));
  });

  it("근거 조회가 실패하면 빈 근거와 evidence_error 를 붙이고 경고를 남긴다", async () => {
    const store = {
      getByCase           : async () => [{ event_id: EV_A }, { event_id: EV_B }],
      getEdgesByEvents    : async () => [],
      getEvidenceByEvents : async () => { throw new Error("pool timeout"); }
    };
    const out = await makeReconstructor(store).reconstruct({ caseId: "case-a", agentId: "default" });

    assert.deepEqual(out.case_events.map(e => e.evidence), [[], []]);
    assert.ok(out.case_events.every(e => e.evidence_error === true));
    assert.ok(warnings.some(w => w.includes("pool timeout")));
  });
});
