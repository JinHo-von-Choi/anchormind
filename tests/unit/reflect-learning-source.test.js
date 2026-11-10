/**
 * 자동 회고 학습 항목의 source 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-11-10
 *
 * 자동 회고의 "LEARNING:" 항목은 저장 전에 접두어가 빠지고 source가 learning_extraction이 된다.
 * context의 Learning 구획은 이 source를 읽는다. 클라이언트 reflect는 접두어를 본문으로 둔다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { learningItem, LEARNING_SOURCE } from "../../lib/memory/processors/ReflectProcessor.js";
import { strippedContent }               from "../../scripts/backfill-learning-source.js";

const ctx = (writeEntry) => ({ writeEntry, sessionSrc: "session:s1" });

describe("학습 항목 source", () => {
  it("자동 회고의 LEARNING: 항목은 접두어를 떼고 learning_extraction으로 저장한다", () => {
    assert.deepEqual(learningItem("LEARNING: recall은 keywords를 함께 줄 때 정확하다", ctx("auto_reflect")),
      { content: "recall은 keywords를 함께 줄 때 정확하다", source: LEARNING_SOURCE });
  });

  it("자동 회고의 일반 항목은 세션 source를 쓴다", () => {
    assert.deepEqual(learningItem("배포 절차를 확정했다", ctx("auto_reflect")),
      { content: "배포 절차를 확정했다", source: "session:s1" });
  });

  it("클라이언트 reflect는 접두어를 본문으로 둔다", () => {
    assert.deepEqual(learningItem("LEARNING: 임의 문장", ctx("reflect")),
      { content: "LEARNING: 임의 문장", source: "session:s1" });
  });

  it("백필은 접두어만 떼고, 남는 본문이 없으면 건너뛴다", () => {
    assert.equal(strippedContent("LEARNING:  검색은 두 번 한다"), "검색은 두 번 한다");
    assert.equal(strippedContent("LEARNING:   "), null);
  });
});
