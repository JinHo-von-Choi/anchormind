/**
 * Memento MCP Admin Console — Logs 뷰 렌더러
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 */

import { state }                                from "./state.js";
import { api }                                  from "./api.js";
import { fmt, fmtBytes, truncate, loadingHtml } from "./format.js";

export async function renderLogs(container) {
  container.textContent = "";
  container.appendChild(loadingHtml());

  const [statsRes, filesRes] = await Promise.all([
    api("/logs/stats"),
    api("/logs/files")
  ]);

  state.logStats = statsRes.ok ? statsRes.data : null;
  state.logFiles = filesRes.ok ? (filesRes.data?.files ?? []) : [];

  if (!state.logFile && state.logFiles.length) {
    const today = state.logFiles.find(f => f.type === "combined");
    if (today) state.logFile = today.name;
  }

  if (state.logFile) {
    const params = new URLSearchParams({ file: state.logFile, tail: state.logTail });
    if (state.logLevel)  params.set("level", state.logLevel);
    if (state.logSearch) params.set("search", state.logSearch);
    const readRes = await api("/logs/read?" + params);
    state.logLines = readRes.ok ? (readRes.data?.lines ?? []) : [];
  }

  container.textContent = "";

  /* Header */
  const header = document.createElement("div");
  header.className = "flex justify-between items-end mb-8";
  const headerLeft = document.createElement("div");
  const h2 = document.createElement("h2");
  h2.className = "text-2xl font-headline font-bold text-on-surface tracking-tight";
  h2.textContent = "System Logs";
  headerLeft.appendChild(h2);
  const subtitle = document.createElement("p");
  subtitle.className = "text-sm text-slate-400 mt-1";
  subtitle.textContent = "Winston log files viewer and level filtering.";
  headerLeft.appendChild(subtitle);
  header.appendChild(headerLeft);

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "btn-primary px-5 py-2.5 bg-primary-container text-on-primary-fixed font-bold text-sm flex items-center gap-2";
  const refreshIcon = document.createElement("span");
  refreshIcon.className = "material-symbols-outlined text-lg";
  refreshIcon.textContent = "refresh";
  refreshBtn.appendChild(refreshIcon);
  refreshBtn.appendChild(document.createTextNode("REFRESH"));
  refreshBtn.addEventListener("click", () => renderLogs(container));
  header.appendChild(refreshBtn);
  container.appendChild(header);

  /* KPI Row */
  container.appendChild(renderLogKpiRow(state.logStats));

  /* Main layout: viewer + sidebar */
  const split = document.createElement("div");
  split.className = "flex gap-6";

  const left = document.createElement("div");
  left.className = "flex-1 space-y-4";
  left.appendChild(renderLogFilterBar());
  left.appendChild(renderLogViewer(state.logLines));
  split.appendChild(left);

  split.appendChild(renderLogSidebar(state.logFiles, state.logStats));
  container.appendChild(split);

  /* Event: apply filter */
  document.getElementById("log-apply-btn")?.addEventListener("click", () => {
    state.logFile   = document.getElementById("log-file-select")?.value ?? "";
    state.logLevel  = document.getElementById("log-level-select")?.value ?? "";
    state.logSearch = document.getElementById("log-search-input")?.value ?? "";
    state.logTail   = parseInt(document.getElementById("log-tail-select")?.value) || 200;
    renderLogs(container);
  });

  /* Event: sidebar file click */
  container.querySelectorAll("[data-log-file]").forEach(el => {
    el.addEventListener("click", () => {
      state.logFile = el.dataset.logFile;
      renderLogs(container);
    });
  });
}

