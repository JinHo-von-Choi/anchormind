/**
 * admin.js -- Memory Operations 렌더러 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-26
 * 수정일: 2026-04-19 (ESM 모듈 직접 import 방식으로 전환)
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDom, flatQuery } from "./admin-test-helper.js";

/* DOM mock을 모듈 import 전에 주입 */
setupDom();

const {
  renderMemoryFilters,
  renderFragmentList,
  renderRetrievalAnalytics,
  renderAnomalyCards,
  renderRecentEventsChart,
  renderFragmentInspector,
  renderPagination
} = await import("../../assets/admin/modules/memory.js");

const { state } = await import("../../assets/admin/modules/state.js");

/* ================================================================
   Memory Filters
   ================================================================ */

describe("renderMemoryFilters", () => {
  test("glass-panel + border-l-2 border-primary/40", () => {
    const bar = renderMemoryFilters();
    assert.ok(bar.className.includes("glass-panel"));
    assert.ok(bar.className.includes("border-l-2"));
    assert.ok(bar.className.includes("border-primary/40"));
  });

  test("filter-topic, filter-type, filter-key-id 존재", () => {
    const bar = renderMemoryFilters();
    const all = [];
    function walk(n) { all.push(n); (n.children ?? []).forEach(walk); }
    walk(bar);
    assert.ok(all.some(n => n.dataset?._id === "filter-topic"), "topic input");
    assert.ok(all.some(n => n.dataset?._id === "filter-type"), "type select");
    assert.ok(all.some(n => n.dataset?._id === "filter-key-id"), "key input");
  });

  test("SEARCH 버튼 존재", () => {
    const bar = renderMemoryFilters();
    const all = [];
    function walk(n) { all.push(n); (n.children ?? []).forEach(walk); }
    walk(bar);
    assert.ok(all.some(n => n.dataset?._id === "filter-search"), "filter-search button");
  });
});

/* ================================================================
   Fragment List (Search Explorer)
   ================================================================ */

describe("renderFragmentList", () => {
  test("fragments 비어있으면 빈 상태 텍스트", () => {
    const el = renderFragmentList([]);
    assert.ok(el.textContent.includes("결과 없음"));
  });

  test("glass-panel + shadow-2xl + overflow-hidden", () => {
    const frags = [{ id: "f1", topic: "test", type: "fact", content: "hello", importance: 0.8, created_at: "2024-01-01" }];
    state.selectedFragment = null;
    const panel = renderFragmentList(frags);
    assert.ok(panel.className.includes("glass-panel"));
    assert.ok(panel.className.includes("shadow-2xl"));
    assert.ok(panel.className.includes("overflow-hidden"));
  });

  test("query box with bg-surface-container-highest", () => {
    const frags = [{ id: "f1", topic: "t", type: "fact", content: "c" }];
    state.selectedFragment = null;
    const panel = renderFragmentList(frags);
    const queryBox = panel.querySelector(".bg-surface-container-highest");
    assert.ok(queryBox, "query box 존재");
  });

  test("fragment item에 ID badge + UTILITY_SCORE + ACCESS", () => {
    const frags = [{ id: "f1", topic: "arch", type: "decision", content: "content", importance: 0.9, access_count: 5, created_at: "2024-06-01" }];
    state.selectedFragment = null;
    const panel = renderFragmentList(frags);
    const item = panel.querySelector("[data-frag-id]");
    assert.ok(item, "fragment item 존재");

    const all = [];
    function walk(n) { all.push(n); (n.children ?? []).forEach(walk); }
    walk(item);
    assert.ok(all.some(n => (n.textContent ?? "").includes("#MEM_")), "ID badge");
    assert.ok(all.some(n => (n.textContent ?? "").includes("UTILITY_SCORE")), "UTILITY_SCORE label");
    assert.ok(all.some(n => (n.textContent ?? "").includes("ACCESS")), "ACCESS label");
  });
});

/* ================================================================
   Retrieval Analytics
   ================================================================ */

describe("renderRetrievalAnalytics", () => {
  test("glass-panel + border-primary/20", () => {
    const panel = renderRetrievalAnalytics({});
    assert.ok(panel.className.includes("glass-panel"));
    assert.ok(panel.className.includes("border-primary/20"));
  });

  test("Retrieval Analytics 타이틀", () => {
    const panel = renderRetrievalAnalytics({});
    const all = [];
    function walk(n) { all.push(n); (n.children ?? []).forEach(walk); }
    walk(panel);
    assert.ok(all.some(n => (n.textContent ?? "").includes("Retrieval Analytics")));
  });

  test("SEARCHES + ZERO-RESULT 실측 카드, 데이터 부재 시 --", () => {
    const panel = renderRetrievalAnalytics(null);
    const all = [];
    function walk(n) { all.push(n); (n.children ?? []).forEach(walk); }
    walk(panel);
    assert.ok(all.some(n => (n.textContent ?? "").includes("SEARCHES")));
    assert.ok(all.some(n => (n.textContent ?? "").includes("ZERO-RESULT")));
    assert.ok(all.some(n => (n.textContent ?? "") === "--"), "데이터 부재 시 -- 표시");
    assert.ok(!all.some(n => (n.textContent ?? "").includes("87%")), "고정 폴백 수치 없음");
  });

  test("search-events 실값이 있으면 수치 바인딩", () => {
    const panel = renderRetrievalAnalytics({
      totalSearches: 42,
      zeroResultRate: 0.25,
      latency: { p50: 12.3, p90: 40, p99: 90, avg_ms: 20 },
      avgRelevance: 0.8,
      avgSufficiency: 0.7
    });
    const all = [];
    function walk(n) { all.push(n); (n.children ?? []).forEach(walk); }
    walk(panel);
    assert.ok(all.some(n => (n.textContent ?? "") === "42"));
    assert.ok(all.some(n => (n.textContent ?? "").includes("25")), "zeroResultRate 백분율");
  });
});

