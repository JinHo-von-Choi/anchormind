/**
 * Unit tests: split-child quality gate + importance clamp (pure).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAcceptableSplitChild, clampChildImportance } from "../../lib/memory/consolidate/split-gate.js";

describe("isAcceptableSplitChild", () => {
  it("rejects empty / whitespace", () => {
    assert.equal(isAcceptableSplitChild("", "fact"), false);
    assert.equal(isAcceptableSplitChild("   ", "fact"), false);
  });

  it("rejects text shorter than 20 chars", () => {
    assert.equal(isAcceptableSplitChild("짧은 사실이다", "fact"), false);
  });

  it("rejects pronoun-led fragments", () => {
    assert.equal(isAcceptableSplitChild("이 설정은 포트 6379를 사용하며 안정적으로 동작한다", "fact"), false);
    assert.equal(isAcceptableSplitChild("그 모듈은 nginx 리버스 프록시 뒤에서 동작한다", "fact"), false);
    assert.equal(isAcceptableSplitChild("해당 값은 환경 변수로 주입되어 컨테이너에 전달된다", "fact"), false);
    assert.equal(isAcceptableSplitChild("이로 인해 빌드가 실패하고 배포가 중단되는 문제가 생겼다", "error"), false);
  });

  it("rejects CJK-mixed / encoding-broken text (e.g. 候補 leaking into Korean)", () => {
    assert.equal(isAcceptableSplitChild("Redis는 候補 메모리 기반 저장소로 동작하고 TTL을 지원한다", "fact"), false);
    assert.equal(isAcceptableSplitChild("서버는 � 손상된 인코딩을 포함하여 응답을 반환한다 한다", "fact"), false);
  });

  it("accepts a clean self-contained Korean fact >= 20 chars", () => {
    assert.equal(isAcceptableSplitChild("Redis는 포트 6379로 동작하는 메모리 기반 저장소다", "fact"), true);
  });
});

describe("clampChildImportance", () => {
  it("caps child importance at parent * 0.7", () => {
    assert.equal(clampChildImportance(0.8, "procedure"), 0.56);
  });

  it("blocks fact children below 0.4 by returning null", () => {
    assert.equal(clampChildImportance(0.5, "fact"), null); // 0.5*0.7=0.35 < 0.4
  });

  it("allows non-fact child below 0.4", () => {
    assert.equal(clampChildImportance(0.5, "procedure"), 0.35);
  });
});
