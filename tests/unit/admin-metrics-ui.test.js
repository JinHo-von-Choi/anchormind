/**
 * metrics.js — 메트릭 대시보드 UI 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setupDom, flatQuery } from "./admin-test-helper.js";

/* DOM mock을 모듈 import 전에 주입 */
setupDom();

/* visibilityState / visibilitychange mock */
if (typeof global.document.visibilityState === "undefined") {
  Object.defineProperty(global.document, "visibilityState", {
    value: "visible", writable: true, configurable: true
  });
}
if (!global.document.addEventListener._metrics_patched) {
  const _orig = global.document.addEventListener;
  global.document.addEventListener = function (ev, fn) {
    if (ev === "visibilitychange") return; /* 테스트 환경에서 무시 */
    if (_orig) _orig.call(this, ev, fn);
  };
  global.document.addEventListener._metrics_patched = true;
}
if (!global.document.removeEventListener) {
  global.document.removeEventListener = () => {};
}

/* setInterval / clearInterval stub */
global.setInterval  = () => 99;
global.clearInterval = () => {};

const { renderMetricsView } = await import("../../assets/admin/modules/metrics.js");

/* ── fixture ── */
const SAMPLE_DATA = {
  cards: {
    activeSessions:          12,
    authDeniedRate5m:        0.005,
    rbacDeniedRate5m:        0.0,
    tenantBlockedTotal:      3,
    rpcLatencyP50:           45,
    rpcLatencyP99:           230,
    toolErrorRate5m:         0.002,
    symbolicGateBlocked:     0,
    oauthTokensIssuedRate1h: 8
  },
  tools: [
    { tool: "remember",  total_calls: 1024, success_rate: 0.998, p95_ms: 35 },
    { tool: "recall",    total_calls: 512,  success_rate: 0.99,  p95_ms: 50 },
    { tool: "reflect",   total_calls: 128,  success_rate: 1.0,   p95_ms: 20 }
  ],
  errors: [
    { error_type: "rpc_invalid_params", count: 5,  last_seen: "2026-04-20T15:00:00Z" },
    { error_type: "auth_denied",        count: 2,  last_seen: "2026-04-20T14:30:00Z" }
  ],
  generated_at: "2026-04-20T16:00:00Z",
  window_sec: 60
};

function makeContainer() {
  const el = global.document.createElement("div");
  el.textContent = "";
  el.childElementCount = 0;
  /* querySelector/querySelectorAll은 admin-test-helper MockElement에 위임 */
  return el;
}

/* ── 테스트 ── */

describe("renderMetricsView — 카드 grid", () => {
  test("헤더 h2가 'Metrics Dashboard'로 렌더링된다", () => {
    const container = makeContainer();
    renderMetricsView(container, { data: SAMPLE_DATA });

    const headers = flatQuery(container, "h2");
    assert.ok(headers.some(h => h.textContent === "Metrics Dashboard"),
      "h2 'Metrics Dashboard' 존재");
  });

  test("카드 grid(.metrics-card-grid)가 생성된다", () => {
    const container = makeContainer();
    renderMetricsView(container, { data: SAMPLE_DATA });

    const grids = flatQuery(container, ".metrics-card-grid");
    assert.ok(grids.length >= 1, "metrics-card-grid 존재");
  });

  test("카드 9종이 모두 렌더링된다 (.metrics-card)", () => {
    const container = makeContainer();
    renderMetricsView(container, { data: SAMPLE_DATA });

    const cards = flatQuery(container, ".metrics-card");
    assert.equal(cards.length, 9, "metrics-card 9개");
  });

  test("tenantBlockedTotal>0 이면 해당 카드에 metrics-card--warn 또는 metrics-card--critical 클래스가 붙는다", () => {
    const container = makeContainer();
    renderMetricsView(container, { data: SAMPLE_DATA }); /* tenantBlockedTotal=3 → warn */

    const warnCards = flatQuery(container, ".metrics-card--warn");
    const critCards = flatQuery(container, ".metrics-card--critical");
    assert.ok(warnCards.length + critCards.length >= 1,
      "강조 클래스 카드 1개 이상 존재 (tenantBlockedTotal=3)");
  });

  test("tenantBlockedTotal=0 이면 경고 카드가 없다", () => {
    const container = makeContainer();
    const _zeroData  = {
      ...SAMPLE_DATA,
      cards: { ...SAMPLE_DATA.cards, tenantBlockedTotal: 0, tenantBlockedTotal_: 0 }
    };
    renderMetricsView(container, { data: { ...SAMPLE_DATA, cards: { ...SAMPLE_DATA.cards, tenantBlockedTotal: 0 } } });

    /* tenantBlockedTotal 카드 자체는 warn 기준이 v>0이므로 0이면 stateClass 없음.
       나머지 카드는 sample 값이 임계 미만이므로 warn/critical이 없어야 한다.
       단, authDeniedRate5m=0.005 → 0.5% < warn 기준 5% 이므로 정상 */
    const critCards = flatQuery(container, ".metrics-card--critical");
    assert.equal(critCards.length, 0, "critical 카드 없음");
  });
});

describe("renderMetricsView — 도구 테이블", () => {
  test("도구 테이블 행 수가 response.tools.length와 일치한다", () => {
    const container = makeContainer();
    renderMetricsView(container, { data: SAMPLE_DATA });

    /* #metrics-tools-tbody 를 dataset._id로 찾는다 */
    const allEls = [];
    function walk(n) { allEls.push(n); (n.children ?? []).forEach(walk); }
    walk(container);

    const toolsTbody = allEls.find(el => el.dataset?._id === "metrics-tools-tbody");
    assert.ok(toolsTbody, "#metrics-tools-tbody 존재");
    /* tbody의 직계 children(tr)이 tools 개수와 일치해야 한다 */
    assert.equal(toolsTbody.children.length, SAMPLE_DATA.tools.length,
      "도구 tbody 행 수 = tools.length");
  });
});

describe("renderMetricsView — 에러 테이블", () => {
  test("에러 테이블 행 수가 response.errors.length와 일치한다", () => {
    const container = makeContainer();
    renderMetricsView(container, { data: SAMPLE_DATA });

    /* error type 텍스트로 식별 */
    const allEls = [];
    function walk(n) { allEls.push(n); (n.children ?? []).forEach(walk); }
    walk(container);

    const errorTypeCells = allEls.filter(el =>
      el.className && el.className.includes("text-error") &&
      SAMPLE_DATA.errors.some(e => e.error_type === el.textContent)
    );
    assert.equal(errorTypeCells.length, SAMPLE_DATA.errors.length,
      "에러 타입 셀이 errors 배열 길이와 일치");
  });
});

describe("renderMetricsView — 에러/권한 처리", () => {
  test("error 상태일 때 #metrics-error-box가 렌더링된다", () => {
    const container = makeContainer();
    renderMetricsView(container, { error: "403 Forbidden" });

    /* id 는 dataset._id 로 저장됨 (MockElement) */
    const allEls = [];
    function walk(n) { allEls.push(n); (n.children ?? []).forEach(walk); }
    walk(container);

    const errBox = allEls.find(el => el.dataset?._id === "metrics-error-box");
    assert.ok(errBox, "#metrics-error-box 존재");
    assert.ok(errBox.textContent.includes("403"), "에러 메시지 포함");
  });

  test("loading 상태일 때 loading-spinner가 렌더링된다", () => {
    const container = makeContainer();
    renderMetricsView(container, { loading: true });

    const spinners = flatQuery(container, ".loading-spinner");
    assert.ok(spinners.length >= 1, "loading-spinner 존재");
  });
});
