/**
 * P4 회귀 방지: reflect가 만드는 파편의 중요도가 permanent 승격 임계(0.8) 미만이어야 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 * 수정일: 2026-08-28 (범주 사상표 기준으로 검사 축 이동)
 *
 * 중요도 0.8 이상은 ttl_tier가 permanent로 올라가 만료 대상에서 빠진다. 세션
 * 종합으로 만들어진 파편이 전부 영구가 되면 저장소가 정리되지 않는다.
 */
import { test, describe } from "node:test";
import assert             from "node:assert/strict";

import { REFLECT_CATEGORIES } from "../../lib/memory/processors/ReflectProcessor.js";

/** ttl_tier가 permanent로 승격되는 경계. */
const PERMANENT_THRESHOLD = 0.8;

describe("reflect 파편 중요도 상한", () => {
  test("decision 범주는 0.7로 생성된다", () => {
    const spec = REFLECT_CATEGORIES.find(c => c.type === "decision");
    assert.ok(spec, "decision 범주가 사상표에 없다");
    assert.equal(spec.importance, 0.7);
  });

  test("모든 범주가 permanent 승격 임계 미만이다", () => {
    for (const spec of REFLECT_CATEGORIES) {
      assert.ok(spec.importance < PERMANENT_THRESHOLD,
        `${spec.field} 범주의 importance ${spec.importance}가 permanent 임계 이상이다`);
    }
  });

  test("사상표가 다섯 범주 중 네 개를 덮는다", () => {
    /** summary는 문자열 분리 경로가 따로 있어 표에 넣지 않는다. */
    assert.deepEqual(
      REFLECT_CATEGORIES.map(c => c.field).sort(),
      ["decisions", "errors_resolved", "new_procedures", "open_questions"]
    );
  });

  test("해결 상태가 필요한 범주에만 지정돼 있다", () => {
    const byField = Object.fromEntries(REFLECT_CATEGORIES.map(c => [c.field, c]));
    assert.equal(byField.errors_resolved.resolutionStatus, "resolved");
    assert.equal(byField.open_questions.resolutionStatus, "open");
    assert.equal(byField.decisions.resolutionStatus, undefined);
    assert.equal(byField.new_procedures.resolutionStatus, undefined);
  });
});
