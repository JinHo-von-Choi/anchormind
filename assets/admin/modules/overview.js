/**
 * Memento MCP Admin Console — Overview 대시보드 뷰
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 */

import { state, navigate, beginRender, onViewCleanup } from "./state.js";
import { api }               from "./api.js";
import { renderCommandBar }  from "./layout.js";
import { loadStats }         from "./stats.js";
import { createAutoRefresh } from "./auto-refresh.js";
import { fmt, fmtBytes, loadingHtml, relativeTime } from "./format.js";

export function renderOverviewCards(stats) {
  if (!stats) return loadingHtml();

  const cards  = [
    { label: "총 파편 수",    value: fmt(stats.fragments),             icon: "database" },
    { label: "활성 세션",     value: fmt(stats.sessions),              icon: "groups" },
    { label: "오늘 요청 수",   value: fmt(stats.apiCallsToday),         icon: "api" },
    { label: "오늘 도구 호출", value: fmt(stats.toolCallsToday),        icon: "build" },
    { label: "활성 키",       value: fmt(stats.activeKeys),            icon: "vpn_key" },
    { label: "DB 크기",       value: stats.system?.dbSizeBytes ? fmtBytes(stats.system.dbSizeBytes) : "--", icon: "storage" },
    { label: "Redis 상태",    value: stats.redis ?? "unknown",         icon: "memory" }
  ];

  const grid = document.createElement("div");
  grid.className = "grid grid-cols-1 md:grid-cols-4 lg:grid-cols-7 gap-4 mb-8";

  cards.forEach(c => {
    const card = document.createElement("div");
    card.className = "glass-panel p-5 relative overflow-hidden group";
    card.dataset.kpi = c.label;

    /* Ghost icon */
    const ghost = document.createElement("div");
    ghost.className = "absolute top-0 right-0 p-2 opacity-10 group-hover:opacity-20 transition-opacity";
    const ghostIcon = document.createElement("span");
    ghostIcon.className = "material-symbols-outlined text-4xl";
    ghostIcon.textContent = c.icon;
    ghost.appendChild(ghostIcon);
    card.appendChild(ghost);

    /* Label */
    const label = document.createElement("div");
    label.className = "text-[10px] font-mono text-slate-400 mb-1 uppercase tracking-wider";
    label.textContent = c.label;
    card.appendChild(label);

    /* Value */
    const val = document.createElement("div");
    val.className = "metric-label text-2xl text-on-surface";
    val.textContent = c.value;
    card.appendChild(val);

    /* Trend */
    const trend = document.createElement("div");
    trend.className = "text-[10px] font-mono text-primary mt-2";
    trend.textContent = "--";
    card.appendChild(trend);

    grid.appendChild(card);
  });
  return grid;
}

