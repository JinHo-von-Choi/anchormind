/**
 * Memento MCP Admin Console — Metrics 뷰 렌더러
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 * 수정일: 2026-04-20 (Phase 2: SVG sparkline + 시간 범위 토글)
 */

import { api }                                from "./api.js";
import { fmt, fmtMs, fmtPct, fmtDate, loadingHtml } from "./format.js";
import { renderSparkline, filterByWindow }    from "./metrics-sparkline.js";

/** @type {number|null} 현재 polling interval ID */
let _pollInterval  = null;

/** @type {AbortController|null} visibilitychange 중지 제어 */
let _visHandler    = null;

/**
 * 시간 범위 토글 상태 (분 단위).
 * 5 | 30 — 클라이언트 필터링으로 처리.
 *
 * @type {5|30}
 */
let _timeRangeMin = 5;

/* ── API ─────────────────────────────────────────────────── */

/**
 * /v1/internal/model/nothing/metrics-summary 를 호출하여 응답을 반환한다.
 *
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, data: any }>}
 */
export async function fetchMetricsSummary(opts = {}) {
  return api("/metrics-summary", { signal: opts.signal });
}

/* ── 카드 렌더링 ─────────────────────────────────────────── */

/**
 * 카드 정의 배열을 받아 2×4 grid DOM을 반환한다.
 *
 * sparklineKey: timeseries 응답 키. 설정된 카드에는 하단 sparkline 영역이 추가된다.
 *   - activeSessions  → timeseries.activeSessions
 *   - rpcLatencyP50   → timeseries.httpRps        (요청률과 latency P50은 연관도 높음)
 *   - rpcLatencyP99   → timeseries.toolLatencyP95 (nearest match: tool call latency)
 *
 * @param {object} cards      - 응답의 cards 객체
 * @param {object} timeseries - 응답의 timeseries 객체 (없으면 sparkline 생략)
 * @returns {HTMLElement}
 */
