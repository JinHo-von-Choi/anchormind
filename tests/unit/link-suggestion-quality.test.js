/**
 * reflect 연결 제안 품질: 최소 겹침, 동점 처리, 1·2위 격차, 그룹 범위, 그룹당 상한, 점수 산식
 *
 * reflect가 링커에 넘기는 실제 모양({id, content, type, keywords})으로 부른다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { SessionLinker, overlapScore } from "../../lib/memory/link/SessionLinker.js";

const store = { async createLinks() { return []; }, async createLink() {}, async isReachable() { return false; } };
const linker = () => { const l = new SessionLinker(store, null); l.wouldCreateCycle = async () => false; return l; };
const frag = (id, type, keywords, content = `${id} 내용`) => ({ id, type, keywords, content });

describe("overlapScore", () => {
  it("키워드는 소문자로 맞추고 중복을 제거한 집합으로 센다", () => {
    const r = overlapScore({ keywords: ["Nginx", "nginx", "ssl"] }, { keywords: ["NGINX", "NGINX", "db"] });
    assert.deepEqual(r, { score: 0.5, basis: "keyword_overlap" });
  });

  it("한쪽 키워드가 비면 본문 토큰 집합으로 센다", () => {
    const r = overlapScore({ keywords: [], content: "redis cache timeout" }, { keywords: ["x"], content: "redis cache" });
    assert.equal(r.basis, "content_tokens");
    assert.equal(r.score, 1);
  });

  it("교환해도 같은 값이다", () => {
    const a = { keywords: ["a", "b", "c"] }, b = { keywords: ["b", "c", "d", "e"] };
    assert.equal(overlapScore(a, b).score, overlapScore(b, a).score);
  });

  it("빈 입력은 0이다", () => {
    assert.equal(overlapScore({ keywords: [], content: "" }, { keywords: [], content: "" }).score, 0);
  });
});

describe("연결 제안 최소 겹침", () => {
  const e = frag("e1", "error", ["nginx", "ssl", "cert", "chain", "proxy"]);

  it("겹침이 기준 미만이면 제안하지 않고 빈 배열이다", async () => {
    const r = await linker().autoLinkSessionFragments([e, frag("d1", "decision", ["java", "heap"])], "a", null, { minOverlap: 0.4 });
    assert.deepEqual(r.linkSuggestions, []);
    assert.equal(r.linkedCount, 0);
  });

  it("겹침이 기준 이상이면 제안하고 점수와 근거를 싣는다", async () => {
    const d = frag("d1", "decision", ["nginx", "ssl"]);
    const r = await linker().autoLinkSessionFragments([e, d], "a", null, { minOverlap: 0.4 });
    assert.equal(r.linkSuggestions.length, 1);
    const s = r.linkSuggestions[0];
    assert.deepEqual([s.fromId, s.toId, s.relationType, s.reason], ["e1", "d1", "caused_by", "schema_fit_failed"]);
    assert.deepEqual(s.meta, { score: 1, margin: null, signals: ["keyword_overlap"], scoreVersion: "overlap-v2" });
  });

  it("경계: 겹침 0.4는 기준 0.4를 통과하고 기준 0.41은 통과하지 못한다", async () => {
    const five = frag("e5", "error", ["a", "b", "c", "d", "e"]);
    const same = frag("d5", "decision", ["a", "b", "x", "y", "z"]);   // 공통 2 / 5 = 0.4
    const pass = await linker().autoLinkSessionFragments([five, same], "a", null, { minOverlap: 0.4 });
    const fail = await linker().autoLinkSessionFragments([five, same], "a", null, { minOverlap: 0.41 });
    assert.equal(pass.linkSuggestions.length, 1);
    assert.equal(pass.linkSuggestions[0].meta.score, 0.4);
    assert.equal(fail.linkSuggestions.length, 0);
  });

  it("minOverlap 0은 겹침이 없어도 가장 높은 후보를 제안한다(이전 동작)", async () => {
    const r = await linker().autoLinkSessionFragments([e, frag("d1", "decision", ["java"])], "a", null, { minOverlap: 0 });
    assert.equal(r.linkSuggestions.length, 1);
    assert.equal(r.linkSuggestions[0].meta.score, 0);
  });

  it("절차–오류 쌍은 resolved_by로 제안한다", async () => {
    const p = frag("p1", "procedure", ["nginx", "ssl"]);
    const r = await linker().autoLinkSessionFragments([e, p], "a", null, { minOverlap: 0.4 });
    assert.deepEqual([r.linkSuggestions[0].fromId, r.linkSuggestions[0].toId, r.linkSuggestions[0].relationType], ["p1", "e1", "resolved_by"]);
  });

  it("reflect 모양의 파편(caseId, sessionId 없음)은 자동 연결되지 않는다", async () => {
    const r = await linker().autoLinkSessionFragments(
      [e, frag("d1", "decision", ["nginx", "ssl", "cert", "chain", "proxy"])], "a", null, { minOverlap: 0.4 });
    assert.equal(r.linkedCount, 0);
    assert.equal(r.linkSuggestions.length, 1);
  });
});

describe("동점과 격차", () => {
  const e = frag("e1", "error", ["a", "b"]);

  it("동점이면 id가 작은 후보를 고른다(입력 순서와 무관)", async () => {
    const d2 = frag("d2", "decision", ["a", "b"]), d1 = frag("d1", "decision", ["a", "b"]);
    const r1 = await linker().autoLinkSessionFragments([e, d2, d1], "a", null, { minOverlap: 0.4 });
    const r2 = await linker().autoLinkSessionFragments([e, d1, d2], "a", null, { minOverlap: 0.4 });
    assert.equal(r1.linkSuggestions[0].toId, "d1");
    assert.equal(r2.linkSuggestions[0].toId, "d1");
  });

  it("minMargin이 있으면 1위와 2위 차이가 작을 때 제안하지 않는다", async () => {
    const d1 = frag("d1", "decision", ["a", "b"]), d2 = frag("d2", "decision", ["a", "b"]);
    assert.equal((await linker().autoLinkSessionFragments([e, d1, d2], "a", null, { minOverlap: 0.4, minMargin: 0.2 })).linkSuggestions.length, 0);
    const d3 = frag("d3", "decision", ["a", "x"]);
    const r = await linker().autoLinkSessionFragments([e, d1, d3], "a", null, { minOverlap: 0.4, minMargin: 0.2 });
    assert.equal(r.linkSuggestions.length, 1);
    assert.equal(r.linkSuggestions[0].meta.margin, 0.5);
  });

  it("minMargin 0이면 격차를 보지 않는다", async () => {
    const d1 = frag("d1", "decision", ["a", "b"]), d2 = frag("d2", "decision", ["a", "b"]);
    assert.equal((await linker().autoLinkSessionFragments([e, d1, d2], "a", null, { minOverlap: 0.4, minMargin: 0 })).linkSuggestions.length, 1);
  });
});

describe("그룹 범위와 상한", () => {
  it("다른 그룹의 파편과는 짝짓지 않는다", async () => {
    const e = frag("e1", "error", ["a", "b"]), d = frag("d1", "decision", ["a", "b"]);
    const groupOf = new Map([["e1", 0], ["d1", 1]]);
    const r = await linker().autoLinkSessionFragments([e, d], "a", null, { minOverlap: 0.4, groupOf });
    assert.deepEqual(r.linkSuggestions, []);
  });

  it("그룹 정보가 없으면 막지 않는다", async () => {
    const e = frag("e1", "error", ["a", "b"]), d = frag("d1", "decision", ["a", "b"]);
    const r = await linker().autoLinkSessionFragments([e, d], "a", null, { minOverlap: 0.4, groupOf: new Map([["e1", 0]]) });
    assert.equal(r.linkSuggestions.length, 1);
  });

  it("그룹당 상한을 점수 높은 순으로 적용하고 잘린 수를 알려 준다", async () => {
    const frs = [], groupOf = new Map();
    for (let i = 1; i <= 5; i++) {
      frs.push(frag(`e${i}`, "error", ["k", `x${i}`, "y"]), frag(`d${i}`, "decision", ["k", `x${i}`, i <= 3 ? "y" : "z"]));
      groupOf.set(`e${i}`, 0); groupOf.set(`d${i}`, 0);
    }
    // 같은 그룹이라 e마다 최고 후보가 같은 d가 아닌 자기 짝이다. 점수는 e1..e3이 높고 e4, e5가 낮다.
    const r = await linker().autoLinkSessionFragments(frs, "a", null, { minOverlap: 0.4, maxSuggestions: 3, groupOf });
    assert.equal(r.linkSuggestions.length, 3);
    assert.equal(r.linkSuggestionsOmitted, 2);
    assert.ok(r.linkSuggestions.every((s, i, a) => i === 0 || a[i - 1].meta.score >= s.meta.score));
  });

  it("maxSuggestions 0은 제한하지 않는다", async () => {
    const frs = [];
    for (let i = 1; i <= 5; i++) frs.push(frag(`e${i}`, "error", ["k", `x${i}`]), frag(`d${i}`, "decision", ["k", `x${i}`]));
    const r = await linker().autoLinkSessionFragments(frs, "a", null, { minOverlap: 0.4, maxSuggestions: 0 });
    assert.equal(r.linkSuggestions.length, 5);
    assert.equal(r.linkSuggestionsOmitted, 0);
  });
});