function renderLogKpiRow(stats) {
  const today = stats?.today ?? {};
  const cards = [
    { label: "INFO",  value: today.info ?? 0,         border: "bg-primary" },
    { label: "WARN",  value: today.warn ?? 0,         border: "bg-secondary" },
    { label: "ERROR", value: today.error ?? 0,        border: "bg-error" },
    { label: "FILES", value: stats?.fileCount ?? 0,   border: "bg-tertiary" }
  ];

  const grid = document.createElement("div");
  grid.className = "grid grid-cols-4 gap-4 mb-8";

  cards.forEach(c => {
    const card = document.createElement("div");
    card.className = "glass-panel p-4 relative overflow-hidden";

    const bar = document.createElement("div");
    bar.className = "absolute left-0 top-0 bottom-0 w-1 " + c.border;
    card.appendChild(bar);

    const label = document.createElement("p");
    label.className = "text-[10px] font-bold text-slate-500 tracking-widest uppercase mb-1 font-label";
    label.textContent = c.label;
    card.appendChild(label);

    const val = document.createElement("p");
    val.className = "text-3xl font-headline font-bold text-on-surface";
    val.textContent = fmt(c.value);
    card.appendChild(val);

    grid.appendChild(card);
  });

  return grid;
}

function renderLogFilterBar() {
  const bar = document.createElement("div");
  bar.className = "flex items-center gap-3 bg-surface-container-low p-3 rounded-sm border-l-2 border-primary/40";

  /* File select */
  const fileSelect = document.createElement("select");
  fileSelect.id = "log-file-select";
  fileSelect.className = "bg-surface-container text-[11px] text-on-surface border border-white/10 rounded-sm px-2 py-1.5 outline-none";

  const grouped = {};
  state.logFiles.forEach(f => {
    const key = f.type || "other";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(f);
  });

  Object.keys(grouped).forEach(type => {
    const optgroup = document.createElement("optgroup");
    optgroup.label = type.toUpperCase();
    grouped[type].forEach(f => {
      const opt = document.createElement("option");
      opt.value    = f.name;
      opt.selected = f.name === state.logFile;
      opt.textContent = f.name;
      optgroup.appendChild(opt);
    });
    fileSelect.appendChild(optgroup);
  });
  bar.appendChild(fileSelect);

  /* Level filter */
  const levelSelect = document.createElement("select");
  levelSelect.id = "log-level-select";
  levelSelect.className = "bg-surface-container text-[11px] text-on-surface border border-white/10 rounded-sm px-2 py-1.5 outline-none";
  ["", "info", "warn", "error", "debug"].forEach(lv => {
    const opt  = document.createElement("option");
    opt.value    = lv;
    opt.selected = lv === state.logLevel;
    opt.textContent = lv ? lv.toUpperCase() : "ALL";
    levelSelect.appendChild(opt);
  });
  bar.appendChild(levelSelect);

  /* Search input */
  const searchInput = document.createElement("input");
  searchInput.type        = "text";
  searchInput.id          = "log-search-input";
  searchInput.placeholder = "Search logs...";
  searchInput.value       = state.logSearch;
  searchInput.className   = "flex-1 bg-surface-container text-[11px] text-on-surface border border-white/10 rounded-sm px-3 py-1.5 outline-none placeholder:text-slate-500";
  bar.appendChild(searchInput);

  /* Tail count */
  const tailSelect = document.createElement("select");
  tailSelect.id = "log-tail-select";
  tailSelect.className = "bg-surface-container text-[11px] text-on-surface border border-white/10 rounded-sm px-2 py-1.5 outline-none";
  [100, 200, 500, 1000].forEach(n => {
    const opt  = document.createElement("option");
    opt.value    = String(n);
    opt.selected = n === state.logTail;
    opt.textContent = n + " lines";
    tailSelect.appendChild(opt);
  });
  bar.appendChild(tailSelect);

  /* Apply button */
  const applyBtn = document.createElement("button");
  applyBtn.id = "log-apply-btn";
  applyBtn.className = "btn px-3 py-1.5 flex items-center gap-1";
  const applyIcon = document.createElement("span");
  applyIcon.className = "material-symbols-outlined text-sm";
  applyIcon.textContent = "search";
  applyBtn.appendChild(applyIcon);
  bar.appendChild(applyBtn);

  return bar;
}

