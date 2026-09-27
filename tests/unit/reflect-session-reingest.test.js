/**
 * reflect 세션 종합 재수집 방지 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-09-28
 *
 * 실제 SessionLinker·ReflectProcessor·FragmentFactory를 묶고 저장소만
 * content_hash 병합(ON CONFLICT)을 흉내 낸 메모리 대역으로 바꿔, 같은 세션에서
 * reflect를 반복할 때 새로 생기는 행의 수·유형·해결 상태·workspace를 검증한다.
 */

import { describe, it, mock, after } from "node:test";
import assert from "node:assert/strict";

mock.module("../../lib/memory/embedding/MorphemeIndex.js", {
  namedExports: {
    MorphemeIndex: class {
      async tokenize(t)              { return String(t).toLowerCase().split(/[\s,.]+/).filter(w => w.length > 1).slice(0, 10); }
      async getOrRegisterEmbeddings() { return []; }
    },
  },
});

mock.module("../../lib/memory/processors/EpisodeContinuityService.js", {
  namedExports: { linkEpisodeMilestone: async () => null }
});

const { ReflectProcessor }   = await import("../../lib/memory/processors/ReflectProcessor.js");
const { SessionLinker }      = await import("../../lib/memory/link/SessionLinker.js");
const { FragmentFactory }    = await import("../../lib/memory/write/FragmentFactory.js");
const { computeContentHash } = await import("../../lib/tools/embedding.js");
const { teardownTestResources, assertCleanShutdown } = await import("../_lifecycle.js");

after(async () => {
  await new Promise(r => setImmediate(r));
  await teardownTestResources();
  await assertCleanShutdown();
});

const SESSION = "12345678-aaaa-bbbb-cccc-000000000000";

/**
 * 세션 집합·Working Memory·content_hash 병합 저장소를 갖춘 시험 환경을 만든다.
 * 저장된 파편은 FragmentIndex.index와 같이 세션 집합에 들어가 다음 reflect의
 * 입력 후보가 된다.
 */
function makeEnv({ wmItems = [] } = {}) {
  const rows       = new Map();
  const byHash     = new Map();
  const sessionIds = new Map();
  let   wm         = [...wmItems];
  let   seq        = 0;

  const addToSession = (sessionId, id) => {
    if (!sessionId) return;
    if (!sessionIds.has(sessionId)) sessionIds.set(sessionId, new Set());
    sessionIds.get(sessionId).add(id);
  };

  const store = {
    async insert(f) {
      const hash = computeContentHash(f.content);
      if (byHash.has(hash)) return byHash.get(hash);
      const id = f.id || `row-${++seq}`;
      rows.set(id, {
        ...f,
        id,
        resolution_status: f.resolution_status ?? f.resolutionStatus ?? null,
        case_id          : f.case_id ?? f.caseId ?? null
      });
      byHash.set(hash, id);
      return id;
    },
    async getByIds(ids) { return ids.map(id => rows.get(id)).filter(Boolean); }
  };

  const index = {
    async getSessionFragments(sessionId) { return [...(sessionIds.get(sessionId) ?? [])]; },
    async getWorkingMemory()             { return wm; },
    async evictWorkingMemoryItems(_s, consumed) { wm = wm.filter(w => !consumed.includes(w.id)); },
    async index(f, sessionId)            { addToSession(sessionId, f.id); }
  };

  const factory = new FragmentFactory();
  const linker  = new SessionLinker(store, index);
  linker.autoLinkSessionFragments = async () => ({ linkSuggestions: [] });

  const remember = async (p) => {
    const f = factory.create({ ...p });
    f.workspace = p.workspace ?? null;
    const id = await store.insert(f);
    addToSession(p.sessionId, id);
    return { id };
  };

  const processor = new ReflectProcessor({
    store, index, factory, sessionLinker: linker, remember, batchRememberProcessor: null
  });
  processor._queueEmbeddings   = async () => {};
  processor._registerMorphemes = () => {};
  processor._recordTaskFeedback = async () => {};

  /** 이미 remember로 영속화된 세션 파편을 심는다. */
  const seed = async (f) => {
    const id = await store.insert({ importance: 0.6, ...f });
    addToSession(SESSION, id);
    return id;
  };

  /** reflect 한 번을 실행하고 그 사이 새로 생긴 행을 돌려준다. */
  const reflect = async (params = {}) => {
    const before = new Set(rows.keys());
    await processor.process({ sessionId: SESSION, agentId: "default", ...params });
    return [...rows.values()].filter(r => !before.has(r.id));
  };

  return { seed, reflect };
}