export function renderHealthPanel(stats) {
  if (!stats) return null;
  const sys = stats.system ?? {};

  const panel = document.createElement("section");
  panel.className = "glass-panel overflow-hidden";

  /* Header */
  const header = document.createElement("div");
  header.className = "bg-surface-container-highest px-6 py-3 flex justify-between items-center border-b border-white/5";
  const title = document.createElement("h2");
  title.className = "font-headline font-bold text-sm tracking-widest text-slate-200";
  title.textContent = "SYSTEM_HEALTH_MONITOR";
  header.appendChild(title);

  const rtWrap = document.createElement("div");
  rtWrap.className = "flex items-center gap-2";
  const rtDot = document.createElement("div");
  rtDot.className = "w-1.5 h-1.5 rounded-full bg-tertiary pulsing-glow";
  rtWrap.appendChild(rtDot);
  const rtLabel = document.createElement("span");
  rtLabel.className = "text-[9px] font-mono text-slate-400 uppercase tracking-widest";
  rtLabel.textContent = "REALTIME";
  rtWrap.appendChild(rtLabel);
  header.appendChild(rtWrap);
  panel.appendChild(header);

  /* Body */
  const body = document.createElement("div");
  body.className = "p-8 grid grid-cols-1 md:grid-cols-5 gap-8";

  /* Left: meters */
  const metersCol = document.createElement("div");
  metersCol.className = "md:col-span-3 grid grid-cols-2 gap-x-12 gap-y-8";

  function barFillClass(pct) {
    if (pct > 85) return "bg-error";
    if (pct > 60) return "bg-tertiary/40";
    return "bg-primary/40";
  }

  [
    { label: "CPU LOAD",      pct: sys.cpu ?? 0 },
    { label: "MEMORY UTIL",   pct: sys.memory ?? 0 },
    { label: "DISK I/O",      pct: sys.disk ?? 0 },
    { label: "QUEUE BACKLOG", pct: 0 }
  ].forEach(b => {
    const meter = document.createElement("div");
    meter.className = "space-y-2";

    const row = document.createElement("div");
    row.className = "flex justify-between items-end";
    const lbl = document.createElement("span");
    lbl.className = "text-[11px] font-mono text-slate-400";
    lbl.textContent = b.label;
    row.appendChild(lbl);
    const valSpan = document.createElement("span");
    valSpan.className = "text-sm font-mono text-slate-100";
    valSpan.textContent = b.pct + "%";
    row.appendChild(valSpan);
    meter.appendChild(row);

    const track = document.createElement("div");
    track.className = "h-1.5 w-full bg-slate-900 overflow-hidden";
    const fill = document.createElement("div");
    fill.className = "h-full " + barFillClass(b.pct) + " border-r";
    fill.style.width = b.pct + "%";
    track.appendChild(fill);
    meter.appendChild(track);

    metersCol.appendChild(meter);
  });
  body.appendChild(metersCol);

  /* Right: uptime + info */
  const infoCol = document.createElement("div");
  infoCol.className = "md:col-span-2 border-l border-white/5 pl-8 flex flex-col justify-center space-y-4";

  const uptimeLabel = document.createElement("div");
  uptimeLabel.className = "text-[10px] font-mono text-slate-500 mb-1";
  uptimeLabel.textContent = "SYSTEM UPTIME";
  infoCol.appendChild(uptimeLabel);

  const uptimeVal = document.createElement("div");
  uptimeVal.className = "text-2xl font-headline font-light tracking-tight text-on-surface";
  uptimeVal.textContent = stats.uptime ?? "--";
  infoCol.appendChild(uptimeVal);

  const infoBox = document.createElement("div");
  infoBox.className = "p-3 glass-panel border border-white/5 text-[10px] font-mono leading-relaxed";
  const infoPrefix = document.createElement("span");
  infoPrefix.className = "text-primary-dim";
  infoPrefix.textContent = "INFO: ";
  infoBox.appendChild(infoPrefix);
  infoBox.appendChild(document.createTextNode("PostgreSQL: " + (stats.db ?? "unknown") + " / Redis: " + (stats.redis ?? "unknown") + " / Node: " + (stats.nodeVersion ?? "--")));
  infoCol.appendChild(infoBox);

  body.appendChild(infoCol);
  panel.appendChild(body);

  return panel;
}

