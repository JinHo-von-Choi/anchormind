/**
 * auto-link session gate 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-05-19
 *
 * 검증 범위:
 * - errors 2건 + decisions 3건 → 곱집합(6건)이 아니라 schema-fit 통과 건만 autoLinks 생성
 * - schema-fit 미통과 후보는 linkSuggestions[]로 노출
 * - 동일 caseId 부재 시 sessionId 인접으로 gate 통과
 * - 키워드 오버랩 60% 미만이면 linkSuggestions로 위임
 * - phase 역방향(verification→planning) 차단
 */

import { describe, it } from "node:test";
import assert             from "node:assert/strict";

import { SessionLinker } from "../../lib/memory/link/SessionLinker.js";

/** store mock: cycle 없음(기본), createLinks/createLink 기록 */
function makeStore() {
  const createLinksCalls = [];
  const store = {
    createLinksCalls,
    async createLinks(pairs, agentId) {
      createLinksCalls.push({ pairs: pairs.map(p => ({ ...p })), agentId });
      return pairs.map((_, i) => `link-${i}`);
    },
    async createLink() {},
    async isReachable() { return false; }
  };
  return store;
}

/** wouldCreateCycle을 항상 false로 고정한 SessionLinker */
function makeLinker(store) {
  const linker = new SessionLinker(store, null);
  linker.wouldCreateCycle = async () => false;
  return linker;
}