function renderCardGrid(cards, timeseries) {
  const CARD_DEFS = [
    { key: "activeSessions",        label: "ACTIVE SESSIONS",       unit: "",      icon: "groups",               warn: (v) => false,       critical: (v) => false,  sparklineKey: "activeSessions"  },
    { key: "rpcLatencyP50",         label: "RPC LATENCY P50",       unit: "ms",    icon: "speed",                warn: (v) => v > 200,     critical: (v) => v > 500,  sparklineKey: "httpRps"         },
    { key: "rpcLatencyP99",         label: "RPC LATENCY P99",       unit: "ms",    icon: "timer",                warn: (v) => v > 500,     critical: (v) => v > 1000, sparklineKey: "toolLatencyP95"  },
    { key: "toolErrorRate5m",       label: "TOOL ERROR RATE 5m",    unit: "%",     icon: "error_outline",        warn: (v) => v > 0.01,    critical: (v) => v > 0.05 },
    { key: "authDeniedRate5m",      label: "AUTH DENIED RATE 5m",   unit: "%",     icon: "lock",                 warn: (v) => v > 0.05,    critical: (v) => v > 0.2 },
    { key: "rbacDeniedRate5m",      label: "RBAC DENIED RATE 5m",   unit: "%",     icon: "admin_panel_settings", warn: (v) => v > 0.02,    critical: (v) => v > 0.1 },
    { key: "tenantBlockedTotal",    label: "TENANT BLOCKED",        unit: "",      icon: "block",                warn: (v) => v > 0,       critical: (v) => v > 10 },
    { key: "oauthTokensIssuedRate1h", label: "OAUTH TOKENS /1h",   unit: "",      icon: "key",                  warn: (v) => false,       critical: (v) => false },
    { key: "symbolicGateBlocked",   label: "SYMBOLIC BLOCKED",      unit: "",      icon: "filter_alt_off",       warn: (v) => v > 0,       critical: (v) => v > 5 }
  ];

  const grid = document.createElement("div");
  grid.className = "metrics-card-grid";

  CARD_DEFS.forEach(def => {
    const raw = cards?.[def.key] ?? 0;

    /* rate 계열은 % 변환, latency는 그대로 */
    const isRate     = def.unit === "%";
    const displayVal = isRate ? fmtPct(raw) : (def.unit === "ms" ? fmtMs(raw) : fmt(raw));

    let stateClass = "";
    if (def.critical(raw))    stateClass = "metrics-card--critical";
    else if (def.warn(raw))   stateClass = "metrics-card--warn";

    const card = document.createElement("div");
    card.className = ["glass-panel metrics-card", stateClass].filter(Boolean).join(" ");

    /* 왼쪽 accent bar — stateClass에 따라 색상 결정 */
    const bar = document.createElement("div");
    bar.className = "metrics-card__bar";
    card.appendChild(bar);

    /* Ghost icon */
    const ghost = document.createElement("div");
    ghost.className = "absolute top-0 right-0 p-2 opacity-10";
    const ghostIcon = document.createElement("span");
    ghostIcon.className = "material-symbols-outlined text-4xl";
    ghostIcon.textContent = def.icon;
    ghost.appendChild(ghostIcon);
    card.appendChild(ghost);

    const label = document.createElement("p");
    label.className = "text-[10px] font-bold text-slate-500 tracking-widest uppercase mb-1 font-label";
    label.textContent = def.label;
    card.appendChild(label);

    const val = document.createElement("p");
    val.className = "metric-label text-2xl text-on-surface metrics-card__value";
    val.textContent = displayVal;
    card.appendChild(val);

    /* sparkline 영역 — sparklineKey가 있고 timeseries 데이터가 존재하는 카드만 */
    if (def.sparklineKey && timeseries) {
      const raw  = timeseries[def.sparklineKey] ?? [];
      const data = filterByWindow(raw, _timeRangeMin * 60 * 1000);

      const sparkWrap = document.createElement("div");
      sparkWrap.className = "metrics-card-sparkline";
      sparkWrap.dataset.sparklineKey = def.sparklineKey;

      renderSparkline(sparkWrap, data, {
        width:  160,
        height: 40,
        stroke: stateClass === "metrics-card--critical" ? "#cc7755"
              : stateClass === "metrics-card--warn"     ? "#c4a06a"
              : "#aa8855",
        fill:   stateClass === "metrics-card--critical" ? "rgba(204,119,85,0.12)"
              : stateClass === "metrics-card--warn"     ? "rgba(196,160,106,0.12)"
              : "rgba(170,136,85,0.15)"
      });

      card.appendChild(sparkWrap);
    }

    grid.appendChild(card);
  });

  return grid;
}

/* ── 테이블 헬퍼 ─────────────────────────────────────────── */

/**
 * 정렬 가능한 도구 통계 테이블을 반환한다.
 *
 * @param {Array<{tool: string, total_calls: number, success_rate: number, p95_ms: number}>} tools
 * @returns {HTMLElement}
 */
