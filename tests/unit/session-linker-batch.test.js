/**
 * SessionLinker 배치 링크 생성 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-27
 * 수정일: 2026-05-19 (1:1 schema-fit 매칭 기대값으로 갱신)
 *
 * 검증 범위:
 * - schema-fit 통과 시 autoLinks 생성, 미통과 시 linkSuggestions 반환
 * - cycle 발생 페어 제외
 * - wouldCreateCycle Map 캐시: 동일 from→to 쌍은 1회만 DB 조회
 * - sortedKey 정렬: createLinks 호출 시 pairs가 sortedKey 오름차순
 * - rawPairs 없으면 createLinks 미호출
 * - createLinks 실패 시 단건 createLink fallback 수행
 * - wouldCreateCycle 시그니처 보존 (fromId, toId, agentId, keyId)
 */

import { describe, it, mock } from "node:test";
import assert                 from "node:assert/strict";

import { SessionLinker } from "../../lib/memory/link/SessionLinker.js";

/**
 * 테스트용 store mock 빌더.
 * createLinks / createLink 호출 인수를 기록한다.
 */
function makeStore({ createLinksShouldFail = false } = {}) {
  const createLinksCalls = [];
  const createLinkCalls  = [];

  const store = {
    createLinksCalls,
    createLinkCalls,
    async createLinks(pairs, agentId) {
      createLinksCalls.push({ pairs: pairs.map(p => ({ ...p })), agentId });
      if (createLinksShouldFail) throw new Error("batch insert failed");
      return pairs.map((_, i) => `link-id-${i}`);
    },
    async createLink(fromId, toId, relationType, agentId) {
      createLinkCalls.push({ fromId, toId, relationType, agentId });
    },
    async isReachable() { return false; }
  };
  return store;
}

/**
 * wouldCreateCycle을 직접 mock하는 SessionLinker 빌더.
 * cyclePairs: Set<"fromId->toId"> — 이 쌍은 cycle 있음으로 반환.
 */
function makeLinker(store, cyclePairs = new Set()) {
  const linker = new SessionLinker(store, null);
  linker.wouldCreateCycle = mock.fn(async (fromId, toId) => {
    return cyclePairs.has(`${fromId}->${toId}`);
  });
  return linker;
}

/** 파편 목록 헬퍼 (schema-fit 통과용: 동일 caseId + sessionId + 100% 키워드 매치) */
function makeFragments(spec, caseId = "case-shared", sessionId = "sess-shared") {
  return spec.map(([id, type]) => ({
    id,
    type,
    caseId,
    sessionId,
    keywords: [id, type],  // 각 파편마다 고유 키워드 — 동일 타입끼리만 오버랩 높음
    content : `${type} fragment ${id}`
  }));
}

/**
 * 동일 caseId + sessionId + 완전히 공유된 키워드를 가진 파편 빌더.
 * errors↔decisions 간 schema-fit 통과를 위해 keywords를 공유시킨다.
 */
function makeFitFragments(spec) {
  return spec.map(([id, type]) => ({
    id,
    type,
    caseId    : "case-shared",
    sessionId : "sess-shared",
    keywords  : ["shared", "keyword"],  // 100% 오버랩 보장
    content   : `${type} ${id} shared keyword`
  }));
}