export function renderTimeline(activities) {
  const panel = document.createElement("section");
  panel.className = "glass-panel";

  /* Header */
  const header = document.createElement("div");
  header.className = "bg-surface-container-highest px-6 py-3 flex justify-between items-center";
  const title = document.createElement("h2");
  title.className = "font-headline font-bold text-sm tracking-widest text-slate-200 uppercase";
  title.textContent = "Memory Activity Timeline";
  header.appendChild(title);

  const viewAllBtn = document.createElement("button");
  viewAllBtn.className = "text-[10px] font-mono text-slate-400 hover:text-primary";
  viewAllBtn.textContent = "VIEW ALL LOGS";
  viewAllBtn.addEventListener("click", () => navigate("logs"));
  header.appendChild(viewAllBtn);
  panel.appendChild(header);

  if (!activities || !activities.length) {
    const empty = document.createElement("div");
    empty.className = "text-sm text-slate-600 py-6 text-center";
    empty.textContent = "활동 없음";
    panel.appendChild(empty);
    return panel;
  }

  const list = document.createElement("div");
  list.className = "divide-y divide-white/5";

  const typeColors = { fact: "bg-primary", error: "bg-tertiary", decision: "bg-secondary", procedure: "bg-slate-500", preference: "bg-primary" };
  const badgeColors = { fact: "border-primary/30 text-primary", error: "border-tertiary/30 text-tertiary", decision: "border-secondary/30 text-secondary", procedure: "border-slate-400/30 text-slate-400", preference: "border-primary/30 text-primary" };

  activities.forEach(a => {
    const row = document.createElement("div");
    row.className = "p-4 flex items-center gap-6 hover:bg-white/[0.02] transition-colors group";

    /* Timestamp */
    const ts = document.createElement("div");
    ts.className = "text-[10px] font-mono text-slate-500 w-24";
    ts.textContent = a.created_at ? relativeTime(a.created_at) : "";
    row.appendChild(ts);

    /* Dot */
    const dotEl = document.createElement("div");
    dotEl.className = "w-2 h-2 rounded-full " + (typeColors[a.type] ?? "bg-slate-500");
    row.appendChild(dotEl);

    /* Content */
    const content = document.createElement("div");
    content.className = "flex-1";
    const titleSpan = document.createElement("div");
    titleSpan.className = "text-xs font-bold text-slate-200";
    titleSpan.textContent = a.topic ?? "(무제)";
    content.appendChild(titleSpan);
    const agentSpan = document.createElement("div");
    agentSpan.className = "text-[10px] text-slate-500 font-mono";
    agentSpan.textContent = a.agent_id ?? a.key_name ?? "--";
    content.appendChild(agentSpan);
    row.appendChild(content);

    /* Type badge */
    const badge = document.createElement("span");
    badge.className = "px-2 py-0.5 border text-[9px] font-mono uppercase tracking-widest " + (badgeColors[a.type] ?? "border-slate-400/30 text-slate-400");
    badge.textContent = a.type ?? "?";
    row.appendChild(badge);

    /* Chevron */
    const chevron = document.createElement("span");
    chevron.className = "material-symbols-outlined text-slate-600 opacity-0 group-hover:opacity-100";
    chevron.textContent = "chevron_right";
    row.appendChild(chevron);

    list.appendChild(row);
  });

  panel.appendChild(list);
  return panel;
}

export function renderRiskPanel(stats) {
  const panel = document.createElement("section");
  panel.className = "glass-panel";

  /* Header */
  const header = document.createElement("div");
  header.className = "px-5 py-3 border-b border-white/5 flex items-center justify-between";
  const title = document.createElement("span");
  title.className = "text-[10px] font-bold font-headline tracking-widest text-slate-400 uppercase";
  title.textContent = "리스크 및 이상 징후";
  header.appendChild(title);
  const alertDot = document.createElement("div");
  alertDot.className = "w-1.5 h-1.5 rounded-full bg-error pulsing-glow";
  header.appendChild(alertDot);
  panel.appendChild(header);

  /* Body */
  const body = document.createElement("div");
  body.className = "p-4 space-y-3";

  const queues = stats?.queues ?? {};

  /* Error item */
  const errItem = document.createElement("div");
  errItem.className = "flex items-start gap-3 p-3 bg-error-container/10 border border-error/20 rounded-sm";
  const errIcon = document.createElement("span");
  errIcon.className = "material-symbols-outlined text-error text-lg";
  errIcon.dataset.weight = "fill";
  errIcon.textContent = "warning";
  errItem.appendChild(errIcon);
  const errText = document.createElement("div");
  const errTitle = document.createElement("div");
  errTitle.className = "text-[11px] font-bold text-error";
  errTitle.textContent = "Embedding Backlog";
  errText.appendChild(errTitle);
  const errDesc = document.createElement("div");
  errDesc.className = "text-[9px] text-slate-400";
  errDesc.textContent = (queues.embeddingBacklog ?? 0) + " items pending";
  errText.appendChild(errDesc);
  errItem.appendChild(errText);
  body.appendChild(errItem);

  /* Normal items */
  [
    { label: "Quality Pending", value: fmt(queues.qualityPending ?? 0) }
  ].forEach(n => {
    const item = document.createElement("div");
    item.className = "flex items-center justify-between p-2.5 bg-surface-container border border-white/5";
    const lbl = document.createElement("span");
    lbl.className = "text-[10px] font-mono text-slate-300";
    lbl.textContent = n.label;
    item.appendChild(lbl);
    const badge = document.createElement("span");
    badge.className = "px-1.5 py-0.5 bg-secondary-container/30 text-[8px] text-secondary-fixed font-bold";
    badge.textContent = n.value;
    item.appendChild(badge);
    body.appendChild(item);
  });

  panel.appendChild(body);
  return panel;
}