function renderLogViewer(lines) {
  const panel = document.createElement("div");
  panel.className = "glass-panel rounded-sm overflow-hidden";

  /* Header bar */
  const headerBar = document.createElement("div");
  headerBar.className = "bg-surface-container-highest px-6 py-3 flex justify-between items-center";
  const titleEl = document.createElement("span");
  titleEl.className = "text-[10px] font-bold text-slate-400 tracking-widest uppercase font-label";
  titleEl.textContent = "LOG_OUTPUT";
  headerBar.appendChild(titleEl);
  const countEl = document.createElement("span");
  countEl.className = "text-[10px] text-slate-500";
  countEl.textContent = lines.length + " lines";
  headerBar.appendChild(countEl);
  panel.appendChild(headerBar);

  /* Content */
  const content = document.createElement("div");
  content.className = "p-0 overflow-y-auto";
  content.style.maxHeight = "600px";

  if (lines.length === 0) {
    const empty = document.createElement("div");
    empty.className = "text-center text-slate-500 text-sm py-16";
    empty.textContent = "\uB85C\uADF8 \uC5C6\uC74C";
    content.appendChild(empty);
  } else {
    const levelColors = {
      info:  "text-secondary",
      warn:  "text-primary",
      error: "text-[#cc7755]",
      debug: "text-slate-600"
    };

    lines.forEach(line => {
      const row = document.createElement("div");
      row.className = "px-6 py-1 font-mono text-[11px] border-b border-white/[0.02] hover:bg-white/[0.02]";

      /* Timestamp */
      if (line.timestamp) {
        const ts = document.createElement("span");
        ts.className = "text-slate-500 mr-2";
        ts.textContent = line.timestamp;
        row.appendChild(ts);
      }

      /* Level badge */
      if (line.level) {
        const lv     = line.level.toLowerCase();
        const badge  = document.createElement("span");
        const color  = levelColors[lv] ?? "text-slate-500";
        badge.className = color + (lv === "error" ? " font-bold" : "") + " mr-2";
        badge.textContent = "[" + line.level.toUpperCase() + "]";
        row.appendChild(badge);
      }

      /* Message */
      const msg = document.createElement("span");
      msg.className = "text-slate-300";
      msg.textContent = line.message ?? (typeof line === "string" ? line : JSON.stringify(line));
      row.appendChild(msg);

      content.appendChild(row);
    });
  }

  panel.appendChild(content);
  return panel;
}