describe("reflect 세션 종합 재수집 방지", () => {

  it("DB 파편만 있는 세션에서 reflect를 3회 불러도 새 행이 생기지 않는다", async () => {
    const env = makeEnv();
    await env.seed({ content: "Project Alpha 큐 타임아웃 원인은 아직 찾지 못했다", type: "error", topic: "alpha", workspace: "alpha", resolution_status: "open" });
    await env.seed({ content: "Project Alpha는 단일 큐를 사용하기로 결정했다", type: "decision", topic: "alpha", workspace: "alpha" });
    await env.seed({ content: "Project Alpha 큐 서버 포트는 15000이다. 재시작은 systemctl로 한다.", type: "fact", topic: "alpha", workspace: "alpha" });

    for (let i = 0; i < 3; i++) {
      const created = await env.reflect();
      assert.deepEqual(created, [], `${i + 1}회차에 새 행 ${created.length}건`);
    }
  });

  it("결정만 있는 세션에서 건수 요약 fact를 만들지 않는다", async () => {
    const env = makeEnv();
    await env.seed({ content: "Project Alpha는 단일 큐를 사용하기로 결정했다", type: "decision", topic: "alpha", workspace: "alpha" });

    const created = await env.reflect();
    assert.equal(created.some(r => /결정 \d+건, 에러 해결 \d+건/.test(r.content)), false);
  });

  it("WM 전용 error는 상태 표기가 없으면 open으로, [해결됨] 표기가 있으면 resolved로 저장된다", async () => {
    const env = makeEnv({ wmItems: [
      { id: "wm-1", type: "error", content: "배치 큐 타임아웃 원인을 아직 찾지 못했다", topic: "queue", workspace: "alpha" },
      { id: "wm-2", type: "error", content: "[해결됨] 배치 큐 커넥션 누수를 풀 반환 누락 수정으로 해결", topic: "queue", workspace: "alpha" }
    ] });

    const errors = (await env.reflect()).filter(r => r.type === "error");
    const open     = errors.find(r => r.content.includes("타임아웃"));
    const resolved = errors.find(r => r.content.includes("커넥션 누수"));

    assert.equal(open.resolution_status, "open");
    assert.equal(open.content.startsWith("[해결됨]"), false);
    assert.equal(resolved.resolution_status, "resolved");
    assert.equal(resolved.content, "[해결됨] 배치 큐 커넥션 누수를 풀 반환 누락 수정으로 해결");
  });

  it("다른 workspace 파편이 있는 세션에서 수동 reflect는 호출자 workspace에만 저장한다", async () => {
    const env = makeEnv();
    await env.seed({ content: "개천록 인디게임 조사에서 제안 15개를 정리했다", type: "fact", topic: "gaecheonrok", workspace: "gaecheonrok" });

    const created = await env.reflect({ workspace: "memento-mcp", summary: ["memento-mcp dependabot PR 세 건을 병합했다"] });

    assert.ok(created.length > 0);
    assert.ok(created.every(r => r.workspace === "memento-mcp"));
    assert.equal(created.some(r => r.content.includes("개천록")), false);
  });

  it("WM 전용 항목은 첫 reflect에서 한 번 저장되고 두 번째 reflect에서는 새 행이 없다", async () => {
    const env = makeEnv({ wmItems: [
      { id: "wm-1", type: "decision", content: "배치 큐는 단일 큐로 운영하기로 결정했다", topic: "queue", workspace: "alpha" }
    ] });

    const first  = await env.reflect();
    const second = await env.reflect();

    const decisions = first.filter(r => r.type === "decision");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].workspace, "alpha");
    assert.deepEqual(second, []);
  });

  it("수동 summary와 narrative_summary는 저장된다", async () => {
    const env = makeEnv();
    const created = await env.reflect({
      workspace        : "alpha",
      summary          : ["Project Alpha 큐 서버를 15000 포트로 이전했다"],
      narrative_summary: "Project Alpha 큐 서버를 새 포트로 옮기고 재시작 절차를 정리했다."
    });

    assert.ok(created.some(r => r.type === "fact" && r.content === "Project Alpha 큐 서버를 15000 포트로 이전했다"));
    assert.ok(created.some(r => r.type === "episode" && r.content.includes("재시작 절차")));
  });
});