export function renderQuickActions() {
  const panel = document.createElement("section");
  panel.className = "glass-panel";

  /* Header */
  const header = document.createElement("div");
  header.className = "px-5 py-3 border-b border-white/5";
  const title = document.createElement("span");
  title.className = "text-[10px] font-bold font-headline tracking-widest text-slate-400 uppercase";
  title.textContent = "빠른 작업";
  header.appendChild(title);
  panel.appendChild(header);

  /* Body */
  const body = document.createElement("div");
  body.className = "p-4 grid grid-cols-2 gap-2";

  [
    { icon: "add_link",  label: "Create Key",   view: "keys" },
    { icon: "group_add", label: "Create Group",  view: "groups" },
    { icon: "fact_check", label: "Review Queue", view: "review" },
    { icon: "list_alt",  label: "Open Logs",     view: "logs" }
  ].forEach(a => {
    const btn = document.createElement("button");
    btn.className = "flex flex-col items-center justify-center p-3 bg-white/[0.03] hover:bg-white/[0.08] transition-all border border-white/5 group";

    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined text-slate-400 group-hover:text-primary mb-2";
    icon.textContent = a.icon;
    btn.appendChild(icon);

    const label = document.createElement("span");
    label.className = "text-[10px] font-mono text-slate-300";
    label.textContent = a.label;
    btn.appendChild(label);

    if (a.view) {
      btn.addEventListener("click", () => navigate(a.view));
    }

    body.appendChild(btn);
  });

  panel.appendChild(body);
  return panel;
}

export function renderLatencyIndex(stats) {
  const panel = document.createElement("div");
  panel.className = "glass-panel p-4";

  const label = document.createElement("div");
  label.className = "text-[10px] font-mono text-slate-500 mb-3 tracking-widest uppercase";
  label.textContent = "Search Latency p50 (ms)";
  panel.appendChild(label);

  const sm = stats?.searchMetrics ?? null;
  const layers = [
    { key: "L1", cls: "bg-primary/20 hover:bg-primary/40 border-t-2 border-primary" },
    { key: "L2", cls: "bg-secondary/20 hover:bg-secondary/40 border-t-2 border-secondary" },
    { key: "L3", cls: "bg-tertiary/20 hover:bg-tertiary/40 border-t-2 border-tertiary" }
  ].map(l => ({ ...l, p50: sm?.[l.key]?.p50 ?? null }));

  const known = layers.filter(l => l.p50 != null);
  if (known.length === 0) {
    const empty = document.createElement("div");
    empty.className = "text-[11px] text-slate-600 font-mono py-4";
    empty.textContent = "--";
    panel.appendChild(empty);
    return panel;
  }

  const maxP50 = Math.max(...known.map(l => Number(l.p50)), 1);
  const bars = document.createElement("div");
  bars.className = "flex items-end gap-2 h-16";

  layers.forEach(b => {
    const barWrap = document.createElement("div");
    barWrap.className = "flex-1 relative group";
    barWrap.style.height = "100%";
    barWrap.style.display = "flex";
    barWrap.style.alignItems = "flex-end";
    const bar = document.createElement("div");
    bar.className = b.cls;
    bar.style.width = "100%";
    bar.style.height = b.p50 != null ? Math.max(6, Math.round((Number(b.p50) / maxP50) * 100)) + "%" : "0%";
    barWrap.appendChild(bar);
    const tooltip = document.createElement("span");
    tooltip.className = "absolute -top-4 text-[8px] font-mono hidden group-hover:block";
    tooltip.textContent = b.p50 != null ? `${b.key} ${Math.round(Number(b.p50))}ms` : `${b.key} --`;
    barWrap.appendChild(tooltip);
    bars.appendChild(barWrap);
  });

  panel.appendChild(bars);
  return panel;
}

