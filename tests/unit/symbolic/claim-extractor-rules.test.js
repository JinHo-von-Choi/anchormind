/**
 * ClaimExtractor 규칙 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
 *
 * 형태소 분석기는 공백 분리 대역으로 바꿔 외부 의존 없이 결정적으로 돈다.
 * 출력 전체를 비교하지 않고 polarity 판정 우선순위, 필드 형식, 범위, 빈 입력
 * 처리만 명시적으로 단언한다.
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";

const { ClaimExtractor } = await import("../../../lib/symbolic/ClaimExtractor.js");

/** 공백 분리 기반 단순 토큰화 대역. */
class WhitespaceMorphemeIndex {
  async tokenize(text) {
    if (typeof text !== "string") return [];
    return text.toLowerCase()
      .replace(/[^\w\sㄱ-ㅎ가-힣]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 1)
      .slice(0, 10);
  }
}

const extractor = new ClaimExtractor({ morphemeIndex: new WhitespaceMorphemeIndex() });

/** 입력 하나에서 첫 claim을 꺼낸다. */
async function first(content, topic = "cache") {
  const claims = await extractor.extract(content, topic);
  assert.ok(Array.isArray(claims) && claims.length > 0, `claim이 비어 있다: ${content}`);
  return claims[0];
}

describe("ClaimExtractor polarity 판정", () => {
  test("긍정 마커는 positive로 판정한다", async () => {
    assert.equal((await first("Redis를 캐시로 사용한다")).polarity, "positive");
    assert.equal((await first("We use Redis for caching")).polarity, "positive");
  });

  test("부정 마커는 positive 마커가 함께 있어도 negative가 우선한다", async () => {
    assert.equal((await first("Redis를 사용하지 않는다")).polarity, "negative");
    assert.equal((await first("JSON 컬럼 인덱싱은 권장되지 않는다", "index")).polarity, "negative");
    assert.equal((await first("We do not use Redis for caching")).polarity, "negative");
  });

  test("불확실 마커는 다른 모든 마커보다 우선한다", async () => {
    assert.equal((await first("아마도 Redis를 사용할 수도 있음")).polarity, "uncertain");
    assert.equal((await first("Maybe we might use Redis")).polarity, "uncertain");
  });
});

describe("ClaimExtractor 출력 필드", () => {
  const CONTENTS = [
    "Redis를 캐시로 사용한다",
    "Redis를 캐시로 사용하지 않는다",
    "아마도 Redis를 사용할 수도 있음"
  ];

  test("추출 방식과 규칙 버전이 고정 값이다", async () => {
    for (const content of CONTENTS) {
      const c = await first(content);
      assert.equal(c.extractor, "morpheme-rule");
      assert.equal(c.ruleVersion, "v1");
    }
  });

  test("subject는 전달한 topic이고 predicate와 object는 문자열이다", async () => {
    for (const content of CONTENTS) {
      const c = await first(content, "cache");
      assert.equal(c.subject, "cache");
      assert.equal(typeof c.predicate, "string");
      assert.equal(typeof c.object, "string");
    }
  });

  test("polarity는 허용된 세 값 중 하나다", async () => {
    for (const content of CONTENTS) {
      assert.ok(["positive", "negative", "uncertain"].includes((await first(content)).polarity));
    }
  });

  test("confidence는 0 이상 1 이하의 수이며 불확실 판정은 0.5 이하다", async () => {
    for (const content of CONTENTS) {
      const c = await first(content);
      assert.equal(typeof c.confidence, "number");
      assert.ok(c.confidence >= 0 && c.confidence <= 1, `confidence 범위 오류: ${c.confidence}`);
    }
    assert.ok((await first("아마도 Redis를 사용할 수도 있음")).confidence <= 0.5);
  });
});

describe("ClaimExtractor 입력 경계", () => {
  test("빈 문자열, 공백, null은 빈 배열을 돌려준다", async () => {
    assert.deepEqual(await extractor.extract("", "t"), []);
    assert.deepEqual(await extractor.extract("   ", "t"), []);
    assert.deepEqual(await extractor.extract(null, "t"), []);
  });

  test("문자열이 아닌 입력은 예외 없이 빈 배열을 돌려준다", async () => {
    assert.deepEqual(await extractor.extract(undefined, "t"), []);
    assert.deepEqual(await extractor.extract(42, "t"), []);
  });
});
