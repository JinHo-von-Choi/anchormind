/**
 * 유사도·모순 판정만으로 파편을 닫지 않는지 검증하는 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-09-29
 *
 * 실제 GraphLinker·ContradictionDetector·EpisodeContinuityService 모듈을 쓰고
 * DB 계층만 대역으로 바꾼다. 사례의 본문과 유사도는 운영에서 잘못 닫힌 쌍에서
 * 가져왔다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

/** 시험마다 바꿔 끼우는 DB 응답 처리기 */
let vectorHandler = async () => ({ rows: [] });
let poolHandler   = async () => ({ rows: [] });

mock.module("../../lib/tools/db.js", {
  namedExports: {
    queryWithAgentVector: (...args) => vectorHandler(...args),
    getPrimaryPool      : () => ({ query: (...args) => poolHandler(...args) })
  }
});
mock.module("../../lib/memory/write/FragmentStore.js", {
  namedExports: {
    FragmentStore: class { async createLink(from, to, rel) { links.push({ from, to, rel }); } }
  }
});
mock.module("../../lib/logger.js", {
  namedExports: { logDebug() {}, logWarn() {}, logInfo() {}, logError() {} }
});

const { GraphLinker }          = await import("../../lib/memory/link/GraphLinker.js");
const { ContradictionDetector } = await import("../../lib/memory/link/ContradictionDetector.js");
const { linkEpisodeMilestone, _lastEventCacheForTest } =
  await import("../../lib/memory/processors/EpisodeContinuityService.js");
const { MemoryConsolidator }   = await import("../../lib/memory/consolidate/MemoryConsolidator.js");

let links  = [];
let writes = [];

beforeEach(() => {
  links  = [];
  writes = [];
  _lastEventCacheForTest().clear();
});

const norm = sql => String(sql).replace(/\s+/g, " ").trim();

/**
 * GraphLinker의 조회 순서(원본 → 중복 차단 후보 → 링크 후보)에 맞춰 응답한다.
 */
function graphLinkerDb({ source, dedup = [], candidates = [] }) {
  return async (_agentId, sql, params, mode) => {
    const n = norm(sql);
    if (mode === "write") { writes.push({ sql: n, params: [...params] }); return { rows: [], rowCount: 1 }; }
    if (n.startsWith("SELECT id, content, topic, type, created_at, key_id")) return { rows: [{ ...source }] };
    if (n.includes(">= 0.90")) return { rows: dedup.map(r => ({ ...r })) };
    if (n.includes("> 0.7"))   return { rows: candidates.map(r => ({ ...r })) };
    throw new Error(`unexpected SQL: ${n.slice(0, 80)}`);
  };
}

describe("GraphLinker는 유사도만으로 파편을 닫지 않는다", () => {
  const cases = [
    {
      name  : "같은 작업의 서로 다른 상태 기록 (cos 0.911)",
      source: { id: "new", topic: "memento-mcp", type: "fact", key_id: "k1", created_at: "2026-09-29T02:19:42Z",
                content: "anchormind 이슈 #83 2차 정리: 본문이 닫힌 원본과 같은 17건은 원본을 되살리고 사본을 닫았다." },
      old   : { id: "old", type: "fact", is_anchor: false, similarity: "0.911", created_at: "2026-09-29T01:34:10Z",
                content: "anchormind 이슈 #83은 수용 조건 대조 댓글을 남기고 completed로 닫았다." }
    },
    {
      name  : "서로 다른 세션의 앵커 reflect episode (cos 0.887)",
      source: { id: "new", topic: "session_reflect", type: "episode", key_id: "k1", created_at: "2026-09-20T00:00:10Z",
                content: "개천록의 경험 밀도를 높일 방향을 운영 자료로 진단했다." },
      old   : { id: "old", type: "episode", is_anchor: true, similarity: "0.887", created_at: "2026-09-18T00:00:00Z",
                content: "개천록 2026-09-18 밸런스 완화 묶음. 소경계 돌파 실패의 대가를 낮췄다." }
    },
    {
      name  : "시각이 다른 NPC 행적 기록 (cos 0.95)",
      source: { id: "new", topic: "npc-whereabouts", type: "fact", key_id: "k2", created_at: "2026-09-27T02:19:00Z",
                content: "2026-09-27 02:19에 선맹에서 투선전에서 조신묵을(를) 꺾었다 · 레이팅 1123 › 1168." },
      old   : { id: "old", type: "fact", is_anchor: false, similarity: "0.950", created_at: "2026-09-27T00:47:00Z",
                content: "2026-09-27 00:47에 선맹에서 투선전에서 권강영을(를) 꺾었다 · 레이팅 1065 › 1123." }
    }
  ];

  for (const c of cases) {
    it(`${c.name}: related로만 잇고 쓰기가 없다`, async () => {
      vectorHandler = graphLinkerDb({ source: c.source, candidates: [c.old] });
      await new GraphLinker().linkFragment("new", "system", null, []);

      assert.deepEqual(links, [{ from: "old", to: "new", rel: "related" }]);
      assert.equal(writes.length, 0);
    });
  }

  it("본문이 완전히 같은 중복은 새 파편을 닫는다", async () => {
    const content = "배치 큐 서버는 15000 포트에서 동작한다.";
    vectorHandler = graphLinkerDb({
      source: { id: "new", topic: "t", type: "fact", key_id: "k", created_at: "2026-09-02T00:00:00Z", content },
      dedup : [{ id: "old", content, created_at: "2026-09-01T00:00:00Z", similarity: "0.99" }]
    });
    await new GraphLinker().linkFragment("new", "system", null, []);

    assert.equal(links.length, 0);
    assert.ok(writes.some(w => /SET valid_to = NOW\(\)/.test(w.sql) && w.params[0] === "new"));
  });
});