export function renderQualityCoverage(stats) {
  const panel = document.createElement("div");
  panel.className = "glass-panel p-4 flex items-center gap-4";

  const q     = stats?.quality ?? null;
  const total = Number(q?.total) || 0;
  const ratio = total > 0 ? (Number(q.verified) || 0) / total : null;

  /* SVG donut */
  const svgWrap = document.createElement("div");
  svgWrap.className = "relative";
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", "64");
  svg.setAttribute("height", "64");

  const circleBg = document.createElementNS(svgNS, "circle");
  circleBg.setAttribute("cx", "32");
  circleBg.setAttribute("cy", "32");
  circleBg.setAttribute("r", "28");
  circleBg.setAttribute("fill", "none");
  circleBg.setAttribute("stroke-width", "4");
  circleBg.setAttribute("class", "text-white/10");
  circleBg.setAttribute("stroke", "currentColor");
  svg.appendChild(circleBg);

  const circleFg = document.createElementNS(svgNS, "circle");
  circleFg.setAttribute("cx", "32");
  circleFg.setAttribute("cy", "32");
  circleFg.setAttribute("r", "28");
  circleFg.setAttribute("fill", "none");
  circleFg.setAttribute("stroke-width", "4");
  circleFg.setAttribute("class", "text-primary");
  circleFg.setAttribute("stroke", "currentColor");
  circleFg.setAttribute("stroke-dasharray", "175.9");
  circleFg.setAttribute("stroke-dashoffset", String(175.9 * (1 - (ratio ?? 0))));
  circleFg.setAttribute("transform", "rotate(-90 32 32)");
  svg.appendChild(circleFg);
  svgWrap.appendChild(svg);

  const centerText = document.createElement("div");
  centerText.className = "absolute inset-0 flex items-center justify-center text-[10px] font-bold";
  centerText.textContent = ratio != null ? Math.round(ratio * 100) + "%" : "--";
  svgWrap.appendChild(centerText);
  panel.appendChild(svgWrap);

  /* Right text */
  const textWrap = document.createElement("div");
  const textLabel = document.createElement("div");
  textLabel.className = "text-[10px] font-mono text-slate-400 uppercase";
  textLabel.textContent = "Quality Verified";
  textWrap.appendChild(textLabel);
  const textVal = document.createElement("div");
  textVal.className = "text-xs text-slate-200 mt-1 font-bold";
  textVal.textContent = ratio != null ? fmt(Number(q.verified) || 0) + " / " + fmt(total) + " fragments" : "--";
  textWrap.appendChild(textVal);
  panel.appendChild(textWrap);

  return panel;
}

export function renderTopTopics(stats) {
  const panel = document.createElement("div");
  panel.className = "glass-panel p-4";

  const label = document.createElement("div");
  label.className = "text-[10px] font-mono text-slate-500 mb-2 uppercase tracking-widest";
  label.textContent = "TOP TOPICS";
  panel.appendChild(label);

  const list = document.createElement("div");
  list.className = "space-y-2";

  const topics = stats?.topTopics ?? [];
  const total  = Number(stats?.fragments) || 0;

  if (topics.length === 0) {
    const empty = document.createElement("div");
    empty.className = "text-[11px] text-slate-600 font-mono";
    empty.textContent = "--";
    list.appendChild(empty);
  }

  topics.forEach(t => {
    const row = document.createElement("div");
    row.className = "flex justify-between items-center text-[10px] font-mono";
    const name = document.createElement("span");
    name.className = "text-slate-300";
    name.textContent = t.topic ?? "(무제)";
    row.appendChild(name);
    const pct = document.createElement("span");
    pct.className = "text-slate-500";
    const cnt = Number(t.count) || 0;
    pct.textContent = total > 0 ? Math.round((cnt / total) * 100) + "%" : String(cnt);
    row.appendChild(pct);
    list.appendChild(row);
  });

  panel.appendChild(list);
  return panel;
}