/* ================================================================
   Anomaly Cards
   ================================================================ */

describe("renderAnomalyCards", () => {
  test("anomalies=null이면 empty fragment", () => {
    const el = renderAnomalyCards(null);
    assert.equal(el.children.length, 0);
  });

  test("glass-panel + border-error/20", () => {
    const panel = renderAnomalyCards({ contradictions: 2 });
    assert.ok(panel.className.includes("glass-panel"));
    assert.ok(panel.className.includes("border-error/20"));
  });

  test("4 anomaly items", () => {
    const panel = renderAnomalyCards({ contradictions: 0, superseded: 0, qualityUnverified: 0, embeddingBacklog: 0 });
    const items = panel.querySelectorAll("[data-anomaly]");
    assert.equal(items.length, 4);
  });

  test("critical item with bg-error-container/10", () => {
    const panel = renderAnomalyCards({ contradictions: 3 });
    const critical = panel.querySelector(".bg-error-container\\/10");
    assert.ok(critical);
  });
});

/* ================================================================
   Recent Events Chart
   ================================================================ */

describe("renderRecentEventsChart", () => {
  test("glass-panel wrapper", () => {
    const panel = renderRecentEventsChart();
    assert.ok(panel.className.includes("glass-panel"));
  });

  test("PATH DISTRIBUTION + TOP KEYWORDS 섹션, 데이터 부재 시 --", () => {
    const panel = renderRecentEventsChart(null);
    const all = [];
    function walk(n) { all.push(n); (n.children ?? []).forEach(walk); }
    walk(panel);
    assert.ok(all.some(n => (n.textContent ?? "").includes("SEARCH PATH DISTRIBUTION")));
    assert.ok(all.some(n => (n.textContent ?? "").includes("TOP KEYWORDS")));
    assert.ok(all.some(n => (n.textContent ?? "") === "--"));
  });

  test("pathDistribution 실데이터가 행으로 렌더링된다", () => {
    const panel = renderRecentEventsChart({
      pathDistribution: [{ search_path: "L1", cnt: 30 }, { search_path: "L2", cnt: 10 }],
      topKeywords: [{ kw: "memento", cnt: 5 }]
    });
    const all = [];
    function walk(n) { all.push(n); (n.children ?? []).forEach(walk); }
    walk(panel);
    assert.ok(all.some(n => (n.textContent ?? "") === "L1"));
    assert.ok(all.some(n => (n.textContent ?? "") === "30"));
    assert.ok(all.some(n => (n.textContent ?? "") === "memento"));
  });
});

/* ================================================================
   Fragment Inspector
   ================================================================ */

describe("renderFragmentInspector", () => {
  test("fragment=null이면 empty fragment", () => {
    const el = renderFragmentInspector(null);
    assert.equal(el.children.length, 0);
  });

  test("glass-panel + border-primary/20", () => {
    const detail = {
      fragment: { id: "f1", content: "test", type: "fact", importance: 0.8, created_at: "2024-01-01", keywords: ["k1"] },
      links: []
    };
    const panel = renderFragmentInspector(detail);
    assert.ok(panel.className.includes("glass-panel"));
    assert.ok(panel.className.includes("border-primary/20"));
  });

  test("links가 relation_type과 함께 렌더링된다", () => {
    const detail = {
      fragment: { id: "f1", content: "test", type: "error", importance: 0.8, created_at: "2024-01-01", keywords: [] },
      links: [{ relation_type: "resolved_by", direction: "out", id: "f2", type: "procedure", preview: "fix" }]
    };
    const panel = renderFragmentInspector(detail);
    const all = [];
    function walk(n) { all.push(n); (n.children ?? []).forEach(walk); }
    walk(panel);
    assert.ok(all.some(n => (n.textContent ?? "").includes("resolved_by")));
  });
});

/* ================================================================
   Pagination
   ================================================================ */

describe("renderPagination", () => {
  test("memoryPages <= 1이면 빈 fragment", () => {
    state.memoryPages = 1;
    const el = renderPagination();
    assert.equal(el.children.length, 0);
  });

  test("memoryPages=3이면 5개 버튼 (prev + 3 pages + next)", () => {
    state.memoryPages = 3;
    state.memoryPage  = 1;
    const wrap = renderPagination();
    const buttons = flatQuery(wrap, "button");
    assert.equal(buttons.length, 5);
  });
});