function renderToolsTable(tools) {
  const wrap = document.createElement("div");
  wrap.className = "glass-panel overflow-x-auto";

  const header = document.createElement("p");
  header.className = "text-[10px] font-bold text-slate-400 tracking-widest uppercase px-6 pt-5 pb-3 font-label";
  header.textContent = "TOOL STATISTICS";
  wrap.appendChild(header);

  if (!tools || tools.length === 0) {
    const empty = document.createElement("p");
    empty.className = "text-[10px] text-slate-600 text-center py-6";
    empty.textContent = "No tool data";
    wrap.appendChild(empty);
    return wrap;
  }

  const table = document.createElement("table");
  table.className = "w-full text-left border-collapse metrics-table";
  table.id = "metrics-tools-table";

  /* thead */
  const thead = document.createElement("thead");
  thead.className = "bg-white/5 border-b border-white/5";
  const hRow = document.createElement("tr");
  [
    { label: "Tool",         key: "tool",         align: "left" },
    { label: "Total Calls",  key: "total_calls",  align: "right" },
    { label: "Success Rate", key: "success_rate", align: "right" },
    { label: "P95 ms",       key: "p95_ms",       align: "right" }
  ].forEach(col => {
    const th = document.createElement("th");
    th.className = "px-6 py-4 text-[10px] font-bold text-slate-400 tracking-widest uppercase font-label cursor-pointer select-none";
    if (col.align === "right") th.className += " text-right";
    th.textContent = col.label;
    th.dataset.sortKey = col.key;
    hRow.appendChild(th);
  });
  thead.appendChild(hRow);
  table.appendChild(thead);

  /* tbody */
  const tbody = document.createElement("tbody");
  tbody.className = "divide-y divide-white/5";
  tbody.id = "metrics-tools-tbody";

  function populateToolRows(data) {
    tbody.textContent = "";
    data.forEach(row => {
      const tr = document.createElement("tr");
      tr.className = "hover:bg-white/5 transition-colors";

      const tdTool = document.createElement("td");
      tdTool.className = "px-6 py-4 text-xs font-mono text-on-surface";
      tdTool.textContent = row.tool ?? "";
      tr.appendChild(tdTool);

      const tdCalls = document.createElement("td");
      tdCalls.className = "px-6 py-4 text-xs font-mono text-on-surface text-right";
      tdCalls.textContent = fmt(row.total_calls ?? 0);
      tr.appendChild(tdCalls);

      const tdSr = document.createElement("td");
      tdSr.className = "px-6 py-4 text-xs font-mono text-right";
      const srVal  = row.success_rate ?? 1;
      tdSr.className += srVal < 0.95 ? " text-error" : " text-tertiary";
      tdSr.textContent = fmtPct(srVal);
      tr.appendChild(tdSr);

      const tdP95 = document.createElement("td");
      tdP95.className = "px-6 py-4 text-xs font-mono text-slate-400 text-right";
      tdP95.textContent = fmtMs(row.p95_ms ?? 0);
      tr.appendChild(tdP95);

      tbody.appendChild(tr);
    });
  }

  populateToolRows(tools);
  table.appendChild(tbody);
  wrap.appendChild(table);

  /* 정렬 */
  let sortKey = null;
  let sortAsc  = true;
  hRow.querySelectorAll("th").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.sortKey;
      if (sortKey === key) {
        sortAsc = !sortAsc;
      } else {
        sortKey = key;
        sortAsc = true;
      }
      const sorted = [...tools].sort((a, b) => {
        const av = a[key] ?? 0;
        const bv = b[key] ?? 0;
        if (typeof av === "string") return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
        return sortAsc ? av - bv : bv - av;
      });
      populateToolRows(sorted);
    });
  });

  return wrap;
}

/**
 * 에러 분포 테이블을 반환한다.
 *
 * @param {Array<{error_type: string, count: number, last_seen: string}>} errors
 * @returns {HTMLElement}
 */