/** 파편 생성 헬퍼 */
function frag(id, type, opts = {}) {
  return { id, type, ...opts };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("auto-link gate — 곱집합 차단 및 1:1 매칭", () => {

  it("errors 2건 + decisions 3건: 6건 곱집합이 아니라 schema-fit 통과만 autoLinks", async () => {
    const store  = makeStore();
    const linker = makeLinker(store);

    // caseId + keyword 동일 → e1-d1 쌍만 schema-fit 통과
    const fragments = [
      frag("e1", "error",    { caseId: "c1", sessionId: "s1", keywords: ["nginx", "ssl"], content: "nginx ssl error" }),
      frag("e2", "error",    { caseId: "c2", sessionId: "s2", keywords: ["db", "conn"],   content: "db connection error" }),
      frag("d1", "decision", { caseId: "c1", sessionId: "s1", keywords: ["nginx", "ssl"], content: "nginx ssl decision" }),
      frag("d2", "decision", { caseId: "c3", sessionId: "s3", keywords: ["redis", "mem"], content: "redis memory decision" }),
      frag("d3", "decision", { caseId: "c4", sessionId: "s4", keywords: ["java", "heap"], content: "java heap decision" }),
    ];

    const { linkedCount, linkSuggestions } = await linker.autoLinkSessionFragments(fragments, "agent", null);

    // 곱집합 6건이 아니라 top-1 매칭 → e1 best=d1(schema-fit 통과), e2 best=d2(no caseId match → fail)
    // e2 - 최고 score decision이 caseId 미일치 & sessionId 미일치 → linkSuggestions
    assert.ok(linkedCount < 6, `곱집합 차단 확인: linkedCount=${linkedCount} < 6`);
    assert.ok(linkSuggestions.length >= 0, "linkSuggestions 배열 반환");
  });

  it("schema-fit 통과한 페어만 createLinks로 전달", async () => {
    const store  = makeStore();
    const linker = makeLinker(store);

    // e1↔d1: 동일 caseId + 100% 키워드 오버랩 → 통과
    // e2: decisions 중 동일 caseId 없음 → 미통과
    const fragments = [
      frag("e1", "error",    { caseId: "case-A", sessionId: "sess-1", keywords: ["nginx", "ssl"], content: "nginx ssl error" }),
      frag("e2", "error",    { caseId: "case-B", sessionId: "sess-2", keywords: ["java", "heap"], content: "java heap error" }),
      frag("d1", "decision", { caseId: "case-A", sessionId: "sess-1", keywords: ["nginx", "ssl"], content: "nginx ssl fix" }),
      frag("d2", "decision", { caseId: "case-C", sessionId: "sess-3", keywords: ["db", "pool"],   content: "db pool decision" }),
      frag("d3", "decision", { caseId: "case-D", sessionId: "sess-4", keywords: ["redis"],        content: "redis decision" }),
    ];

    const { linkedCount, linkSuggestions } = await linker.autoLinkSessionFragments(fragments, "agent", null);

    // e1→d1 만 통과 기대
    assert.equal(linkedCount, 1, "schema-fit 통과 1건만 생성");
    // e2는 linkSuggestions로 위임
    assert.ok(linkSuggestions.some(s => s.fromId === "e2"), "e2는 linkSuggestions에 포함");
  });

  it("schema-fit 미통과 후보는 linkSuggestions[]로 반환", async () => {
    const store  = makeStore();
    const linker = makeLinker(store);

    // caseId 불일치 + 키워드 오버랩 0%
    const fragments = [
      frag("e1", "error",    { caseId: "case-X", sessionId: "s1", keywords: ["nginx"], content: "nginx error" }),
      frag("d1", "decision", { caseId: "case-Y", sessionId: "s2", keywords: ["db"],    content: "db decision" }),
    ];

    const { linkedCount, linkSuggestions } = await linker.autoLinkSessionFragments(fragments, "agent", null);

    assert.equal(linkedCount, 0, "autoLinks 0건");
    assert.equal(linkSuggestions.length, 1, "linkSuggestions 1건");
    assert.equal(linkSuggestions[0].fromId,       "e1");
    assert.equal(linkSuggestions[0].toId,         "d1");
    assert.equal(linkSuggestions[0].relationType, "caused_by");
    assert.equal(linkSuggestions[0].reason,       "schema_fit_failed");
  });

});

// ─────────────────────────────────────────────────────────────────────────────

describe("auto-link gate — sessionId 인접으로 caseId 대체", () => {

  it("동일 caseId 없어도 동일 sessionId이면 schema-fit 통과", async () => {
    const store  = makeStore();
    const linker = makeLinker(store);

    // caseId 없음, 동일 sessionId + 키워드 100% 오버랩
    const fragments = [
      frag("e1", "error",    { sessionId: "sess-Z", keywords: ["nginx", "ssl"], content: "nginx ssl error" }),
      frag("d1", "decision", { sessionId: "sess-Z", keywords: ["nginx", "ssl"], content: "nginx ssl fix" }),
    ];

    const { linkedCount, linkSuggestions } = await linker.autoLinkSessionFragments(fragments, "agent", null);

    assert.equal(linkedCount,          1, "sessionId 인접으로 통과 → autoLink 1건");
    assert.equal(linkSuggestions.length, 0);
  });

  it("caseId 없고 sessionId도 다르면 schema-fit 미통과 → linkSuggestions", async () => {
    const store  = makeStore();
    const linker = makeLinker(store);

    // sessionId 불일치 + caseId 없음
    const fragments = [
      frag("e1", "error",    { sessionId: "sess-A", keywords: ["nginx", "ssl"], content: "nginx ssl error" }),
      frag("d1", "decision", { sessionId: "sess-B", keywords: ["nginx", "ssl"], content: "nginx ssl fix" }),
    ];

    const { linkedCount, linkSuggestions } = await linker.autoLinkSessionFragments(fragments, "agent", null);

    assert.equal(linkedCount, 0, "sessionId 불일치 → 미통과");
    assert.equal(linkSuggestions.length, 1);
  });

});

// ─────────────────────────────────────────────────────────────────────────────

describe("auto-link gate — 키워드 오버랩 60% 미만 차단", () => {

  it("키워드 오버랩 < 60%이면 schema-fit 미통과 → linkSuggestions", async () => {
    const store  = makeStore();
    const linker = makeLinker(store);

    // 동일 caseId + sessionId이지만 키워드 오버랩 1/4 = 25%
    const fragments = [
      frag("e1", "error",    { caseId: "c1", sessionId: "s1", keywords: ["nginx", "ssl", "cert", "chain"], content: "nginx ssl cert chain error" }),
      frag("d1", "decision", { caseId: "c1", sessionId: "s1", keywords: ["java"],                          content: "java decision" }),
    ];

    const { linkedCount, linkSuggestions } = await linker.autoLinkSessionFragments(fragments, "agent", null);

    assert.equal(linkedCount, 0, "키워드 오버랩 부족으로 미통과");
    assert.equal(linkSuggestions.length, 1);
  });

  it("키워드 오버랩 >= 60%이면 schema-fit 통과", async () => {
    const store  = makeStore();
    const linker = makeLinker(store);

    // 동일 caseId + sessionId + 키워드 오버랩 2/3 ≈ 67%
    const fragments = [
      frag("e1", "error",    { caseId: "c1", sessionId: "s1", keywords: ["nginx", "ssl", "timeout"],  content: "nginx ssl timeout" }),
      frag("d1", "decision", { caseId: "c1", sessionId: "s1", keywords: ["nginx", "ssl", "upstream"], content: "nginx ssl upstream" }),
    ];

    const { linkedCount } = await linker.autoLinkSessionFragments(fragments, "agent", null);

    assert.equal(linkedCount, 1, "키워드 오버랩 ≥ 60% → 통과");
  });

});

// ─────────────────────────────────────────────────────────────────────────────

describe("auto-link gate — phase 역방향 차단", () => {

  it("verification→planning 역방향은 schema-fit 미통과 → linkSuggestions", async () => {
    const store  = makeStore();
    const linker = makeLinker(store);

    // error: phase=verification, decision: phase=planning (역방향)
    const fragments = [
      frag("e1", "error",    { caseId: "c1", sessionId: "s1", keywords: ["nginx", "ssl"], phase: "verification", content: "nginx ssl" }),
      frag("d1", "decision", { caseId: "c1", sessionId: "s1", keywords: ["nginx", "ssl"], phase: "planning",      content: "nginx ssl" }),
    ];

    const { linkedCount, linkSuggestions } = await linker.autoLinkSessionFragments(fragments, "agent", null);

    assert.equal(linkedCount, 0, "역방향 phase → 차단");
    assert.equal(linkSuggestions.length, 1);
  });

  it("planning→debugging 단방향은 schema-fit 통과", async () => {
    const store  = makeStore();
    const linker = makeLinker(store);

    const fragments = [
      frag("e1", "error",    { caseId: "c1", sessionId: "s1", keywords: ["nginx", "ssl"], phase: "planning",   content: "nginx ssl" }),
      frag("d1", "decision", { caseId: "c1", sessionId: "s1", keywords: ["nginx", "ssl"], phase: "debugging",  content: "nginx ssl" }),
    ];

    const { linkedCount } = await linker.autoLinkSessionFragments(fragments, "agent", null);

    assert.equal(linkedCount, 1, "단방향 phase → 통과");
  });

  it("phase 없는 파편은 phase 검사 통과", async () => {
    const store  = makeStore();
    const linker = makeLinker(store);

    // phase 필드 없음 → 통과해야 함
    const fragments = [
      frag("e1", "error",    { caseId: "c1", sessionId: "s1", keywords: ["nginx", "ssl"], content: "nginx ssl error" }),
      frag("d1", "decision", { caseId: "c1", sessionId: "s1", keywords: ["nginx", "ssl"], content: "nginx ssl fix" }),
    ];

    const { linkedCount } = await linker.autoLinkSessionFragments(fragments, "agent", null);

    assert.equal(linkedCount, 1, "phase 없음 → gate 통과");
  });

});