function renderLogSidebar(files, stats) {
  const sidebar = document.createElement("div");
  sidebar.className = "w-80 space-y-6";

  /* File Browser */
  const fileBrowser = document.createElement("div");
  fileBrowser.className = "glass-panel";

  const fbHeader = document.createElement("div");
  fbHeader.className = "px-4 py-3 border-b border-white/5";
  const fbTitle = document.createElement("span");
  fbTitle.className = "text-[10px] font-bold text-slate-400 tracking-widest uppercase font-label";
  fbTitle.textContent = "LOG FILES";
  fbHeader.appendChild(fbTitle);
  fileBrowser.appendChild(fbHeader);

  const iconMap = {
    combined:   "description",
    error:      "error_outline",
    agent:      "smart_toy",
    exceptions: "bug_report",
    rejections: "cancel"
  };

  /* Group files by date (newest first) */
  const byDate = {};
  files.forEach(f => {
    const dateKey = f.date ?? "unknown";
    if (!byDate[dateKey]) byDate[dateKey] = [];
    byDate[dateKey].push(f);
  });
  const dateKeys = Object.keys(byDate).sort().reverse();

  const fileList = document.createElement("div");
  fileList.className = "divide-y divide-white/5";

  dateKeys.forEach(dateKey => {
    const dateLabel = document.createElement("div");
    dateLabel.className = "px-4 py-2 text-[9px] font-bold text-slate-600 tracking-widest uppercase bg-white/[0.02]";
    dateLabel.textContent = dateKey;
    fileList.appendChild(dateLabel);

    byDate[dateKey].forEach(f => {
      const row = document.createElement("div");
      row.className = "flex justify-between items-center px-4 py-2 hover:bg-white/5 cursor-pointer transition-colors" + (f.name === state.logFile ? " bg-white/[0.04]" : "");
      row.dataset.logFile = f.name;

      const leftPart = document.createElement("div");
      leftPart.className = "flex items-center gap-2";
      const icon = document.createElement("span");
      icon.className = "material-symbols-outlined text-sm text-slate-500";
      icon.textContent = iconMap[f.type] ?? "description";
      leftPart.appendChild(icon);
      const nameEl = document.createElement("span");
      nameEl.className = "text-[11px] font-mono text-slate-300";
      nameEl.textContent = f.name;
      leftPart.appendChild(nameEl);
      row.appendChild(leftPart);

      const sizeEl = document.createElement("span");
      sizeEl.className = "text-[10px] text-slate-500";
      sizeEl.textContent = fmtBytes(f.sizeBytes);
      row.appendChild(sizeEl);

      fileList.appendChild(row);
    });
  });

  fileBrowser.appendChild(fileList);
  sidebar.appendChild(fileBrowser);

  /* Recent Errors */
  const errPanel = document.createElement("div");
  errPanel.className = "glass-panel";

  const errHeader = document.createElement("div");
  errHeader.className = "px-4 py-3 border-b border-white/5";
  const errTitle = document.createElement("span");
  errTitle.className = "text-[10px] font-bold text-error tracking-widest uppercase font-label";
  errTitle.textContent = "RECENT ERRORS";
  errHeader.appendChild(errTitle);
  errPanel.appendChild(errHeader);

  const errList = document.createElement("div");
  errList.className = "p-4 space-y-3";
  const recentErrors = stats?.recentErrors ?? [];

  if (recentErrors.length === 0) {
    const noErr = document.createElement("p");
    noErr.className = "text-[11px] text-slate-600 text-center py-4";
    noErr.textContent = "No errors today";
    errList.appendChild(noErr);
  } else {
    recentErrors.slice(0, 5).forEach(err => {
      const item = document.createElement("div");
      item.className = "text-[11px]";
      const tsEl = document.createElement("div");
      tsEl.className = "text-[10px] text-slate-500 mb-0.5";
      tsEl.textContent = err.timestamp ?? "";
      item.appendChild(tsEl);
      const msgEl = document.createElement("div");
      msgEl.className = "text-error font-mono";
      msgEl.textContent = truncate(err.message ?? "", 80);
      item.appendChild(msgEl);
      errList.appendChild(item);
    });
  }

  errPanel.appendChild(errList);
  sidebar.appendChild(errPanel);

  /* Disk Usage */
  const diskPanel = document.createElement("div");
  diskPanel.className = "glass-panel p-4 space-y-2";

  const diskTitle = document.createElement("span");
  diskTitle.className = "text-[10px] font-bold text-slate-400 tracking-widest uppercase font-label";
  diskTitle.textContent = "DISK USAGE";
  diskPanel.appendChild(diskTitle);

  const totalRow = document.createElement("div");
  totalRow.className = "flex justify-between text-[11px] mt-2";
  const totalLabel = document.createElement("span");
  totalLabel.className = "text-slate-500";
  totalLabel.textContent = "Total size";
  totalRow.appendChild(totalLabel);
  const totalVal = document.createElement("span");
  totalVal.className = "text-on-surface font-mono";
  totalVal.textContent = fmtBytes(stats?.totalSizeBytes);
  totalRow.appendChild(totalVal);
  diskPanel.appendChild(totalRow);

  const rangeRow = document.createElement("div");
  rangeRow.className = "flex justify-between text-[11px]";
  const rangeLabel = document.createElement("span");
  rangeLabel.className = "text-slate-500";
  rangeLabel.textContent = "Date range";
  rangeRow.appendChild(rangeLabel);
  const rangeVal = document.createElement("span");
  rangeVal.className = "text-on-surface font-mono text-[10px]";
  rangeVal.textContent = (stats?.oldestFile ?? "?") + " ~ " + (stats?.newestFile ?? "?");
  rangeRow.appendChild(rangeVal);
  diskPanel.appendChild(rangeRow);

  const countRow = document.createElement("div");
  countRow.className = "flex justify-between text-[11px]";
  const countLabel = document.createElement("span");
  countLabel.className = "text-slate-500";
  countLabel.textContent = "File count";
  countRow.appendChild(countLabel);
  const countVal = document.createElement("span");
  countVal.className = "text-on-surface font-mono";
  countVal.textContent = String(stats?.fileCount ?? 0);
  countRow.appendChild(countVal);
  diskPanel.appendChild(countRow);

  sidebar.appendChild(diskPanel);

  return sidebar;
}
