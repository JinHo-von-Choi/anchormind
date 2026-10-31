/**
 * ExplanationBuilder 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * 검증 포인트:
 * 1. 빈 배열 입력 → no-op 반환 (동일 참조 또는 빈 배열)
 * 2. 각 fragment 에 explanations 필드가 주입된다
 * 3. 원본 fragment 객체는 변경되지 않는다 (불변성)
 * 4. searchPath 태그에 따라 reason code 가 정확히 매핑된다
 * 5. 6종 reason code 모두 트리거 가능
 * 6. 각 fragment 당 최대 3개 reason 제한
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ExplanationBuilder } from "../../../lib/symbolic/ExplanationBuilder.js";

describe("ExplanationBuilder", () => {
  it("빈 배열 입력 → no-op 반환", () => {
    const builder = new ExplanationBuilder();
    const result  = builder.annotate([], { searchPath: ["L2:1"] });
    assert.deepEqual(result, []);
  });

  it("null/undefined 입력 → 원본 그대로 반환", () => {
    const builder = new ExplanationBuilder();
    assert.equal(builder.annotate(null, {}), null);
    assert.equal(builder.annotate(undefined, {}), undefined);
  });

  it("각 fragment 에 explanations 필드 주입 + 원본 불변", () => {
    const builder  = new ExplanationBuilder();
    const original = { id: "f1", content: "hello", ema_activation: 0.2 };
    const result   = builder.annotate([original], { searchPath: ["L2:1"] });

    assert.equal(result.length, 1);
    assert.equal(result[0].id, "f1");
    assert.equal(result[0].content, "hello");
    assert.ok(Array.isArray(result[0].explanations));
    assert.ok(result[0].explanations.length > 0);

    /** 원본 객체는 explanations 필드를 가지지 않아야 한다 */
    assert.equal(original.explanations, undefined);
  });

  it("L2 searchPath → direct_keyword_match reason", () => {
    const builder = new ExplanationBuilder();
    const result  = builder.annotate([{ id: "f1" }], { searchPath: ["L2:3"] });
    const codes   = result[0].explanations.map((r) => r.code);
    assert.ok(codes.includes("direct_keyword_match"));
  });

  it("L3 searchPath → semantic_similarity reason", () => {
    const builder = new ExplanationBuilder();
    const result  = builder.annotate([{ id: "f1" }], { searchPath: ["L3:5"] });
    const codes   = result[0].explanations.map((r) => r.code);
    assert.ok(codes.includes("semantic_similarity"));
  });

  it("HotCache searchPath → semantic_similarity reason (L1 대체)", () => {
    const builder = new ExplanationBuilder();
    const result  = builder.annotate([{ id: "f1" }], { searchPath: ["HotCache:2"] });
    const codes   = result[0].explanations.map((r) => r.code);
    assert.ok(codes.includes("semantic_similarity"));
  });

  it("Graph searchPath → graph_neighbor_1hop reason", () => {
    const builder = new ExplanationBuilder();
    const result  = builder.annotate([{ id: "f1" }], { searchPath: ["Graph:1"] });
    const codes   = result[0].explanations.map((r) => r.code);
    assert.ok(codes.includes("graph_neighbor_1hop"));
  });

  it("Temporal searchPath → temporal_proximity reason", () => {
    const builder = new ExplanationBuilder();
    const result  = builder.annotate([{ id: "f1" }], { searchPath: ["Temporal:2"] });
    const codes   = result[0].explanations.map((r) => r.code);
    assert.ok(codes.includes("temporal_proximity"));
  });

  it("파편별 출처 계층이 있으면 파편마다 다른 사유를 붙인다", () => {
    const builder = new ExplanationBuilder();
    const channelsById = new Map([["kw", ["l1", "l2"]], ["vec", ["l3"]], ["nb", ["graph"]], ["t", ["temporal", "lexical"]]]);
    const result = builder.annotate([{ id: "kw" }, { id: "vec" }, { id: "nb" }, { id: "t" }],
      { searchPath: ["L1:3", "L2:2", "L2.5Graph:1", "L3:4", "RRF"], channelsById });
    const codes = Object.fromEntries(result.map(f => [f.id, f.explanations.map(r => r.code)]));
    assert.deepEqual(codes, {
      kw : ["direct_keyword_match"],
      vec: ["semantic_similarity"],
      nb : ["graph_neighbor_1hop"],
      t  : ["direct_keyword_match", "temporal_proximity"]
    });
  });

  it("caseContext 일치 → case_cohort_member reason", () => {
    const builder  = new ExplanationBuilder();
    const fragment = { id: "f1", case_id: "case-1" };
    const result   = builder.annotate([fragment], {
      searchPath : ["L2:1"],
      caseContext: "case-1"
    });
    const codes = result[0].explanations.map((r) => r.code);
    assert.ok(codes.includes("case_cohort_member"));
  });

  it("ema_activation > 0.5 → recent_activity_ema reason", () => {
    const builder  = new ExplanationBuilder();
    const fragment = { id: "f1", ema_activation: 0.8 };
    /** L2/L3/Graph/Temporal 태그가 없어야 ema reason 이 slice(0,3) 제한에 포함되는지 확인 */
    const result   = builder.annotate([fragment], { searchPath: [] });
    const codes    = result[0].explanations.map((r) => r.code);
    assert.ok(codes.includes("recent_activity_ema"));
  });

  it("각 fragment 당 reason 최대 3개 제한", () => {
    const builder  = new ExplanationBuilder();
    const fragment = { id: "f1", case_id: "case-1", ema_activation: 0.8 };
    const result   = builder.annotate([fragment], {
      searchPath : ["L2:1", "L3:1", "Graph:1", "Temporal:1"],
      caseContext: "case-1"
    });
    assert.ok(result[0].explanations.length <= 3);
  });

  it("각 reason 은 {code, detail, ruleVersion} 필드를 가진다", () => {
    const builder = new ExplanationBuilder();
    const result  = builder.annotate([{ id: "f1" }], { searchPath: ["L2:1"] });
    for (const reason of result[0].explanations) {
      assert.equal(typeof reason.code, "string");
      assert.equal(typeof reason.detail, "string");
      assert.equal(reason.ruleVersion, "v1");
    }
  });

  it("DI reasonBuilder 주입 → 커스텀 빌더 호출", () => {
    let calledWith = null;
    const customBuilder = new ExplanationBuilder({
      reasonBuilder: (fragment, ctx) => {
        calledWith = { fragment, ctx };
        return [{ code: "custom", detail: "test", ruleVersion: "v1" }];
      }
    });

    const result = customBuilder.annotate([{ id: "f1" }], { searchPath: ["L2:1"] });
    assert.equal(calledWith.fragment.id, "f1");
    assert.deepEqual(result[0].explanations, [{ code: "custom", detail: "test", ruleVersion: "v1" }]);
  });
});