/** 스케줄러 작업 이름 → 화면 표시 이름 */
const SCHEDULER_JOB_LABELS = {
  outbox:            "아웃박스 처리",
  graphLinker:       "그래프 링크",
  morphemeBackfill:  "형태소 백필",
  embeddingBackfill: "임베딩 백필"
};

function opsRow(labelText, valueText, cls = "") {
  const row = document.createElement("div");
  row.className = "flex justify-between gap-4 text-[11px] py-1 border-b border-white/5";
  const l = document.createElement("span");
  l.className   = "text-slate-400";
  l.textContent = labelText;
  const v = document.createElement("span");
  v.className   = "font-mono text-right " + cls;
  v.textContent = valueText;
  row.appendChild(l);
  row.appendChild(v);
  return row;
}

/**
 * 운영 상태 패널: 스케줄러 작업의 마지막 성공과 실패, 마지막 통합 실행, 기능 스위치 요약.
 *
 * @param {Object|null} stats - /stats 응답
 * @returns {HTMLElement}
 */
export function renderOpsPanel(stats) {
  const panel = document.createElement("section");
  panel.className = "glass-panel p-5";
  panel.id = "ops-panel";

  const title = document.createElement("h3");
  title.className   = "text-[10px] font-bold font-headline tracking-widest text-slate-400 uppercase mb-3";
  title.textContent = "운영 상태";
  panel.appendChild(title);

  const jobs = Object.entries(stats?.schedulerJobs ?? {});
  const jobsTitle = document.createElement("div");
  jobsTitle.className   = "text-[10px] text-slate-500 uppercase mt-1 mb-1";
  jobsTitle.textContent = "스케줄러 작업";
  panel.appendChild(jobsTitle);
  if (jobs.length === 0) {
    panel.appendChild(opsRow("등록된 작업", "없음"));
  }
  for (const [name, job] of jobs) {
    const failed  = job.lastFailure && (!job.lastSuccess || new Date(job.lastFailure) > new Date(job.lastSuccess));
    const success = job.lastSuccess ? `성공 ${relativeTime(job.lastSuccess)}` : "성공 기록 없음";
    const value   = `${success} · 실행 ${fmt(job.runCount ?? 0)} · 실패 ${fmt(job.failureCount ?? 0)}`;
    const row     = opsRow(SCHEDULER_JOB_LABELS[name] ?? name, value, failed ? "text-error" : "text-slate-300");
    if (failed && job.lastError) row.title = String(job.lastError);
    panel.appendChild(row);
  }

  const consolidation = stats?.lastConsolidation;
  panel.appendChild(opsRow(
    "마지막 통합 실행",
    consolidation?.timestamp
      ? `${relativeTime(consolidation.timestamp)} · 만료 삭제 ${fmt(consolidation.expiredDeleted ?? 0)} · 병합 ${fmt(consolidation.duplicatesMerged ?? 0)}`
      : "서버 시작 뒤 실행 기록 없음"
  ));

  const sw = stats?.switches;
  if (sw) {
    panel.appendChild(opsRow("기능 스위치", `켜짐 ${fmt(sw.on)} · 꺼짐 ${fmt(sw.off)} · 모드 ${fmt(sw.mode)} · 기본값과 다름 ${fmt(sw.nonDefaultCount)}`));
    if (Array.isArray(sw.invalid) && sw.invalid.length > 0) {
      panel.appendChild(opsRow("잘못된 설정값", sw.invalid.join(", "), "text-error"));
    }
    if (Array.isArray(sw.nonDefault) && sw.nonDefault.length > 0) {
      const details = document.createElement("details");
      details.className = "mt-2 text-[10px]";
      const summary = document.createElement("summary");
      summary.className   = "cursor-pointer text-slate-500";
      summary.textContent = "기본값과 다른 스위치 보기";
      details.appendChild(summary);
      const list = document.createElement("div");
      list.className   = "font-mono text-slate-400 mt-1 break-all";
      list.textContent = sw.nonDefault.join(", ");
      details.appendChild(list);
      panel.appendChild(details);
    }
  }
  return panel;
}

