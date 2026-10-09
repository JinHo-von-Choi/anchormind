/**
 * segmenter: 긴 본문을 겹치는 구간으로 나누는 순수 함수
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { splitIntoSegments, segmentVersion, SEGMENTER_VERSION } from "../../lib/memory/embedding/segmenter.js";

const words = n => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

describe("splitIntoSegments", () => {
  it("minChars 이하의 본문은 구간을 만들지 않는다(399/400)", () => {
    assert.deepEqual(splitIntoSegments("가".repeat(399)), []);
    assert.deepEqual(splitIntoSegments("가".repeat(400)), []);
  });

  it("minChars를 넘으면(401) 구간이 둘 이상이다", () => {
    const segs = splitIntoSegments("a".repeat(401));
    assert.ok(segs.length >= 2);
  });

  it("문자열이 아니거나 빈 값이면 빈 배열이다", () => {
    for (const v of [null, undefined, 5, {}, ""]) assert.deepEqual(splitIntoSegments(v), []);
  });

  it("전체 범위를 덮고 마지막 구간은 본문 끝에서 끝난다", () => {
    const text = words(180);                 // 약 700자
    const cp   = Array.from(text);
    const segs = splitIntoSegments(text);
    assert.equal(segs[0].start, 0);
    assert.equal(segs.at(-1).end, cp.length);
    for (let i = 1; i < segs.length; i++) assert.ok(segs[i].start < segs[i - 1].end, "구간이 겹친다");
  });

  it("구간은 항상 앞으로 전진하고 text가 오프셋과 일치한다", () => {
    const text = words(200);
    const cp   = Array.from(text);
    const segs = splitIntoSegments(text);
    for (let i = 1; i < segs.length; i++) assert.ok(segs[i].start > segs[i - 1].start);
    for (const s of segs) assert.equal(s.text, cp.slice(s.start, s.end).join(""));
    segs.forEach((s, i) => assert.equal(s.idx, i));
  });

  it("공백에서 경계를 맞춘다(단어가 중간에서 잘리지 않는다)", () => {
    const segs = splitIntoSegments(words(200));
    for (const s of segs.slice(1)) assert.ok(!/^\S*$/.test(s.text.slice(0, 1)) || /^w/.test(s.text), s.text.slice(0, 10));
    for (const s of segs.slice(0, -1)) assert.ok(/\d$/.test(s.text.trimEnd()));
  });

  it("공백이 없는 긴 텍스트도 나눈다", () => {
    const segs = splitIntoSegments("가".repeat(900));
    assert.ok(segs.length >= 3);
    assert.equal(segs.at(-1).end, 900);
  });

  it("이모지(서로게이트 쌍)를 코드 포인트 단위로 센다", () => {
    const text = "😀".repeat(500);                       // UTF-16 길이 1000, 코드 포인트 500
    const segs = splitIntoSegments(text);
    assert.ok(segs.length >= 2);
    assert.equal(segs.at(-1).end, 500);
    for (const s of segs) assert.ok(!/[\uD800-\uDBFF]$/.test(s.text) && !/^[\uDC00-\uDFFF]/.test(s.text));
  });

  it("CRLF 줄바꿈이 섞여도 구간이 비지 않는다", () => {
    const text = Array.from({ length: 80 }, (_, i) => `line ${i} 내용입니다`).join("\r\n");
    const segs = splitIntoSegments(text);
    assert.ok(segs.length >= 2);
    assert.ok(segs.every(s => s.text.trim().length > 0));
  });

  it("maxSegments를 넘으면 간격을 늘려 끝부분까지 덮는다", () => {
    const text = "x".repeat(1000);
    const segs = splitIntoSegments(text, { windowChars: 100, strideChars: 50, maxSegments: 5 });
    assert.equal(segs.length, 5);
    assert.equal(segs[0].start, 0);
    assert.equal(segs.at(-1).end, 1000);
  });

  it("같은 입력이면 항상 같은 결과다", () => {
    const text = words(160);
    assert.deepEqual(splitIntoSegments(text), splitIntoSegments(text));
  });

  it("끝부분에 있는 문장이 마지막 구간에 들어간다", () => {
    const text = "앞부분 ".repeat(120) + "그런데 방금 smoker를 샀어";
    const segs = splitIntoSegments(text);
    assert.ok(segs.at(-1).text.includes("smoker"));
  });

  it("공백뿐인 구간은 만들지 않는다", () => {
    const segs = splitIntoSegments("a".repeat(100) + " ".repeat(500) + "b".repeat(100));
    assert.ok(segs.every(s => s.text.trim() !== ""));
  });
});

describe("segmentVersion", () => {
  it("설정과 규칙 버전을 담는다", () => {
    assert.equal(segmentVersion({ windowChars: 300, strideChars: 150, maxSegments: 12 }), `v${SEGMENTER_VERSION}-w300-s150-m12`);
    assert.notEqual(segmentVersion({ windowChars: 300, strideChars: 150, maxSegments: 12 }), segmentVersion({ windowChars: 250, strideChars: 150, maxSegments: 12 }));
  });
});