describe("ContradictionDetector.resolveContradiction은 파편을 닫지 않는다", () => {
  const newer = { id: "n", key_id: null, created_at: "2026-09-02T00:00:00Z", content: "포트는 15000이다", is_anchor: false };

  it("contradicts 링크와 오래된 쪽 중요도 하향만 남긴다", async () => {
    vectorHandler = async (_agent, sql, params, mode) => {
      if (mode === "write") writes.push({ sql: norm(sql), params: [...params] });
      return { rows: [], rowCount: 1 };
    };
    const older = { id: "o", key_id: null, created_at: "2026-09-01T00:00:00Z", content: "포트는 8080이다", is_anchor: false };
    await new ContradictionDetector({ createLink: async (from, to, rel) => links.push({ from, to, rel }) })
      .resolveContradiction(newer, older, "port changed");

    assert.deepEqual(links, [{ from: "n", to: "o", rel: "contradicts" }]);
    assert.equal(writes.length, 1);
    assert.match(writes[0].sql, /SET importance = importance \* 0\.5/);
    assert.deepEqual(writes[0].params, ["o"]);
    assert.equal(writes.some(w => /valid_to/.test(w.sql)), false);
  });

  it("오래된 쪽이 앵커면 중요도도 건드리지 않는다", async () => {
    vectorHandler = async (_agent, sql, params, mode) => {
      if (mode === "write") writes.push({ sql: norm(sql), params: [...params] });
      return { rows: [], rowCount: 1 };
    };
    const anchor = { id: "o", key_id: null, created_at: "2026-09-01T00:00:00Z", content: "포트는 8080이다", is_anchor: true };
    await new ContradictionDetector({ createLink: async (from, to, rel) => links.push({ from, to, rel }) })
      .resolveContradiction(newer, anchor, "port changed");

    assert.equal(writes.length, 0);
  });
});

describe("semantic_dedup 후보는 같은 key·workspace로 제한된다", () => {
  it("KNN 조회에 key_id와 workspace 조건이 있고 폐기 시 superseded_by를 남긴다", () => {
    const src = MemoryConsolidator.prototype._semanticDedup.toString();
    assert.match(src, /keyScopeNullable\(knnParams, "key_id", frag\.key_id/);
    assert.match(src, /workspace IS NOT DISTINCT FROM \$4/);
    assert.match(src, /createLink\(oldId, keepId, "superseded_by"/);
  });
});

describe("milestone은 직전 milestone과 이어진다", () => {
  it("캐시가 비어도 방금 삽입한 자신이 아닌 직전 이벤트와 preceded_by로 잇는다", async () => {
    const events = [{ event_id: "event-old" }];
    const edges  = [];
    poolHandler = async (sql, params) => {
      const n = norm(sql);
      if (n.startsWith("SELECT LEFT(content, 200)")) {
        return { rows: [{ summary: "s", workspace: "ws", topic: "t", agent_id: "a", key_id: null }] };
      }
      if (n.startsWith("INSERT INTO agent_memory.case_events")) {
        events.push({ event_id: "event-new" });
        return { rows: [{ event_id: "event-new" }] };
      }
      if (n.startsWith("SELECT ce.event_id")) {
        /** DB처럼 가장 최근 이벤트부터 돌려주되 제외 조건이 있으면 따른다 */
        const excluded = n.includes("ce.event_id <>") ? params[params.length - 1] : null;
        const hit = [...events].reverse().find(e => e.event_id !== excluded);
        return { rows: hit ? [hit] : [] };
      }
      if (n.startsWith("INSERT INTO agent_memory.case_event_edges")) {
        edges.push(params);
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${n.slice(0, 80)}`);
    };

    await linkEpisodeMilestone("frag-1", "a", null, "session-1");

    assert.deepEqual(edges, [["event-old", "event-new"]]);
  });
});