/** 슬롯 내용을 바꾼다. node가 없으면 비운다. */
function fillSlot(slot, node) {
  slot.textContent = "";
  if (node) slot.appendChild(node);
}

function slotError(message) {
  const el = document.createElement("div");
  el.className   = "glass-panel p-4 text-xs text-error";
  el.textContent = message;
  return el;
}

/**
 * 개요 화면. 패널마다 따로 불러와 그리고, 자동 갱신 중에는 새 값이 올 때까지 이전 값을 유지한다.
 *
 * @param {HTMLElement} container
 */
export async function renderOverview(container) {
  const ctx = beginRender();
  container.textContent = "";

  const header = document.createElement("div");
  header.className = "flex justify-end mb-4";
  container.appendChild(header);

  const kpiSlot = document.createElement("div");
  kpiSlot.appendChild(loadingHtml());
  container.appendChild(kpiSlot);

  /* Main Layout: flex row */
  const mainLayout = document.createElement("div");
  mainLayout.className = "flex flex-col lg:flex-row gap-8";

  /* LEFT */
  const leftCol = document.createElement("div");
  leftCol.className = "flex-1 space-y-8";
  const healthSlot   = document.createElement("div");
  const opsSlot      = document.createElement("div");
  const timelineSlot = document.createElement("div");
  timelineSlot.appendChild(loadingHtml());
  leftCol.appendChild(healthSlot);
  leftCol.appendChild(opsSlot);
  leftCol.appendChild(timelineSlot);
  mainLayout.appendChild(leftCol);

  /* RIGHT */
  const rightCol = document.createElement("div");
  rightCol.className = "w-full lg:w-80 space-y-6";
  const riskSlot = document.createElement("div");
  rightCol.appendChild(riskSlot);
  rightCol.appendChild(renderQuickActions());
  const sideSlot = document.createElement("div");
  sideSlot.className = "space-y-6";
  rightCol.appendChild(sideSlot);
  mainLayout.appendChild(rightCol);

  container.appendChild(mainLayout);

  let statsShown    = false;
  let activityShown = false;

  async function refreshStats() {
    const res = await loadStats();
    if (!ctx.isCurrent()) return;
    if (!res.ok) {
      if (!statsShown) fillSlot(kpiSlot, slotError(`통계 조회 실패 (${res.status || res.error})`));
      return;
    }
    statsShown = true;
    renderCommandBar();
    fillSlot(kpiSlot, renderOverviewCards(state.stats));
    fillSlot(healthSlot, renderHealthPanel(state.stats));
    fillSlot(opsSlot, renderOpsPanel(state.stats));
    fillSlot(riskSlot, renderRiskPanel(state.stats));
    const side = document.createDocumentFragment();
    side.appendChild(renderLatencyIndex(state.stats));
    side.appendChild(renderQualityCoverage(state.stats));
    side.appendChild(renderTopTopics(state.stats));
    fillSlot(sideSlot, side);
    auto.markUpdated();
  }

  async function refreshActivity() {
    const res = await api("/activity", { signal: ctx.signal });
    if (!ctx.isCurrent()) return;
    if (!res.ok) {
      if (!activityShown) fillSlot(timelineSlot, slotError(`활동 조회 실패 (${res.status || res.error})`));
      return;
    }
    activityShown = true;
    fillSlot(timelineSlot, renderTimeline(res.data ?? []));
  }

  const refresh = () => Promise.all([refreshStats(), refreshActivity()]);
  const auto    = createAutoRefresh(refresh);
  onViewCleanup(auto.stop);
  header.appendChild(auto.element);

  /* Backdrop accents */
  if (!document.querySelector(".backdrop-accent-primary")) {
    const bp = document.createElement("div");
    bp.className = "backdrop-accent-primary";
    document.body.appendChild(bp);
    const bs = document.createElement("div");
    bs.className = "backdrop-accent-secondary";
    document.body.appendChild(bs);
  }

  await refresh();
}