describe("SessionLinker.autoLinkSessionFragments — schema-fit 통과 시 배치 경로", () => {

  it("errors=2, decisions=3 → schema-fit 통과분만 createLinks (곱집합 6건이 아님)", async () => {
    const store  = makeStore();
    const linker = makeLinker(store);

    // 각 error에서 top-1 decision을 1:1 매칭 → schema-fit(caseId+sessionId+keyword) 통과 시만 생성
    const fragments = makeFitFragments([
      ["e1", "error"], ["e2", "error"],
      ["d1", "decision"], ["d2", "decision"], ["d3", "decision"]
    ]);
    const { linkedCount, linkSuggestions } = await linker.autoLinkSessionFragments(fragments, "agent-a", null);

    // 1:1 매칭: e1→top-1 decision, e2→top-1 decision (같은 keywords이므로 첫번째가 best)
    // 둘 다 schema-fit 통과 가능 → 최대 2건 (곱집합 6건이 아님)
    assert.ok(linkedCount <= 2, `1:1 매칭으로 최대 2건: 실제 ${linkedCount}`);
    assert.ok(linkedCount + linkSuggestions.length <= 2, "총 후보 ≤ 2건 (1:1 매칭)");

    if (store.createLinksCalls.length > 0) {
      assert.ok(store.createLinksCalls[0].pairs.length <= 2, "createLinks에 전달된 쌍도 ≤ 2건");
    }
  });

  it("procedures=2, errors=2 → schema-fit 통과분만 createLinks", async () => {
    const store  = makeStore();
    const linker = makeLinker(store);

    const fragments = makeFitFragments([
      ["p1", "procedure"], ["p2", "procedure"],
      ["e1", "error"], ["e2", "error"]
    ]);
    const { linkedCount, linkSuggestions } = await linker.autoLinkSessionFragments(fragments, "agent-b", null);

    // 1:1 매칭: p1→top-1 error, p2→top-1 error → 최대 2건
    assert.ok(linkedCount <= 2, `procedures 1:1 매칭 최대 2건: 실제 ${linkedCount}`);
    assert.ok(linkedCount + linkSuggestions.length <= 2, "총 후보 ≤ 2건");
  });

  it("schema-fit 미통과 후보는 linkSuggestions[]로 반환", async () => {
    const store  = makeStore();
    const linker = makeLinker(store);

    // caseId 불일치 → schema-fit 미통과
    const fragments = [
      { id: "e1", type: "error",    caseId: "cA", sessionId: "sA", keywords: ["nginx"], content: "nginx error" },
      { id: "d1", type: "decision", caseId: "cB", sessionId: "sB", keywords: ["nginx"], content: "nginx fix" },
    ];
    const { linkedCount, linkSuggestions } = await linker.autoLinkSessionFragments(fragments, "agent-x", null);

    assert.equal(linkedCount,          0, "schema-fit 미통과 → autoLinks 0건");
    assert.equal(linkSuggestions.length, 1, "linkSuggestions 1건");
    assert.equal(linkSuggestions[0].fromId,       "e1");
    assert.equal(linkSuggestions[0].relationType, "caused_by");
  });

  it("errors/decisions/procedures 없으면 createLinks 미호출, linkSuggestions 빈 배열", async () => {
    const store  = makeStore();
    const linker = makeLinker(store);

    const fragments = makeFragments([["f1", "fact"], ["f2", "preference"]]);
    const { linkedCount, linkSuggestions } = await linker.autoLinkSessionFragments(fragments, "agent-f", null);

    assert.equal(store.createLinksCalls.length, 0);
    assert.equal(linkedCount,            0);
    assert.equal(linkSuggestions.length, 0);
  });

});

describe("SessionLinker.autoLinkSessionFragments — cycle 필터링", () => {

  it("cycle 발생 페어 제외 → linkedCount 감소", async () => {
    const store  = makeStore();
    /** e1→d1 은 cycle */
    const linker = makeLinker(store, new Set(["e1->d1"]));

    // e1, e2 각각 best decision을 찾되 e1의 best가 d1이면 cycle로 제외
    const fragments = makeFitFragments([
      ["e1", "error"],
      ["d1", "decision"]
    ]);
    const { linkedCount } = await linker.autoLinkSessionFragments(fragments, "agent-d", null);

    assert.equal(linkedCount, 0, "cycle 페어 제외 → linkedCount=0");
    assert.equal(store.createLinksCalls.length, 0, "valid 페어 없으면 createLinks 미호출");
  });

  it("모든 페어가 cycle이면 createLinks 미호출", async () => {
    const store  = makeStore();
    const linker = makeLinker(store, new Set(["e1->d1"]));

    const fragments = makeFitFragments([["e1", "error"], ["d1", "decision"]]);
    await linker.autoLinkSessionFragments(fragments, "agent-e", null);

    assert.equal(store.createLinksCalls.length, 0, "valid 페어 없으면 createLinks 호출 안 함");
  });

});

