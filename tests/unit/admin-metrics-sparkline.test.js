/**
 * metrics-sparkline.js — SVG sparkline 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setupDom, flatQuery } from "./admin-test-helper.js";

setupDom();

const { renderSparkline, filterByWindow } = await import(
  "../../assets/admin/modules/metrics-sparkline.js"
);

/* ── fixture ── */

const SAMPLE_DATA = [
  { ts: new Date(Date.now() - 240_000).toISOString(), value: 10 },
  { ts: new Date(Date.now() - 180_000).toISOString(), value: 20 },
  { ts: new Date(Date.now() - 120_000).toISOString(), value: 15 },
  { ts: new Date(Date.now() -  60_000).toISOString(), value: 30 },
  { ts: new Date(Date.now() -  10_000).toISOString(), value: 25 }
];

function makeContainer() {
  return global.document.createElement("div");
}

/* ── 테스트 ── */

describe("renderSparkline — SVG 생성", () => {
  test("data가 있을 때 SVG element가 container에 추가된다", () => {
    const container = makeContainer();
    renderSparkline(container, SAMPLE_DATA);

    /* MockElement는 createElementNS(ns, tag) → MockElement(tag) 로 처리됨.
       tagName = "SVG" (대문자 변환) */
    const svgEls = flatQuery(container, "svg");
    /* flatQuery는 tagName 기반 — MockElement.tagName = tag.toUpperCase() */
    const hasSvg = svgEls.length >= 1 ||
      /* fallback: children 직접 확인 */
      container.children.some(c => c.tagName === "SVG");

    assert.ok(hasSvg, "SVG 엘리먼트가 container에 추가됨");
  });

  test("data가 빈 배열일 때 '데이터 없음' 텍스트가 표시된다", () => {
    const container = makeContainer();
    renderSparkline(container, []);

    const allEls = [];
    function walk(n) { allEls.push(n); (n.children ?? []).forEach(walk); }
    walk(container);

    const hasEmpty = allEls.some(el => el.textContent === "데이터 없음");
    assert.ok(hasEmpty, "'데이터 없음' 텍스트 존재");
  });

  test("data가 null일 때 '데이터 없음' 텍스트가 표시된다", () => {
    const container = makeContainer();
    renderSparkline(container, null);

    const allEls = [];
    function walk(n) { allEls.push(n); (n.children ?? []).forEach(walk); }
    walk(container);

    const hasEmpty = allEls.some(el => el.textContent === "데이터 없음");
    assert.ok(hasEmpty, "null data → '데이터 없음' 텍스트 존재");
  });

  test("polyline의 points 개수가 data.length와 일치한다", () => {
    const container = makeContainer();
    renderSparkline(container, SAMPLE_DATA, { width: 160, height: 40 });

    /* SVG children: [polygon, polyline] */
    const svgEl = container.children.find(c => c.tagName === "SVG");
    assert.ok(svgEl, "SVG 엘리먼트 존재");

    /* polyline은 SVG의 두 번째 child (인덱스 1) */
    const polyline = svgEl.children[1];
    assert.ok(polyline, "polyline 엘리먼트 존재");

    const pointsAttr = polyline._attrs?.points ?? "";
    /* "x1,y1 x2,y2 ..." — 공백으로 분리하면 n개 */
    const pointCount = pointsAttr.trim().split(/\s+/).length;
    assert.equal(pointCount, SAMPLE_DATA.length, "polyline points 개수 = data.length");
  });

  test("min/max 정규화: value가 모두 같으면 y가 height/2에 고정된다", () => {
    const container = makeContainer();
    const flatData  = [
      { ts: "2026-04-20T00:00:00Z", value: 42 },
      { ts: "2026-04-20T00:01:00Z", value: 42 },
      { ts: "2026-04-20T00:02:00Z", value: 42 }
    ];
    renderSparkline(container, flatData, { width: 100, height: 40 });

    const svgEl   = container.children.find(c => c.tagName === "SVG");
    const polyline = svgEl?.children[1];
    const pointsAttr = polyline?._attrs?.points ?? "";
    /* 모든 y 값이 height/2 = 20 이어야 함 */
    const ys = pointsAttr.trim().split(/\s+/).map(p => parseFloat(p.split(",")[1]));
    assert.ok(ys.every(y => y === 20), "range===0 시 y=height/2 (20) 고정");
  });

  test("opts.stroke 와 opts.fill이 polyline/polygon에 반영된다", () => {
    const container = makeContainer();
    renderSparkline(container, SAMPLE_DATA, {
      stroke: "#ff0000",
      fill:   "rgba(255,0,0,0.2)"
    });

    const svgEl  = container.children.find(c => c.tagName === "SVG");
    const polygon  = svgEl?.children[0];
    const polyline = svgEl?.children[1];

    assert.equal(polyline?._attrs?.stroke, "#ff0000", "polyline stroke 적용");
    assert.equal(polygon?._attrs?.fill,    "rgba(255,0,0,0.2)", "polygon fill 적용");
  });
});

describe("filterByWindow", () => {
  test("window 범위 밖의 데이터를 제거한다", () => {
    const now  = Date.now();
    const data = [
      { ts: new Date(now - 400_000).toISOString(), value: 1 }, /* 6분 전 — 5분 범위 밖 */
      { ts: new Date(now - 200_000).toISOString(), value: 2 }, /* 3분 전 — 5분 범위 안 */
      { ts: new Date(now -  30_000).toISOString(), value: 3 }  /* 30초 전 — 5분 범위 안 */
    ];
    const result = filterByWindow(data, 5 * 60 * 1000);
    assert.equal(result.length, 2, "5분 범위 내 데이터만 반환");
    assert.ok(result.every(d => d.value >= 2), "범위 외 항목 제거됨");
  });

  test("빈 배열 입력 시 빈 배열을 반환한다", () => {
    const result = filterByWindow([], 300_000);
    assert.deepEqual(result, [], "빈 배열 반환");
  });
});
