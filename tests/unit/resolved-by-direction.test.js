/**
 * resolved_by 방향 규약: "에러(fromId) → 해결책(toId)"
 *
 * link 도구, 케이스 이벤트 간선, 해결 판정, RCA 체인, 연결 제안이 같은 방향을 쓴다.
 * 해결책 → 에러 방향으로 저장된 이전 기록도 읽을 수 있어야 한다.
 */

import { describe, it, mock } from "node:test";
import assert                  from "node:assert/strict";

const dbCalls = [];
mock.module("../../lib/tools/db.js", {
  namedExports: {
    queryWithAgentVector: async (_agent, sql, params) => { dbCalls.push({ sql: String(sql), params }); return { rows: [] }; },
    getPrimaryPool      : () => null,
    withTransaction     : async (_pool, fn) => fn({ query: async () => ({ rows: [] }) })
  }
});
mock.module("../../lib/redis.js", { namedExports: { redisClient: { status: "stub" }, popFromQueue: async () => null, getQueueLength: async () => 0 } });
mock.module("../../lib/logger.js", { namedExports: { logDebug: mock.fn(), logInfo: mock.fn(), logWarn: mock.fn(), logError: mock.fn() } });

const { MemoryLinker }        = await import("../../lib/memory/processors/MemoryLinker.js");
const { HistoryReconstructor } = await import("../../lib/memory/read/HistoryReconstructor.js");
const { MemoryRememberer }    = await import("../../lib/memory/processors/MemoryRememberer.js");
const { LinkStore }           = await import("../../lib/memory/link/LinkStore.js");

function makeLinker(frags) {
  const store = {
    getById   : mock.fn(async (id) => frags[id] ?? null),
    createLink: mock.fn(async () => {}),
    update    : mock.fn(async () => ({}))
  };
  return { linker: new MemoryLinker({ store }), store };
}
const frag = (type, importance = 0.8) => ({ type, importance });

describe("MemoryLinker resolved_by: 해결된 에러 강등", () => {
  it("에러 → 해결책이면 시작점(에러)을 0.5로 내린다", async () => {
    const { linker, store } = makeLinker({ e: frag("error"), p: frag("procedure") });
    await linker.link({ fromId: "e", toId: "p", relationType: "resolved_by" });
    assert.equal(store.update.mock.callCount(), 1);
    assert.equal(store.update.mock.calls[0].arguments[0], "e");
    assert.deepEqual(store.update.mock.calls[0].arguments[1], { importance: 0.5 });
  });

  it("해결책 → 에러(이전 방향)이면 대상(에러)을 내린다", async () => {
    const { linker, store } = makeLinker({ e: frag("error"), p: frag("procedure") });
    await linker.link({ fromId: "p", toId: "e", relationType: "resolved_by" });
    assert.equal(store.update.mock.calls[0].arguments[0], "e");
  });

  it("에러 → 에러이면 시작점을 내린다", async () => {
    const { linker, store } = makeLinker({ a: frag("error"), b: frag("error") });
    await linker.link({ fromId: "a", toId: "b", relationType: "resolved_by" });
    assert.equal(store.update.mock.calls[0].arguments[0], "a");
  });

  it("이미 0.5 이하이면 내리지 않는다", async () => {
    const { linker, store } = makeLinker({ e: frag("error", 0.5), p: frag("procedure") });
    await linker.link({ fromId: "e", toId: "p", relationType: "resolved_by" });
    assert.equal(store.update.mock.callCount(), 0);
  });

  it("에러가 없거나 다른 관계이면 내리지 않는다", async () => {
    const a = makeLinker({ d: frag("decision"), p: frag("procedure") });
    await a.linker.link({ fromId: "d", toId: "p", relationType: "resolved_by" });
    const b = makeLinker({ e: frag("error"), p: frag("procedure") });
    await b.linker.link({ fromId: "e", toId: "p", relationType: "caused_by" });
    assert.equal(a.store.update.mock.callCount() + b.store.update.mock.callCount(), 0);
  });
});

describe("HistoryReconstructor 미해결 판정", () => {
  const rec = new HistoryReconstructor(null, null, null);
  const ev = (id) => ({ event_id: id, event_type: "error_observed" });

  it("에러 → 해결 간선이 있으면 해결로 본다", () => {
    const r = rec._detectUnresolvedBranches([], [], [ev("e1"), ev("e2")], [{ edge_type: "resolved_by", from_event_id: "e1", to_event_id: "f1" }]);
    assert.deepEqual(r.map(x => x.event_id), ["e2"]);
  });

  it("해결 → 에러(이전 방향) 간선도 해결로 본다", () => {
    const r = rec._detectUnresolvedBranches([], [], [ev("e1"), ev("e2")], [{ edge_type: "resolved_by", from_event_id: "f1", to_event_id: "e1" }]);
    assert.deepEqual(r.map(x => x.event_id), ["e2"]);
  });

  it("다른 간선은 해결로 보지 않는다", () => {
    const r = rec._detectUnresolvedBranches([], [], [ev("e1")], [{ edge_type: "preceded_by", from_event_id: "e1", to_event_id: "x" }]);
    assert.equal(r.length, 1);
  });
});

describe("케이스 이벤트 resolved_by 간선", () => {
  it("에러 이벤트에서 해결 이벤트로 간선을 쓴다", async () => {
    const edges = [];
    const caseEventStore = {
      append     : async () => ({ inserted: true, event_id: "fix-evt" }),
      addEvidence: async () => {},
      getByCase  : async (_c, opts) => (opts.eventType === "error_observed" ? [{ event_id: "err-evt" }] : [{ event_id: "fix-evt" }, { event_id: "prev" }]),
      addEdge    : async (from, to, type) => { edges.push([from, to, type]); }
    };
    await MemoryRememberer.prototype._recordCaseEvent.call({ caseEventStore }, { id: "f", type: "procedure", case_id: "c1", content: "절차", keywords: [] }, null);
    assert.deepEqual(edges.filter(e => e[2] === "resolved_by"), [["err-evt", "fix-evt", "resolved_by"]]);
  });
});

describe("LinkStore.getRCAChain", () => {
  it("에러에서 to 방향으로 따라가고, 이전 방향의 절차 → 에러 resolved_by도 포함한다", async () => {
    dbCalls.length = 0;
    const store = new LinkStore();
    await store.getRCAChain("frag-1", "agent", null, [], {});
    const sql = dbCalls[0].sql;
    assert.match(sql, /JOIN [^\n]*fragments f2 ON l\.to_id = f2\.id\s+WHERE l\.from_id = \$1/);
    assert.match(sql, /JOIN [^\n]*fragments f2 ON l\.from_id = f2\.id\s+WHERE l\.to_id = \$1/);
    assert.match(sql, /l\.relation_type = 'resolved_by'\s+AND f2\.type = 'procedure'/);
  });
});
