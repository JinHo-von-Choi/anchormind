/**
 * PolicyRules — Phase 4 Soft Gating 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * 6개 predicate 독립 검증:
 * 1. decisionHasRationale
 * 2. errorHasResolutionPath
 * 3. procedureHasStepMarkers
 * 4. caseIdHasResolutionStatus
 * 5. assertionNotContradictory
 * 6. fragmentHasWorkspace
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { PolicyRules } from "../../../lib/symbolic/PolicyRules.js";

describe("PolicyRules.check — decisionHasRationale", () => {

  const rules = new PolicyRules();

  it("decision + linked_to 2건 이상 → 위반 없음", () => {
    const v = rules.check({
      type     : "decision",
      content  : "사용자 인증 방식을 OAuth2로 변경",
      linked_to: ["a", "b"]
    });
    assert.equal(v.filter(x => x.rule === "decisionHasRationale").length, 0);
  });

  it("decision + linked_to 1건 + 근거 키워드 없음 → 위반", () => {
    const v = rules.check({
      type     : "decision",
      content  : "OAuth2로 전환",
      linked_to: ["a"]
    });
    const m = v.find(x => x.rule === "decisionHasRationale");
    assert.ok(m, "decisionHasRationale 위반 필수");
    assert.equal(m.severity, "medium");
  });

  it("decision + linked_to 없음 + '근거' 키워드 있음 → 위반 없음", () => {
    const v = rules.check({
      type   : "decision",
      content: "OAuth2로 전환한다. 근거는 보안 강화."
    });
    assert.equal(v.filter(x => x.rule === "decisionHasRationale").length, 0);
  });

  it("decision + 'because' 키워드 있음 → 위반 없음", () => {
    const v = rules.check({
      type   : "decision",
      content: "Switch to OAuth2 because of security requirements"
    });
    assert.equal(v.filter(x => x.rule === "decisionHasRationale").length, 0);
  });

});

describe("PolicyRules.check — errorHasResolutionPath", () => {

  const rules = new PolicyRules();

  it("error + '원인' 키워드 → 위반 없음", () => {
    const v = rules.check({
      type   : "error",
      content: "DB 연결 실패. 원인은 네트워크 타임아웃."
    });
    assert.equal(v.filter(x => x.rule === "errorHasResolutionPath").length, 0);
  });

  it("error + 'cause' 키워드 → 위반 없음", () => {
    const v = rules.check({
      type   : "error",
      content: "Connection refused; root cause under investigation"
    });
    assert.equal(v.filter(x => x.rule === "errorHasResolutionPath").length, 0);
  });

  it("error + resolution_status 있음 → 위반 없음", () => {
    const v = rules.check({
      type             : "error",
      content          : "잘못된 입력",
      resolution_status: "resolved"
    });
    assert.equal(v.filter(x => x.rule === "errorHasResolutionPath").length, 0);
  });

  it("error + 키워드 없음 + resolution_status 없음 → 위반", () => {
    const v = rules.check({
      type   : "error",
      content: "이상한 에러 발생"
    });
    const m = v.find(x => x.rule === "errorHasResolutionPath");
    assert.ok(m);
    assert.equal(m.severity, "low");
  });

});

describe("PolicyRules.check — procedureHasStepMarkers", () => {

  const rules = new PolicyRules();

  it("procedure + '1.' 마커 → 위반 없음", () => {
    const v = rules.check({
      type   : "procedure",
      content: "1. npm install\n2. npm test"
    });
    assert.equal(v.filter(x => x.rule === "procedureHasStepMarkers").length, 0);
  });

  it("procedure + '단계' 키워드 → 위반 없음", () => {
    const v = rules.check({
      type   : "procedure",
      content: "배포 단계를 순서대로 수행한다"
    });
    assert.equal(v.filter(x => x.rule === "procedureHasStepMarkers").length, 0);
  });

  it("procedure + bullet 마커 → 위반 없음", () => {
    const v = rules.check({
      type   : "procedure",
      content: "설치 절차:\n - 의존성 설치\n - 환경변수 설정"
    });
    assert.equal(v.filter(x => x.rule === "procedureHasStepMarkers").length, 0);
  });

  it("procedure + 마커 없음 → 위반", () => {
    const v = rules.check({
      type   : "procedure",
      content: "그냥 배포하면 됩니다"
    });
    const m = v.find(x => x.rule === "procedureHasStepMarkers");
    assert.ok(m);
    assert.equal(m.severity, "low");
  });

});

describe("PolicyRules.check — caseIdHasResolutionStatus", () => {

  const rules = new PolicyRules();

  it("case_id + resolution_status 있음 → 위반 없음", () => {
    const v = rules.check({
      type             : "error",
      content          : "에러 발생 원인 파악",
      case_id          : "case-1",
      resolution_status: "open"
    });
    assert.equal(v.filter(x => x.rule === "caseIdHasResolutionStatus").length, 0);
  });

  it("case_id 있음 + resolution_status 없음 → 위반", () => {
    const v = rules.check({
      type   : "error",
      content: "에러 발생 원인 파악",
      case_id: "case-1"
    });
    const m = v.find(x => x.rule === "caseIdHasResolutionStatus");
    assert.ok(m);
    assert.equal(m.severity, "medium");
  });

  it("case_id 없음 → 해당 rule 관계 없음", () => {
    const v = rules.check({
      type   : "error",
      content: "에러 발생 원인 파악"
    });
    assert.equal(v.filter(x => x.rule === "caseIdHasResolutionStatus").length, 0);
  });

});

describe("PolicyRules.check — assertionNotContradictory", () => {

  const rules = new PolicyRules();

  it("verified 단독 → 위반 없음", () => {
    const v = rules.check({
      type            : "fact",
      content         : "test",
      assertion_status: "verified"
    });
    assert.equal(v.filter(x => x.rule === "assertionNotContradictory").length, 0);
  });

  it("verified + rejected=true 동시 → 위반", () => {
    const v = rules.check({
      type              : "fact",
      content           : "test",
      assertion_status  : "verified",
      assertion_rejected: true
    });
    const m = v.find(x => x.rule === "assertionNotContradictory");
    assert.ok(m);
    assert.equal(m.severity, "high");
  });

});

describe("PolicyRules.check — 엣지 케이스", () => {

  const rules = new PolicyRules();

  it("fragment가 null이면 빈 배열 반환", () => {
    assert.deepEqual(rules.check(null), []);
  });

  it("fragment가 object 아니면 빈 배열 반환", () => {
    assert.deepEqual(rules.check("string"), []);
  });

  it("모든 위반에 ruleVersion 필드 포함", () => {
    const v = rules.check({
      type   : "error",
      content: "미확정 에러",
      case_id: "c1"
    });
    for (const x of v) {
      assert.ok(typeof x.ruleVersion === "string" && x.ruleVersion.length > 0);
    }
  });

  it("fact type 파편은 case_id 없고 workspace 있으면 모든 rule 통과", () => {
    const v = rules.check({
      type     : "fact",
      content  : "단순 사실",
      workspace: "memento-mcp"
    });
    assert.deepEqual(v, []);
  });

});

describe("PolicyRules.check — fragmentHasWorkspace", () => {

  const rules = new PolicyRules();

  it("workspace 명시값 있음 → 위반 없음", () => {
    const v = rules.check({
      type     : "fact",
      content  : "테스트 사실",
      workspace: "memento-mcp"
    });
    assert.equal(v.filter(x => x.rule === "fragmentHasWorkspace").length, 0);
  });

  it("workspace 없음(undefined) → 위반", () => {
    const v = rules.check({
      type   : "fact",
      content: "테스트 사실"
    });
    const m = v.find(x => x.rule === "fragmentHasWorkspace");
    assert.ok(m, "fragmentHasWorkspace 위반 필수");
    assert.equal(m.severity, "low");
  });

  it("workspace null → 위반", () => {
    const v = rules.check({
      type     : "fact",
      content  : "테스트 사실",
      workspace: null
    });
    const m = v.find(x => x.rule === "fragmentHasWorkspace");
    assert.ok(m, "fragmentHasWorkspace 위반 필수");
  });

  it("workspace 빈 문자열 → 위반", () => {
    const v = rules.check({
      type     : "fact",
      content  : "테스트 사실",
      workspace: ""
    });
    const m = v.find(x => x.rule === "fragmentHasWorkspace");
    assert.ok(m, "fragmentHasWorkspace 위반 필수");
  });

});