function renderErrorsTable(errors) {
  const wrap = document.createElement("div");
  wrap.className = "glass-panel overflow-x-auto";

  const header = document.createElement("p");
  header.className = "text-[10px] font-bold text-slate-400 tracking-widest uppercase px-6 pt-5 pb-3 font-label";
  header.textContent = "ERROR DISTRIBUTION";
  wrap.appendChild(header);

  if (!errors || errors.length === 0) {
    const empty = document.createElement("p");
    empty.className = "text-[10px] text-slate-600 text-center py-6";
    empty.textContent = "No errors";
    wrap.appendChild(empty);
    return wrap;
  }

  const table = document.createElement("table");
  table.className = "w-full text-left border-collapse metrics-table";
  table.id = "metrics-errors-table";

  const thead = document.createElement("thead");
  thead.className = "bg-white/5 border-b border-white/5";
  const hRow = document.createElement("tr");
  ["Error Type", "Count", "Last Seen"].forEach((label, i) => {
    const th = document.createElement("th");
    th.className = "px-6 py-4 text-[10px] font-bold text-slate-400 tracking-widest uppercase font-label";
    if (i > 0) th.className += " text-right";
    th.textContent = label;
    hRow.appendChild(th);
  });
  thead.appendChild(hRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  tbody.className = "divide-y divide-white/5";
  tbody.id = "metrics-errors-tbody";

  errors.forEach(row => {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-white/5 transition-colors";

    const tdType = document.createElement("td");
    tdType.className = "px-6 py-4 font-mono text-xs text-error";
    tdType.textContent = row.error_type ?? "";
    tr.appendChild(tdType);

    const tdCount = document.createElement("td");
    tdCount.className = "px-6 py-4 text-xs font-mono font-bold text-on-surface text-right";
    tdCount.textContent = fmt(row.count ?? 0);
    tr.appendChild(tdCount);

    const tdLast = document.createElement("td");
    tdLast.className = "px-6 py-4 text-xs font-mono text-slate-500 text-right";
    tdLast.textContent = fmtDate(row.last_seen);
    tr.appendChild(tdLast);

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

/* ── 주 렌더러 ───────────────────────────────────────────── */

/**
 * 메트릭 뷰 전체를 container에 렌더링한다.
 *
 * @param {HTMLElement} container
 * @param {{ data: any, error?: string, loading?: boolean }} viewState
 */
export function renderMetricsView(container, viewState = {}) {
  container.textContent = "";

  const { data, error, loading } = viewState;

  /* ── 헤더 ── */
  const header = document.createElement("div");
  header.className = "flex justify-between items-end mb-8";

  const headerLeft = document.createElement("div");
  const h2 = document.createElement("h2");
  h2.className = "text-2xl font-headline font-bold text-on-surface tracking-tight";
  h2.textContent = "Metrics Dashboard";
  headerLeft.appendChild(h2);

  const subtitle = document.createElement("p");
  subtitle.className = "text-sm text-slate-400 mt-1";
  subtitle.textContent = "실시간 시스템 지표. 30초 자동 갱신.";
  headerLeft.appendChild(subtitle);
  header.appendChild(headerLeft);

  const headerRight = document.createElement("div");
  headerRight.className = "flex items-center gap-4";

  const generatedAt = data?.generated_at ?? null;
  const syncLabel = document.createElement("span");
  syncLabel.className = "text-[10px] font-mono text-slate-500 uppercase";
  syncLabel.id = "metrics-last-updated";
  syncLabel.textContent = generatedAt ? "UPDATED: " + fmtDate(generatedAt) : "--";
  headerRight.appendChild(syncLabel);

  /* 시간 범위 토글 버튼 그룹 */
  const rangeGroup = document.createElement("div");
  rangeGroup.className = "metrics-time-range-group";
  rangeGroup.id = "metrics-time-range-group";

  [5, 30].forEach(min => {
    const btn = document.createElement("button");
    btn.className = "metrics-time-range-btn" + (_timeRangeMin === min ? " metrics-time-range-btn--active" : "");
    btn.textContent = min === 5 ? "5m" : "30m";
    btn.dataset.rangeMin = String(min);
    btn.addEventListener("click", () => {
      _timeRangeMin = min;
      /* sparkline 영역만 재렌더링 — 카드 DOM을 전부 재생성하지 않음 */
      const grid = container.querySelector(".metrics-card-grid");
      if (grid) {
        grid.querySelectorAll(".metrics-card-sparkline").forEach(wrap => {
          const key  = wrap.dataset.sparklineKey;
          const raw  = data?.timeseries?.[key] ?? [];
          const pts  = filterByWindow(raw, _timeRangeMin * 60 * 1000);
          renderSparkline(wrap, pts, { width: 160, height: 40 });
        });
      }
      /* 버튼 active 상태 갱신 */
      rangeGroup.querySelectorAll(".metrics-time-range-btn").forEach(b => {
        if (Number(b.dataset.rangeMin) === _timeRangeMin) {
          b.className = "metrics-time-range-btn metrics-time-range-btn--active";
        } else {
          b.className = "metrics-time-range-btn";
        }
      });
    });
    rangeGroup.appendChild(btn);
  });

  headerRight.appendChild(rangeGroup);

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "btn px-3 py-1.5 text-[10px] font-bold flex items-center gap-1 border-primary/30 text-primary";
  refreshBtn.id = "metrics-refresh-btn";
  const refreshIcon = document.createElement("span");
  refreshIcon.className = "material-symbols-outlined text-sm";
  refreshIcon.textContent = "refresh";
  refreshBtn.appendChild(refreshIcon);
  refreshBtn.appendChild(document.createTextNode("REFRESH"));
  headerRight.appendChild(refreshBtn);

  header.appendChild(headerRight);
  container.appendChild(header);

  /* ── 로딩 ── */
  if (loading) {
    container.appendChild(loadingHtml());
    return;
  }

  /* ── 에러 ── */
  if (error) {
    const errBox = document.createElement("div");
    errBox.className = "glass-panel p-6 border-l-2 border-error text-error text-sm font-mono";
    errBox.id = "metrics-error-box";
    errBox.textContent = error;
    container.appendChild(errBox);
    return;
  }

  /* ── 카드 grid ── */
  const cardsData      = data?.cards ?? {};
  const timeseriesData = data?.timeseries ?? null;
  container.appendChild(renderCardGrid(cardsData, timeseriesData));

  /* ── 테이블 영역 ── */
  const tables = document.createElement("div");
  tables.className = "grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6";

  const toolsData  = data?.tools ?? [];
  const errorsData = data?.errors ?? [];

  tables.appendChild(renderToolsTable(toolsData));
  tables.appendChild(renderErrorsTable(errorsData));

  container.appendChild(tables);
}

/* ── Polling 마운트 ──────────────────────────────────────── */

/**
 * 메트릭 뷰를 마운트하고 30초 polling을 시작한다.
 * visibilitychange 이벤트로 탭 비활성 시 polling을 일시 중지한다.
 *
 * @param {HTMLElement} container
 * @returns {{ unmount: () => void }}
 */
export function mountMetricsView(container) {
  let mounted = true;

  async function refresh() {
    if (!mounted) return;

    /* 최초 호출 시에만 loading 표시 (재갱신은 현재 화면 유지) */
    const isFirst = container.childElementCount === 0 || container.querySelector("#metrics-last-updated") === null;
    if (isFirst) {
      renderMetricsView(container, { loading: true });
    }

    const res = await fetchMetricsSummary();

    if (!mounted) return;

    if (res.ok) {
      renderMetricsView(container, { data: res.data });
    } else if (res.status === 403 || res.status === 401) {
      renderMetricsView(container, { error: "접근 권한이 없습니다 (master 키 또는 admin 권한 필요). HTTP " + res.status });
    } else {
      renderMetricsView(container, { error: res.error ?? ("API 오류: HTTP " + res.status) });
    }

    /* 수동 새로고침 버튼 이벤트 재등록 */
    container.querySelector("#metrics-refresh-btn")?.addEventListener("click", refresh);
  }

  /* 최초 로드 */
  refresh();

  /* 30초 polling */
  _pollInterval = setInterval(() => {
    if (document.visibilityState !== "hidden") refresh();
  }, 30000);

  /* visibilitychange: 탭 복귀 시 즉시 갱신 */
  function onVisibility() {
    if (document.visibilityState === "visible") refresh();
  }
  document.addEventListener("visibilitychange", onVisibility);
  _visHandler = onVisibility;

  return {
    unmount() {
      mounted = false;
      if (_pollInterval !== null) {
        clearInterval(_pollInterval);
        _pollInterval = null;
      }
      if (_visHandler !== null) {
        document.removeEventListener("visibilitychange", _visHandler);
        _visHandler = null;
      }
    }
  };
}