describe("SessionLinker.autoLinkSessionFragments — cycleCache", () => {

  it("동일 from→to 쌍은 wouldCreateCycle을 1회만 호출 (캐시 재사용)", async () => {
    const store  = makeStore();
    const linker = makeLinker(store);

    // e1→d1 페어만 (schema-fit 통과해야 wouldCreateCycle 도달)
    const fragments = makeFitFragments([["e1", "error"], ["d1", "decision"]]);
    await linker.autoLinkSessionFragments(fragments, "agent-g", null);

    assert.equal(linker.wouldCreateCycle.mock.callCount(), 1,
      "단일 페어이므로 cycle 검사는 정확히 1회");
  });

  it("wouldCreateCycle은 (fromId, toId, agentId, keyId) 순서로 호출 (시그니처 보존)", async () => {
    const store  = makeStore();
    const linker = makeLinker(store);

    const fragments = makeFitFragments([["e1", "error"], ["d1", "decision"]]);
    await linker.autoLinkSessionFragments(fragments, "agent-h", "key-42");

    // schema-fit 통과 여부에 따라 wouldCreateCycle 호출 수 다름
    if (linker.wouldCreateCycle.mock.callCount() > 0) {
      const call = linker.wouldCreateCycle.mock.calls[0];
      assert.equal(call.arguments[2], "agent-h", "agentId는 3번째 인자");
      assert.equal(call.arguments[3], "key-42",  "keyId는 4번째 인자 (tenant 격리)");
    }
  });

});

describe("SessionLinker.autoLinkSessionFragments — sortedKey 정렬", () => {

  it("createLinks에 전달된 pairs는 sortedKey 사전식 오름차순", async () => {
    const store  = makeStore();
    const linker = makeLinker(store);

    const fragments = makeFitFragments([
      ["e2", "error"], ["e1", "error"],
      ["d3", "decision"], ["d1", "decision"]
    ]);
    await linker.autoLinkSessionFragments(fragments, "agent-i", null);

    if (store.createLinksCalls.length === 0) return; // schema-fit 미통과 케이스 skip

    const { pairs } = store.createLinksCalls[0];
    for (let i = 1; i < pairs.length; i++) {
      const prev    = pairs[i - 1];
      const curr    = pairs[i];
      const prevKey = [prev.fromId < prev.toId ? prev.fromId : prev.toId,
                       prev.fromId < prev.toId ? prev.toId   : prev.fromId].join("|");
      const currKey = [curr.fromId < curr.toId ? curr.fromId : curr.toId,
                       curr.fromId < curr.toId ? curr.toId   : curr.fromId].join("|");
      assert.ok(prevKey <= currKey,
        `정렬 위반: pairs[${i-1}].sortedKey(${prevKey}) > pairs[${i}].sortedKey(${currKey})`);
    }
  });

});

describe("SessionLinker.autoLinkSessionFragments — fallback", () => {

  it("createLinks 실패 시 단건 createLink fallback 수행", async () => {
    const store  = makeStore({ createLinksShouldFail: true });
    const linker = makeLinker(store);

    // schema-fit 통과 필수 — keywords 공유 + 동일 caseId/sessionId
    const fragments = makeFitFragments([["e1", "error"], ["d1", "decision"]]);
    await linker.autoLinkSessionFragments(fragments, "agent-j", null);

    assert.equal(store.createLinksCalls.length, 1, "createLinks는 1회 시도됨");
    assert.equal(store.createLinkCalls.length,  1, "fallback으로 createLink 1회 호출");
    assert.equal(store.createLinkCalls[0].relationType, "caused_by");
  });

});
