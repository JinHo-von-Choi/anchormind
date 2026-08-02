/**
 * Unit tests: 분할 자식이 원문의 수치 앵커를 보존하는지 판정하는 순수 함수.
 *
 * LLM 분할은 원문을 자르지 않고 다시 쓰므로 명제가 통째로 누락될 수 있다.
 * 날짜·금액·비율은 재작성으로 값이 바뀌기 어려우므로 보존 판정 기준이 된다.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractNumericAnchors, findMissingAnchors } from "../../lib/memory/consolidate/split-gate.js";

describe("extractNumericAnchors", () => {
  it("날짜를 구성 숫자로 분리한다", () => {
    assert.deepEqual(extractNumericAnchors("2026-07-15 제출"), ["2026", "07", "15"]);
  });

  it("자릿수 구분자를 제거하고 범위는 양끝을 각각 남긴다", () => {
    const anchors = extractNumericAnchors("비용 1,200만 원, 가능성 75~85%");
    assert.ok(anchors.includes("1200"));
    assert.ok(anchors.includes("75"));
    assert.ok(anchors.includes("85"));
  });

  it("소수점은 하나의 앵커로 유지한다", () => {
    assert.ok(extractNumericAnchors("F1은 0.87로 측정되었다").includes("0.87"));
  });

  it("한 자리 숫자는 우연 일치가 잦아 제외한다", () => {
    assert.deepEqual(extractNumericAnchors("담당 인력 3인"), []);
  });

  it("중복 앵커는 한 번만 반환한다", () => {
    assert.deepEqual(extractNumericAnchors("14건 확정, 14건 검수"), ["14"]);
  });

  it("문자열이 아니면 빈 배열", () => {
    assert.deepEqual(extractNumericAnchors(null), []);
  });
});

describe("findMissingAnchors", () => {
  const parent = "A사는 2026-07-15 서면을 제출했고 인용 가능성은 75~85%로 평가되었다. 증거 목록은 총 14건이다.";

  it("모든 앵커가 자식에 남으면 누락 없음", () => {
    const children = [
      "A사는 2026-07-15 서면을 제출했다",
      "인용 가능성은 75~85%로 평가되었다",
      "증거 목록은 총 14건이다"
    ];
    assert.deepEqual(findMissingAnchors(parent, children), []);
  });

  it("명제 하나가 통째로 빠지면 해당 앵커를 보고한다", () => {
    const children = [
      "A사는 2026-07-15 서면을 제출했다",
      "인용 가능성은 75~85%로 평가되었다"
    ];
    assert.deepEqual(findMissingAnchors(parent, children), ["14"]);
  });

  it("표기가 달라져도 구성 숫자가 남으면 보존으로 본다", () => {
    const children = [
      "A사는 2026년 07월 15일 서면을 제출했다",
      "인용 가능성은 75%에서 85% 사이로 평가되었다",
      "증거 목록은 14건이다"
    ];
    assert.deepEqual(findMissingAnchors(parent, children), []);
  });

  it("자릿수 구분자 유무가 판정을 바꾸지 않는다", () => {
    assert.deepEqual(findMissingAnchors("예상 비용 1,200만 원", ["예상 비용은 1200만 원이다"]), []);
    assert.deepEqual(findMissingAnchors("예상 비용 1200만 원", ["예상 비용은 1,200만 원이다"]), []);
  });

  it("수치 앵커가 없는 원문은 판정 대상이 아니다", () => {
    assert.deepEqual(findMissingAnchors("담당자는 절차를 정리했다", ["담당자가 절차를 정리했다"]), []);
  });

  it("자식이 비어 있으면 모든 앵커가 누락으로 보고된다", () => {
    assert.deepEqual(findMissingAnchors("총 14건", []), ["14"]);
  });
});
