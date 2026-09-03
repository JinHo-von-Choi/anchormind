/**
 * SearchScope contract 회귀 가드
 *
 * 작성자: 최진호
 * 작성일: 2026-05-13
 *
 * 정적 가드: _executeSearch 후처리 필터 4블록 잔존 0 검증.
 * 모듈 계약: SearchScope가 lib/memory/read에 존재하고 applyTo/fromQuery가 export됨.
 * applyTo 동작: 각 scope 조건 별 통과/차단 시나리오.
 */

import { describe, it }  from "node:test";
import assert             from "node:assert/strict";
import { readFileSync }   from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath }  from "node:url";

import { SearchScope }    from "../../lib/memory/read/SearchScope.js";

const __dirname    = dirname(fileURLToPath(import.meta.url));
const FRAGMENT_SRC = readFileSync(
  resolve(__dirname, "../../lib/memory/read/FragmentSearch.js"),
  "utf8"
);

/** ─── 정적 가드 ────────────────────────────────────────────────────────── */

describe("_executeSearch 후처리 필터 4블록 잔존 검사", () => {

  it("workspace 후처리 combined.filter(f => f.workspace 패턴이 없어야 한다", () => {
    const found = /combined\.filter\(f\s*=>\s*f\.workspace/.test(FRAGMENT_SRC);
    assert.strictEqual(found, false, "_executeSearch에 workspace combined.filter 잔존");
  });

  it("case_id 후처리 combined.filter(f => f.case_id 패턴이 없어야 한다", () => {
    const found = /combined\.filter\(f\s*=>\s*f\.case_id/.test(FRAGMENT_SRC);
    assert.strictEqual(found, false, "_executeSearch에 case_id combined.filter 잔존");
  });

  it("resolution_status 후처리 combined.filter(f => f.resolution_status 패턴이 없어야 한다", () => {
    const found = /combined\.filter\(f\s*=>\s*f\.resolution_status/.test(FRAGMENT_SRC);
    assert.strictEqual(found, false, "_executeSearch에 resolution_status combined.filter 잔존");
  });

  it("phase 후처리 combined.filter(f => f.phase 패턴이 없어야 한다", () => {
    const found = /combined\.filter\(f\s*=>\s*f\.phase/.test(FRAGMENT_SRC);
    assert.strictEqual(found, false, "_executeSearch에 phase combined.filter 잔존");
  });

  it("affect 후처리 affectSet.has(f.affect) combined.filter 패턴이 없어야 한다", () => {
    const found = /combined\.filter\(f\s*=>\s*affectSet\.has\(f\.affect\)/.test(FRAGMENT_SRC);
    assert.strictEqual(found, false, "_executeSearch에 affectSet combined.filter 잔존");
  });
});

/** ─── 모듈 계약 ────────────────────────────────────────────────────────── */

describe("SearchScope 모듈 계약", () => {

  it("SearchScope 클래스가 export되어야 한다", () => {
    assert.ok(typeof SearchScope === "function", "SearchScope가 함수(class)가 아님");
  });

  it("SearchScope 인스턴스가 applyTo 메서드를 가져야 한다", () => {
    const scope = new SearchScope({});
    assert.ok(typeof scope.applyTo === "function", "applyTo 메서드 없음");
  });

  it("SearchScope.fromQuery 정적 팩토리가 존재해야 한다", () => {
    assert.ok(typeof SearchScope.fromQuery === "function", "fromQuery 정적 메서드 없음");
  });

  it("fromQuery가 정규화된 sq에서 SearchScope를 생성해야 한다", () => {
    const sq    = { workspace: "ws-1", caseId: "case-abc", resolutionStatus: "open", phase: "debugging", affect: "frustration", keyId: "key-x" };
    const scope = SearchScope.fromQuery(sq);
    assert.ok(scope instanceof SearchScope);
    assert.strictEqual(scope.workspace, "ws-1");
    assert.strictEqual(scope.caseId, "case-abc");
    assert.strictEqual(scope.resolutionStatus, "open");
    assert.strictEqual(scope.phase, "debugging");
    assert.ok(scope.affectSet instanceof Set);
    assert.ok(scope.affectSet.has("frustration"));
  });
});

/** ─── applyTo 동작 검증 ─────────────────────────────────────────────── */

describe("SearchScope.applyTo", () => {

  function makeFragment(overrides = {}) {
    return {
      id                : "frag-1",
      workspace         : null,
      case_id           : null,
      resolution_status : null,
      phase             : null,
      affect            : "neutral",
      content           : "test",
      ...overrides
    };
  }

  it("빈 scope는 전역(NULL) fragment만 통과시켜야 한다", () => {
    const scope = new SearchScope({});
    assert.strictEqual(scope.isNoop(), false);
    assert.strictEqual(scope.applyTo(makeFragment()), true);
    assert.strictEqual(scope.applyTo(makeFragment({ workspace: "any", case_id: "x" })), false);
  });

  it("null fragment는 false를 반환해야 한다", () => {
    const scope = new SearchScope({});
    assert.strictEqual(scope.applyTo(null), false);
    assert.strictEqual(scope.applyTo(undefined), false);
  });

  describe("workspace 필터", () => {
    it("scope.workspace가 null이면 전역만 통과시킨다", () => {
      const scope = new SearchScope({ workspace: null });
      assert.strictEqual(scope.applyTo(makeFragment({ workspace: "ws-A" })), false);
      assert.strictEqual(scope.applyTo(makeFragment({ workspace: null })), true);
    });

    it("allWorkspaces=true일 때만 모든 workspace를 통과시킨다", () => {
      const scope = new SearchScope({ allWorkspaces: true });
      assert.strictEqual(scope.isNoop(), true);
      assert.strictEqual(scope.applyTo(makeFragment({ workspace: "ws-A" })), true);
      assert.strictEqual(scope.applyTo(makeFragment({ workspace: "ws-B" })), true);
      assert.strictEqual(scope.applyTo(makeFragment({ workspace: null })), true);
    });

    it("scope.workspace가 지정되면 일치하거나 null인 fragment만 통과시킨다", () => {
      const scope = new SearchScope({ workspace: "ws-A" });
      assert.strictEqual(scope.applyTo(makeFragment({ workspace: "ws-A" })), true);
      assert.strictEqual(scope.applyTo(makeFragment({ workspace: null })), true);
      assert.strictEqual(scope.applyTo(makeFragment({ workspace: "ws-B" })), false);
    });
  });

  describe("caseId 필터", () => {
    it("scope.caseId가 undefined이면 모든 case_id를 통과시킨다", () => {
      const scope = new SearchScope({ allWorkspaces: true });
      assert.strictEqual(scope.applyTo(makeFragment({ case_id: "any" })), true);
    });

    it("scope.caseId가 지정되면 일치하는 fragment만 통과시킨다", () => {
      const scope = new SearchScope({ caseId: "case-42" });
      assert.strictEqual(scope.applyTo(makeFragment({ case_id: "case-42" })), true);
      assert.strictEqual(scope.applyTo(makeFragment({ case_id: "case-99" })), false);
      assert.strictEqual(scope.applyTo(makeFragment({ case_id: null })), false);
    });
  });

  describe("resolutionStatus 필터", () => {
    it("scope.resolutionStatus 지정 시 일치하는 fragment만 통과시킨다", () => {
      const scope = new SearchScope({ resolutionStatus: "resolved" });
      assert.strictEqual(scope.applyTo(makeFragment({ resolution_status: "resolved" })), true);
      assert.strictEqual(scope.applyTo(makeFragment({ resolution_status: "open" })), false);
      assert.strictEqual(scope.applyTo(makeFragment({ resolution_status: null })), false);
    });
  });

  describe("phase 필터", () => {
    it("scope.phase 지정 시 일치하는 fragment만 통과시킨다", () => {
      const scope = new SearchScope({ phase: "debugging" });
      assert.strictEqual(scope.applyTo(makeFragment({ phase: "debugging" })), true);
      assert.strictEqual(scope.applyTo(makeFragment({ phase: "planning" })), false);
      assert.strictEqual(scope.applyTo(makeFragment({ phase: null })), false);
    });
  });

  describe("affect 필터", () => {
    it("scope.affect가 문자열이면 단일 값으로 필터링한다", () => {
      const scope = new SearchScope({ affect: "frustration" });
      assert.strictEqual(scope.applyTo(makeFragment({ affect: "frustration" })), true);
      assert.strictEqual(scope.applyTo(makeFragment({ affect: "neutral" })), false);
      assert.strictEqual(scope.applyTo(makeFragment({ affect: null })), false);
    });

    it("scope.affect가 배열이면 집합 필터링한다", () => {
      const scope = new SearchScope({ affect: ["frustration", "confidence"] });
      assert.strictEqual(scope.applyTo(makeFragment({ affect: "frustration" })), true);
      assert.strictEqual(scope.applyTo(makeFragment({ affect: "confidence" })), true);
      assert.strictEqual(scope.applyTo(makeFragment({ affect: "neutral" })), false);
    });

    it("scope.affect가 미지정이면 모든 affect를 통과시킨다", () => {
      const scope = new SearchScope({ allWorkspaces: true });
      assert.strictEqual(scope.applyTo(makeFragment({ affect: "frustration" })), true);
      assert.strictEqual(scope.applyTo(makeFragment({ affect: null })), true);
    });
  });

  describe("복합 조건", () => {
    it("여러 조건이 모두 일치해야 통과한다", () => {
      const scope = new SearchScope({ workspace: "ws-A", caseId: "case-1", affect: "confidence" });
      const passing = makeFragment({ workspace: "ws-A", case_id: "case-1", affect: "confidence" });
      const failing = makeFragment({ workspace: "ws-A", case_id: "case-1", affect: "neutral" });
      assert.strictEqual(scope.applyTo(passing), true);
      assert.strictEqual(scope.applyTo(failing), false);
    });

    it("workspace=null(전역 fragment)는 workspace 조건이 있어도 통과한다", () => {
      const scope   = new SearchScope({ workspace: "ws-A", caseId: "case-1" });
      const globalF = makeFragment({ workspace: null, case_id: "case-1" });
      assert.strictEqual(scope.applyTo(globalF), true);
    });
  });
});
