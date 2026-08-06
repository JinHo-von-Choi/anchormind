/**
 * Unit tests: 분할 자식의 주체 유실·양상 표류 판정 (순수 함수).
 *
 * 작성자: 최진호
 * 작성일: 2026-08-06
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hasSubjectAnchor, detectModalityFamilies, findIntroducedModality
} from "../../lib/memory/consolidate/split-gate.js";

describe("hasSubjectAnchor", () => {
  it("앵커가 없으면 판정 근거가 없으므로 통과시킨다", () => {
    assert.equal(hasSubjectAnchor("담당 부서는 접수 사실을 통지했다", []), true);
    assert.equal(hasSubjectAnchor("담당 부서는 접수 사실을 통지했다", null), true);
  });

  it("앵커가 하나라도 포함되면 통과시킨다", () => {
    assert.equal(hasSubjectAnchor("A사는 서면을 제출했다", ["A사", "worker_connections"]), true);
  });

  it("앵커 교집합이 공집합이면 폐기한다", () => {
    assert.equal(hasSubjectAnchor("내부 검토 결과가 정리되었다", ["A사", "B사"]), false);
  });
});

describe("detectModalityFamilies", () => {
  it("양상 표지가 없는 단정문은 빈 배열을 반환한다", () => {
    assert.deepEqual(detectModalityFamilies("A사는 서면 제출로 대리인 지위를 취득했다"), []);
  });

  it("패밀리별 표지를 식별한다", () => {
    assert.deepEqual(detectModalityFamilies("A사는 서면을 제출할 예정이다"), ["future"]);
    assert.deepEqual(detectModalityFamilies("A사는 서면을 제출하고자 한다"), ["intention"]);
    assert.deepEqual(detectModalityFamilies("인용 가능성이 높다"), ["conjecture"]);
    assert.deepEqual(detectModalityFamilies("담당자는 서면을 제출해야 한다"), ["obligation"]);
  });
});

describe("findIntroducedModality", () => {
  it("같은 future 패밀리 안의 표현 교체는 도입으로 보지 않는다", () => {
    const parent = detectModalityFamilies("A사는 2026-07-15 서면을 제출할 예정이다");
    assert.deepEqual(parent, ["future"]);
    assert.deepEqual(findIntroducedModality("A사는 서면을 제출할 것이다", parent), []);
  });

  it("단정문 부모에서 자식이 future를 도입하면 검출한다", () => {
    const parent = detectModalityFamilies("A사는 서면 제출로 대리인 지위를 취득했다");
    assert.deepEqual(parent, []);
    assert.deepEqual(findIntroducedModality("A사는 서면을 제출할 예정이다", parent), ["future"]);
  });

  it("부모에 없던 추측·의무도 도입으로 검출한다", () => {
    const parent = detectModalityFamilies("증거 목록은 총 14건으로 확정되었다");
    assert.deepEqual(findIntroducedModality("증거는 추가로 제출될 가능성이 높다", parent), ["conjecture"]);
    assert.deepEqual(findIntroducedModality("담당자는 증거 목록을 갱신해야 한다", parent), ["obligation"]);
  });

  it("부모 패밀리 목록이 비정상이어도 자식 패밀리를 그대로 반환한다", () => {
    assert.deepEqual(findIntroducedModality("서면을 제출할 예정이다", null), ["future"]);
  });
});
