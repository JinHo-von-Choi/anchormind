/**
 * Memento MCP Admin Console — Memory 뷰 렌더러
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 */

import { state, navigate, beginRender, syncRoute }      from "./state.js";
import { api, downloadToFile }                           from "./api.js";
import { showToast, showModal, closeModal }              from "./ui.js";
import { fmt, fmtDate, fmtPct, truncate, loadingHtml }  from "./format.js";

export function renderMemoryFilters() {
  const types = ["", "fact", "error", "decision", "procedure", "preference", "episode", "relation"];

  const bar = document.createElement("div");
  bar.className = "flex items-center justify-between gap-4 glass-panel p-2 rounded-sm border-l-2 border-primary/40";
  bar.id = "memory-filters";

  /* Left chips */
  const leftChips = document.createElement("div");
  leftChips.className = "flex gap-2 flex-wrap";

  /* Content search chip */
  const qChip = document.createElement("div");
  qChip.className = "px-3 py-1 bg-surface-variant text-[10px] font-bold flex items-center gap-2 rounded-sm text-primary border border-primary/10";
  const qIcon = document.createElement("span");
  qIcon.className = "material-symbols-outlined text-[14px]";
  qIcon.textContent = "manage_search";
  qChip.appendChild(qIcon);
  const qInput = document.createElement("input");
  qInput.className = "bg-transparent border-none outline-none text-[10px] font-bold text-primary placeholder:text-slate-500 w-36";
  qInput.id = "filter-q";
  qInput.placeholder = "CONTENT SEARCH";
  qInput.value = state.memoryFilter.q ?? "";
  qChip.appendChild(qInput);
  leftChips.appendChild(qChip);

  /* Topic chip */
  const topicChip = document.createElement("div");
  topicChip.className = "px-3 py-1 bg-surface-variant text-[10px] font-bold flex items-center gap-2 rounded-sm text-primary border border-primary/10";
  const topicInput = document.createElement("input");
  topicInput.className = "bg-transparent border-none outline-none text-[10px] font-bold text-primary placeholder:text-slate-500 w-24";
  topicInput.id = "filter-topic";
  topicInput.placeholder = "TOPIC: ALL";
  topicInput.value = state.memoryFilter.topic;
  topicChip.appendChild(topicInput);
  leftChips.appendChild(topicChip);

  /* Type chip */
  const typeChip = document.createElement("div");
  typeChip.className = "px-3 py-1 bg-surface-variant text-[10px] font-bold flex items-center gap-2 rounded-sm text-slate-400";
  const typeSelect = document.createElement("select");
  typeSelect.className = "bg-transparent border-none outline-none text-[10px] font-bold text-slate-400";
  typeSelect.id = "filter-type";
  types.forEach(t => {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t ? "TYPE: " + t.toUpperCase() : "TYPE: ALL";
    if (state.memoryFilter.type === t) opt.selected = true;
    typeSelect.appendChild(opt);
  });
  typeChip.appendChild(typeSelect);
  leftChips.appendChild(typeChip);

  /* Key chip */
  const keyChip = document.createElement("div");
  keyChip.className = "px-3 py-1 bg-surface-variant text-[10px] font-bold flex items-center gap-2 rounded-sm text-slate-400";
  const keyInput = document.createElement("input");
  keyInput.className = "bg-transparent border-none outline-none text-[10px] font-bold text-slate-400 placeholder:text-slate-500 w-16";
  keyInput.id = "filter-key-id";
  keyInput.placeholder = "KEY: *";
  keyInput.value = state.memoryFilter.key_id;
  keyChip.appendChild(keyInput);
  leftChips.appendChild(keyChip);

  /* Group chip */
  const groupChip = document.createElement("div");
  groupChip.className = "px-3 py-1 bg-surface-variant text-[10px] font-bold flex items-center gap-2 rounded-sm text-slate-400";
  const groupSelect = document.createElement("select");
  groupSelect.id = "filter-group";
  groupSelect.className = "bg-transparent border-none outline-none text-[10px] font-bold text-slate-400 cursor-pointer";
  const gOptAll = document.createElement("option");
  gOptAll.value = "";
  gOptAll.textContent = "GROUP: ALL";
  groupSelect.appendChild(gOptAll);
  (state.groups ?? []).forEach(g => {
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = "GROUP: " + g.name.toUpperCase();
    if (state.memoryFilter.group_id === g.id) opt.selected = true;
    groupSelect.appendChild(opt);
  });
  groupChip.appendChild(groupSelect);
  leftChips.appendChild(groupChip);

  bar.appendChild(leftChips);

  /* Right side */
  const rightSide = document.createElement("div");
  rightSide.className = "flex items-center gap-2";

  const searchBtn = document.createElement("button");
  searchBtn.className = "flex items-center gap-2 bg-transparent border border-outline-variant px-4 py-1.5 text-[10px] font-bold text-primary";
  searchBtn.id = "filter-search";
  const searchIcon = document.createElement("span");
  searchIcon.className = "material-symbols-outlined text-[14px]";
  searchIcon.textContent = "search";
  searchBtn.appendChild(searchIcon);
  searchBtn.appendChild(document.createTextNode("SEARCH"));
  rightSide.appendChild(searchBtn);

  const exportBtn = document.createElement("button");
  exportBtn.className = "flex items-center gap-2 bg-transparent border border-outline-variant px-4 py-1.5 text-[10px] font-bold text-slate-400 hover:text-primary";
  exportBtn.id = "export-jsonl";
  const exportIcon = document.createElement("span");
  exportIcon.className = "material-symbols-outlined text-[14px]";
  exportIcon.textContent = "download";
  exportBtn.appendChild(exportIcon);
  exportBtn.appendChild(document.createTextNode("EXPORT JSONL"));
  rightSide.appendChild(exportBtn);

  const importBtn = document.createElement("button");
  importBtn.className = "flex items-center gap-2 bg-transparent border border-outline-variant px-4 py-1.5 text-[10px] font-bold text-slate-400 hover:text-primary";
  importBtn.id = "import-jsonl";
  const importIcon = document.createElement("span");
  importIcon.className = "material-symbols-outlined text-[14px]";
  importIcon.textContent = "upload";
  importBtn.appendChild(importIcon);
  importBtn.appendChild(document.createTextNode("IMPORT"));
  rightSide.appendChild(importBtn);

  bar.appendChild(rightSide);

  return bar;
}

export function renderFragmentList(fragments) {
  if (!fragments || !fragments.length) {
    const empty = document.createElement("div");
    empty.className = "text-sm text-slate-600 py-8 text-center";
    empty.textContent = "결과 없음";
    return empty;
  }

  const panel = document.createElement("section");
  panel.className = "glass-panel rounded-sm p-6 shadow-2xl relative overflow-hidden";

  /* Ghost icon */
  const ghost = document.createElement("div");
  ghost.className = "absolute top-0 right-0 p-2 opacity-10";
  const ghostIcon = document.createElement("span");
  ghostIcon.className = "material-symbols-outlined text-6xl";
  ghostIcon.textContent = "search_insights";
  ghost.appendChild(ghostIcon);
  panel.appendChild(ghost);

  /* Title */
  const title = document.createElement("h2");
  title.className = "font-headline text-lg font-bold text-on-surface flex items-center gap-3 mb-6 uppercase tracking-widest";
  const titleBar = document.createElement("span");
  titleBar.className = "w-1 h-4 bg-primary";
  title.appendChild(titleBar);
  title.appendChild(document.createTextNode("Search Explorer"));
  panel.appendChild(title);

  /* Query box */
  const queryBox = document.createElement("div");
  queryBox.className = "bg-surface-container-highest p-4 mb-6 border border-white/5";
  const queryTop = document.createElement("div");
  queryTop.className = "flex justify-between text-[9px] font-mono";
  const queryLabel = document.createElement("span");
  queryLabel.className = "text-slate-500";
  queryLabel.textContent = "QUERY";
  queryTop.appendChild(queryLabel);
  const resultCount = document.createElement("span");
  resultCount.className = "text-slate-500";
  resultCount.textContent = fragments.length + " RESULTS";
  queryTop.appendChild(resultCount);
  queryBox.appendChild(queryTop);
  const queryText = document.createElement("div");
  queryText.className = "text-sm font-mono text-on-surface py-2 border-b border-white/5";
  queryText.textContent = state.memoryFilter.topic || state.memoryFilter.type || "*";
  queryBox.appendChild(queryText);
  panel.appendChild(queryBox);

  /* Results */
  const list = document.createElement("div");
  list.className = "space-y-3";
  list.id = "fragment-table";

  fragments.forEach(f => {
    const item = document.createElement("div");
    item.className = "bg-surface-container-low p-4 hover:bg-surface-container-high border-l border-transparent hover:border-primary/50 cursor-pointer" + (f.id === state.selectedFragment?.id ? " border-primary/50 bg-surface-container-high" : "");
    item.dataset.fragId = f.id;

    /* Top row */
    const topRow = document.createElement("div");
    topRow.className = "flex justify-between items-start mb-2";

    const topLeft = document.createElement("div");
    topLeft.className = "flex items-center gap-3";
    const idBadge = document.createElement("span");
    idBadge.className = "text-[10px] font-mono text-primary bg-primary/10 px-2 py-0.5";
    idBadge.textContent = "#MEM_" + (f.id ?? "").toString().slice(-5).padStart(5, "0");
    topLeft.appendChild(idBadge);
    const topicSpan = document.createElement("span");
    topicSpan.className = "text-xs font-bold text-on-surface uppercase tracking-wider";
    topicSpan.textContent = f.topic ?? "(무제)";
    topLeft.appendChild(topicSpan);
    topRow.appendChild(topLeft);

    const topRight = document.createElement("div");
    topRight.className = "flex items-center gap-4 text-right";
    const scoreDiv = document.createElement("div");
    const scoreLbl = document.createElement("div");
    scoreLbl.className = "text-[9px] text-slate-500 font-mono";
    scoreLbl.textContent = "UTILITY_SCORE";
    scoreDiv.appendChild(scoreLbl);
    const scoreVal = document.createElement("div");
    scoreVal.className = "text-xs font-mono text-tertiary";
    scoreVal.textContent = String(f.importance ?? "-");
    scoreDiv.appendChild(scoreVal);
    topRight.appendChild(scoreDiv);

    const accessDiv = document.createElement("div");
    const accessLbl = document.createElement("div");
    accessLbl.className = "text-[9px] text-slate-500 font-mono";
    accessLbl.textContent = "ACCESS";
    accessDiv.appendChild(accessLbl);
    const accessVal = document.createElement("div");
    accessVal.className = "text-xs font-mono text-tertiary";
    accessVal.textContent = f.access_count ?? "0";
    accessDiv.appendChild(accessVal);
    topRight.appendChild(accessDiv);

    topRow.appendChild(topRight);
    item.appendChild(topRow);

    /* Content preview */
    const preview = document.createElement("p");
    preview.className = "text-[11px] text-slate-400 line-clamp-2 font-body leading-relaxed mb-3 italic";
    preview.textContent = truncate(f.content ?? "", 200);
    item.appendChild(preview);

    /* Bottom: tags + timestamp */
    const bottom = document.createElement("div");
    bottom.className = "flex justify-between items-center";
    const tags = document.createElement("div");
    tags.className = "flex gap-2";
    const topicTag = document.createElement("span");
    topicTag.className = "text-[9px] border border-outline-variant px-2 py-0.5 text-slate-500 uppercase";
    topicTag.textContent = f.topic ?? "?";
    tags.appendChild(topicTag);
    const typeTag = document.createElement("span");
    typeTag.className = "text-[9px] border border-outline-variant px-2 py-0.5 text-slate-500 uppercase";
    typeTag.textContent = f.type ?? "?";
    tags.appendChild(typeTag);
    bottom.appendChild(tags);

    const dateSpan = document.createElement("div");
    dateSpan.className = "text-[9px] font-mono text-slate-600 uppercase";
    dateSpan.textContent = fmtDate(f.created_at);
    bottom.appendChild(dateSpan);
    item.appendChild(bottom);

    list.appendChild(item);
  });

  panel.appendChild(list);
  return panel;
}

export function renderRetrievalAnalytics(searchEvents) {
  const panel = document.createElement("section");
  panel.className = "glass-panel rounded-sm p-6 border-t border-primary/20";

  const title = document.createElement("h2");
  title.className = "font-headline text-sm font-bold text-on-surface uppercase tracking-widest mb-4";
  title.textContent = "Retrieval Analytics (7d)";
  panel.appendChild(title);

  const se = searchEvents ?? null;

  /* Grid: Searches + Zero-result rate */
  const grid = document.createElement("div");
  grid.className = "grid grid-cols-2 gap-3 mb-4";

  const statBox = (label, value) => {
    const box = document.createElement("div");
    box.className = "bg-surface-container-high p-3 text-center";
    const lbl = document.createElement("div");
    lbl.className = "text-[9px] font-mono text-slate-500 uppercase";
    lbl.textContent = label;
    box.appendChild(lbl);
    const val = document.createElement("div");
    val.className = "text-2xl font-headline font-bold text-tertiary";
    val.textContent = value;
    box.appendChild(val);
    return box;
  };

  grid.appendChild(statBox("SEARCHES", se?.totalSearches != null ? fmt(se.totalSearches) : "--"));
  grid.appendChild(statBox(
    "ZERO-RESULT",
    se?.zeroResultRate != null ? fmtPct(se.zeroResultRate) : "--"
  ));
  panel.appendChild(grid);

  /* Latency percentiles */
  const latLabel = document.createElement("div");
  latLabel.className = "text-[9px] font-mono text-slate-500 uppercase mb-1";
  latLabel.textContent = "SEARCH LATENCY (MS)";
  panel.appendChild(latLabel);

  const latRows = document.createElement("div");
  latRows.className = "space-y-1 mb-4";
  const lat = se?.latency ?? null;
  [["p50", lat?.p50], ["p90", lat?.p90], ["p99", lat?.p99], ["avg", lat?.avg_ms]].forEach(([k, v]) => {
    const row = document.createElement("div");
    row.className = "flex justify-between text-[11px] font-mono";
    const l = document.createElement("span");
    l.className = "text-slate-500 uppercase";
    l.textContent = k;
    row.appendChild(l);
    const val = document.createElement("span");
    val.className = "text-slate-300";
    val.textContent = v != null ? String(Math.round(Number(v))) : "--";
    row.appendChild(val);
    latRows.appendChild(row);
  });
  panel.appendChild(latRows);

  /* Feedback quality */
  const fbLabel = document.createElement("div");
  fbLabel.className = "text-[9px] font-mono text-slate-500 uppercase mb-1";
  fbLabel.textContent = "FEEDBACK QUALITY";
  panel.appendChild(fbLabel);
  const fbRows = document.createElement("div");
  fbRows.className = "space-y-1";
  [["relevance", se?.avgRelevance], ["sufficiency", se?.avgSufficiency]].forEach(([k, v]) => {
    const row = document.createElement("div");
    row.className = "flex justify-between text-[11px] font-mono";
    const l = document.createElement("span");
    l.className = "text-slate-500 uppercase";
    l.textContent = k;
    row.appendChild(l);
    const val = document.createElement("span");
    val.className = "text-slate-300";
    val.textContent = v != null ? fmtPct(Number(v)) : "--";
    row.appendChild(val);
    fbRows.appendChild(row);
  });
  panel.appendChild(fbRows);

  return panel;
}

export function renderAnomalyCards(anomalies) {
  if (!anomalies) return document.createDocumentFragment();
  const failedDays = anomalies.failedSearchDays ?? 7;
  const staleDays  = anomalies.staleDays ?? 30;

  const panel = document.createElement("section");
  panel.className = "glass-panel rounded-sm p-6 border-t border-error/20";

  const title = document.createElement("h2");
  title.className = "font-headline text-sm font-bold text-error uppercase tracking-widest mb-4";
  title.textContent = "Anomaly Insights";
  panel.appendChild(title);

  const list = document.createElement("div");
  list.className = "space-y-3";

  const items = [
    { label: `결과 0건 검색 (${failedDays}일)`,      key: "failedSearchCount", icon: "crisis_alert",       isCritical: true,  view: "searchLab" },
    { label: "미해결 모순",                           key: "openConflicts",     icon: "rule",               isCritical: false, view: "conflicts" },
    { label: "품질 판정 전",                          key: "qualityUnverified", icon: "low_priority",       isCritical: false },
    { label: `${staleDays}일 넘게 접근 없음`,         key: "staleFragments",    icon: "history_toggle_off", isCritical: false }
  ];

  items.forEach(a => {
    const row = document.createElement("div");
    row.className = a.isCritical
      ? "flex items-center justify-between p-3 bg-error-container/10 border-l-2 border-error"
      : "flex items-center justify-between p-3 bg-surface-container-high";
    row.dataset.anomaly = a.key;
    if (a.view) {
      row.className += " cursor-pointer hover:bg-white/5";
      row.title = "눌러서 처리 화면으로 이동";
      row.addEventListener("click", () => navigate(a.view));
    }

    const left = document.createElement("div");
    left.className = "flex items-center gap-3 " + (a.isCritical ? "" : "text-slate-400");
    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined text-lg" + (a.isCritical ? " text-error" : "");
    icon.textContent = a.icon;
    left.appendChild(icon);
    const lbl = document.createElement("span");
    lbl.className = "text-[10px] font-bold uppercase";
    lbl.textContent = a.label;
    left.appendChild(lbl);
    row.appendChild(left);

    const val = document.createElement("span");
    val.className = "text-xs font-mono" + (a.isCritical ? " text-error font-bold" : "");
    val.textContent = fmt(anomalies[a.key] ?? 0);
    row.appendChild(val);

    list.appendChild(row);
  });

  panel.appendChild(list);
  return panel;
}

export function renderRecentEventsChart(searchEvents) {
  const panel = document.createElement("section");
  panel.className = "glass-panel rounded-sm p-6";

  const header = document.createElement("div");
  header.className = "flex justify-between items-center mb-6";
  const title = document.createElement("h2");
  title.className = "font-headline text-sm font-bold text-on-surface uppercase tracking-widest";
  title.textContent = "Search Activity (7d)";
  header.appendChild(title);
  panel.appendChild(header);

  const se   = searchEvents ?? null;
  const grid = document.createElement("div");
  grid.className = "grid grid-cols-1 md:grid-cols-2 gap-6";

  /* Path distribution */
  const pathCol = document.createElement("div");
  const pathLabel = document.createElement("div");
  pathLabel.className = "text-[9px] font-mono text-slate-500 uppercase mb-2";
  pathLabel.textContent = "SEARCH PATH DISTRIBUTION";
  pathCol.appendChild(pathLabel);

  const paths = se?.pathDistribution ?? [];
  if (paths.length === 0) {
    const empty = document.createElement("div");
    empty.className = "text-[11px] text-slate-600 font-mono";
    empty.textContent = "--";
    pathCol.appendChild(empty);
  } else {
    const maxCnt = Math.max(...paths.map(r => Number(r.cnt) || 0), 1);
    paths.forEach(r => {
      const row = document.createElement("div");
      row.className = "mb-2";
      const top = document.createElement("div");
      top.className = "flex justify-between text-[11px] font-mono mb-0.5";
      const l = document.createElement("span");
      l.className = "text-slate-400";
      l.textContent = r.search_path ?? "(unknown)";
      top.appendChild(l);
      const v = document.createElement("span");
      v.className = "text-slate-300";
      v.textContent = fmt(Number(r.cnt) || 0);
      top.appendChild(v);
      row.appendChild(top);
      const barBg = document.createElement("div");
      barBg.className = "w-full bg-white/5 h-1";
      const barFill = document.createElement("div");
      barFill.className = "h-full bg-primary/60";
      barFill.style.width = Math.round(((Number(r.cnt) || 0) / maxCnt) * 100) + "%";
      barBg.appendChild(barFill);
      row.appendChild(barBg);
      pathCol.appendChild(row);
    });
  }
  grid.appendChild(pathCol);

  /* Top keywords */
  const kwCol = document.createElement("div");
  const kwLabel = document.createElement("div");
  kwLabel.className = "text-[9px] font-mono text-slate-500 uppercase mb-2";
  kwLabel.textContent = "TOP KEYWORDS";
  kwCol.appendChild(kwLabel);

  const kws = se?.topKeywords ?? [];
  if (kws.length === 0) {
    const empty = document.createElement("div");
    empty.className = "text-[11px] text-slate-600 font-mono";
    empty.textContent = "--";
    kwCol.appendChild(empty);
  } else {
    kws.forEach(r => {
      const row = document.createElement("div");
      row.className = "flex justify-between text-[11px] font-mono py-0.5 border-b border-white/5";
      const l = document.createElement("span");
      l.className = "text-slate-400";
      l.textContent = r.kw;
      row.appendChild(l);
      const v = document.createElement("span");
      v.className = "text-slate-300";
      v.textContent = fmt(Number(r.cnt) || 0);
      row.appendChild(v);
      kwCol.appendChild(row);
    });
  }
  grid.appendChild(kwCol);

  panel.appendChild(grid);
  return panel;
}

export function renderFragmentInspector(detail) {
  if (!detail?.fragment) return document.createDocumentFragment();
  const fragment = detail.fragment;
  const links    = detail.links ?? [];

  const panel = document.createElement("section");
  panel.className = "glass-panel rounded-sm p-6 border-t border-primary/20";
  panel.id = "fragment-inspector";

  const titleRow = document.createElement("div");
  titleRow.className = "flex items-center justify-between mb-6";

  const title = document.createElement("h2");
  title.className = "font-headline text-sm font-bold text-on-surface flex items-center gap-3 uppercase tracking-widest";
  title.textContent = "Fragment Detail";
  titleRow.appendChild(title);

  const closeBtn = document.createElement("button");
  closeBtn.type      = "button";
  closeBtn.className = "lg:hidden text-slate-400 hover:text-on-surface text-lg leading-none px-2";
  closeBtn.setAttribute("aria-label", "닫기");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", closeFragmentInspector);
  titleRow.appendChild(closeBtn);

  panel.appendChild(titleRow);

  const content = document.createElement("div");
  content.className = "bg-surface-container-highest p-4 mb-4 text-[11px] text-slate-300 leading-relaxed whitespace-pre-wrap border border-white/5";
  content.textContent = fragment.content ?? "--";
  panel.appendChild(content);

  /* Keywords chips */
  const kwWrap = document.createElement("div");
  kwWrap.className = "flex flex-wrap gap-1 mb-4";
  (fragment.keywords ?? []).forEach(kw => {
    const chip = document.createElement("span");
    chip.className = "text-[9px] font-mono text-slate-400 bg-white/5 px-2 py-0.5";
    chip.textContent = kw;
    kwWrap.appendChild(chip);
  });
  panel.appendChild(kwWrap);

  const meta = document.createElement("div");
  meta.className = "space-y-2 mb-4";
  [
    { label: "ID",         value: fragment.id },
    { label: "Type",       value: fragment.type ?? "--" },
    { label: "Topic",      value: fragment.topic ?? "--" },
    { label: "Importance", value: String(fragment.importance ?? "--") },
    { label: "Anchor",     value: fragment.is_anchor ? "yes" : "no" },
    { label: "Assertion",  value: fragment.assertion_status ?? "--" },
    { label: "Case",       value: fragment.case_id ?? "--" },
    { label: "Agent",      value: fragment.agent_id ?? "--" },
    { label: "Key",        value: fragment.key_id ?? "master" },
    { label: "Access",     value: String(fragment.access_count ?? 0) },
    { label: "Created",    value: fmtDate(fragment.created_at) },
    { label: "Verified",   value: fragment.verified_at ? fmtDate(fragment.verified_at) : "--" }
  ].forEach(f => {
    const row = document.createElement("div");
    row.className = "flex justify-between text-[10px]";
    const lbl = document.createElement("span");
    lbl.className = "text-slate-500 uppercase font-mono";
    lbl.textContent = f.label;
    row.appendChild(lbl);
    const val = document.createElement("span");
    val.className = "text-slate-300 font-mono break-all text-right";
    val.textContent = f.value;
    row.appendChild(val);
    meta.appendChild(row);
  });
  panel.appendChild(meta);

  /* 1-hop links */
  const linkLabel = document.createElement("div");
  linkLabel.className = "text-[9px] font-mono text-slate-500 uppercase mb-1";
  linkLabel.textContent = "LINKS (1-HOP)";
  panel.appendChild(linkLabel);

  if (links.length === 0) {
    const empty = document.createElement("div");
    empty.className = "text-[11px] text-slate-600 font-mono mb-3";
    empty.textContent = "--";
    panel.appendChild(empty);
  } else {
    const linkList = document.createElement("div");
    linkList.className = "space-y-2 mb-3";
    links.forEach(l => {
      const row = document.createElement("div");
      row.className = "text-[10px] border-l border-white/10 pl-2";
      const head = document.createElement("div");
      head.className = "font-mono text-slate-400";
      head.textContent = `${l.direction === "out" ? "→" : "←"} ${l.relation_type} · ${l.type ?? ""} · ${l.id}`;
      row.appendChild(head);
      const prev = document.createElement("div");
      prev.className = "text-slate-500 line-clamp-2";
      prev.textContent = l.preview ?? "";
      row.appendChild(prev);
      linkList.appendChild(row);
    });
    panel.appendChild(linkList);
  }

  /* Graph view link */
  const graphBtn = document.createElement("button");
  graphBtn.className = "flex items-center gap-2 text-[10px] font-bold text-primary border border-outline-variant px-3 py-1";
  const graphIcon = document.createElement("span");
  graphIcon.className = "material-symbols-outlined text-[14px]";
  graphIcon.textContent = "hub";
  graphBtn.appendChild(graphIcon);
  graphBtn.appendChild(document.createTextNode("VIEW IN GRAPH"));
  graphBtn.addEventListener("click", () => {
    navigate("graph", { topic: fragment.topic ?? "" });
  });

  const historyBtn = document.createElement("button");
  historyBtn.className = "flex items-center gap-2 text-[10px] font-bold text-slate-400 hover:text-primary border border-outline-variant px-3 py-1";
  historyBtn.id = "fragment-history-btn";
  const historyIcon = document.createElement("span");
  historyIcon.className = "material-symbols-outlined text-[14px]";
  historyIcon.textContent = "history";
  historyBtn.appendChild(historyIcon);
  historyBtn.appendChild(document.createTextNode("변경 이력"));

  const actions = document.createElement("div");
  actions.className = "flex gap-2 flex-wrap";
  actions.appendChild(graphBtn);
  actions.appendChild(historyBtn);
  panel.appendChild(actions);

  const historySlot = document.createElement("div");
  historySlot.className = "mt-4";
  panel.appendChild(historySlot);
  historyBtn.addEventListener("click", () => loadFragmentHistory(fragment.id, historySlot));

  return panel;
}

/**
 * 파편 변경 이력: amend 이전 판(versions)과 이 파편을 대체한 파편(superseded_by_chain).
 *
 * @param {{ versions?: Object[], superseded_by_chain?: Object[] }} history
 * @returns {HTMLElement}
 */
export function renderFragmentHistory(history) {
  const wrap = document.createElement("div");
  wrap.className = "space-y-3";
  wrap.id = "fragment-history";

  const versions = history?.versions ?? [];
  const chain    = history?.superseded_by_chain ?? [];

  const vTitle = document.createElement("div");
  vTitle.className   = "text-[9px] font-mono text-slate-500 uppercase";
  vTitle.textContent = `이전 판 ${versions.length}개`;
  wrap.appendChild(vTitle);
  for (const v of versions) {
    const row = document.createElement("div");
    row.className = "text-[10px] border-l border-white/10 pl-2";
    const head = document.createElement("div");
    head.className   = "font-mono text-slate-400";
    head.textContent = `${fmtDate(v.amended_at)} · ${v.amended_by ?? "-"} · ${v.type ?? ""} · ${v.topic ?? ""}`;
    row.appendChild(head);
    const body = document.createElement("div");
    body.className   = "text-slate-500 whitespace-pre-wrap";
    body.textContent = truncate(v.content ?? "", 400);
    row.appendChild(body);
    wrap.appendChild(row);
  }

  const cTitle = document.createElement("div");
  cTitle.className   = "text-[9px] font-mono text-slate-500 uppercase";
  cTitle.textContent = chain.length > 0 ? `이 파편을 대체한 파편 ${chain.length}개` : "대체한 파편 없음";
  wrap.appendChild(cTitle);
  for (const c of chain) {
    const row = document.createElement("div");
    row.className   = "text-[10px] border-l border-primary/30 pl-2 text-slate-400";
    row.textContent = `${c.to_id} · ${fmtDate(c.created_at)} · ${truncate(c.content ?? "", 200)}`;
    wrap.appendChild(row);
  }
  return wrap;
}

async function loadFragmentHistory(fragId, slot) {
  slot.textContent = "";
  slot.appendChild(loadingHtml());
  const res = await api(`/memory/fragments/${encodeURIComponent(fragId)}/history`);
  if (slot.isConnected === false) return;
  slot.textContent = "";
  if (!res.ok) {
    showToast(`변경 이력 조회 실패 (${res.status || res.error})`, "error");
    return;
  }
  slot.appendChild(renderFragmentHistory(res.data));
}

export function renderPagination() {
  const total   = state.memoryPages;
  const current = state.memoryPage;
  if (total <= 1) return document.createDocumentFragment();

  const wrap = document.createElement("div");
  wrap.className = "flex gap-1 mt-4 justify-center items-center";

  const btnCls     = "p-1 hover:bg-white/5 rounded-sm px-3 text-xs text-slate-500";
  const activeCls  = "p-1 rounded-sm px-3 text-xs text-white border border-primary/20 bg-white/5";
  const arrowCls   = "p-1 hover:bg-white/5 rounded-sm text-slate-500";

  function mkBtn(label, page, cls) {
    const btn = document.createElement("button");
    btn.className = cls;
    btn.dataset.page = page;
    btn.textContent = label;
    if (page < 1 || page > total) {
      btn.disabled = true;
      btn.style.opacity = "0.3";
      btn.style.cursor = "default";
    }
    return btn;
  }

  function mkArrow(iconName, page) {
    const btn = document.createElement("button");
    btn.className = arrowCls;
    btn.dataset.page = page;
    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined text-sm";
    icon.textContent = iconName;
    btn.appendChild(icon);
    if (page < 1 || page > total) { btn.disabled = true; btn.style.opacity = "0.3"; }
    return btn;
  }

  wrap.appendChild(mkArrow("chevron_left", current - 1));

  /* Window of 10 pages centered on current */
  const windowSize = 10;
  let start = Math.max(1, current - Math.floor(windowSize / 2));
  let end   = start + windowSize - 1;
  if (end > total) {
    end   = total;
    start = Math.max(1, end - windowSize + 1);
  }

  if (start > 1) {
    wrap.appendChild(mkBtn("1", 1, btnCls));
    if (start > 2) {
      const dots = document.createElement("span");
      dots.className = "text-xs text-slate-600 px-1";
      dots.textContent = "...";
      wrap.appendChild(dots);
    }
  }

  for (let i = start; i <= end; i++) {
    wrap.appendChild(mkBtn(String(i), i, i === current ? activeCls : btnCls));
  }

  if (end < total) {
    if (end < total - 1) {
      const dots = document.createElement("span");
      dots.className = "text-xs text-slate-600 px-1";
      dots.textContent = "...";
      wrap.appendChild(dots);
    }
    wrap.appendChild(mkBtn(String(total), total, btnCls));
  }

  wrap.appendChild(mkArrow("chevron_right", current + 1));

  return wrap;
}

/**
 * 인스펙터를 닫는다. 좁은 화면 바텀시트(.open)와 선택 하이라이트를 함께 해제한다.
 */
function closeFragmentInspector() {
  const slot = document.getElementById("inspector-slot");
  if (!slot) return;
  slot.classList.remove("open");
  slot.textContent = "";
  state.selectedFragment   = null;
  state.selectedFragmentId = null;
  syncRoute();
  document.querySelectorAll("[data-frag-id]").forEach(el => el.classList.remove("frag-selected"));
}

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && document.getElementById("inspector-slot")?.classList.contains("open")) {
    closeFragmentInspector();
  }
});

/**
 * 파편 상세를 조회하여 우측 인스펙터 슬롯에 부분 렌더링한다.
 * 전체 뷰 재렌더 없이 행 하이라이트와 인스펙터만 갱신한다.
 */
async function showFragmentDetail(fragId) {
  const slot = document.getElementById("inspector-slot");
  if (!slot) return;
  state.selectedFragmentId = fragId;
  syncRoute();

  document.querySelectorAll("[data-frag-id]").forEach(el => {
    el.classList.toggle("frag-selected", el.dataset.fragId === fragId);
  });

  slot.textContent = "";
  slot.appendChild(loadingHtml());
  slot.classList.add("open");

  const params = new URLSearchParams();
  if (state.memoryFilter.key_id)   params.set("key_id",   state.memoryFilter.key_id);
  if (state.memoryFilter.group_id) params.set("group_id", state.memoryFilter.group_id);
  const qs  = params.toString();
  const res = await api(`/memory/fragments/${encodeURIComponent(fragId)}${qs ? "?" + qs : ""}`);
  if (state.selectedFragmentId !== fragId || slot.isConnected === false) return;

  slot.textContent = "";
  if (!res.ok) {
    slot.classList.remove("open");
    showToast("파편 상세 조회 실패", "error");
    return;
  }
  state.selectedFragment = res.data?.fragment ?? null;
  slot.appendChild(renderFragmentInspector(res.data));
}

/** 현재 필터를 쿼리로 변환해 /export JSONL을 내려받는다. */
async function downloadExport() {
  const btn = document.getElementById("export-jsonl");
  const params = new URLSearchParams();
  if (state.memoryFilter.key_id)   params.set("key_id",   state.memoryFilter.key_id);
  if (state.memoryFilter.group_id) params.set("group_id", state.memoryFilter.group_id);
  if (state.memoryFilter.topic)    params.set("topic",    state.memoryFilter.topic);
  if (state.memoryFilter.type)     params.set("type",     state.memoryFilter.type);

  if (!params.has("key_id") && !params.has("group_id")) {
    showToast("EXPORT는 KEY 또는 GROUP 필터가 필요합니다", "error");
    return;
  }
  if (btn) btn.disabled = true;
  const result = await downloadToFile(`/export?${params}`, "fragments.jsonl");
  if (btn) btn.disabled = false;
  if (result.ok) showToast("EXPORT 완료", "info");
  else showToast(`EXPORT 실패 (${result.status || result.error})`, "error");
}

/**
 * 가져오기 결과 요약 문구.
 *
 * @param {Object} report - /import 응답
 * @returns {string}
 */
export function importSummary(report) {
  const mode = report?.dryRun ? "시험 실행" : "가져오기";
  const reasons = Object.entries(report?.rejected_by_reason ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
  return `${mode}: 새로 기록 ${fmt(report?.imported ?? 0)} · 중복 ${fmt(report?.duplicates ?? 0)} · 거부 ${fmt(report?.rejected ?? 0)}`
    + ` · 오류 ${fmt(report?.errors ?? 0)} · 링크 ${fmt(report?.links?.imported ?? 0)}`
    + (reasons ? ` (거부 사유: ${reasons})` : "")
    + ((report?.warnings ?? []).length ? ` · 경고 ${report.warnings.join(", ")}` : "");
}

/** export 파일(JSONL)이나 JSON 본문을 가져오는 대화상자. 기본은 시험 실행이다. */
function openImportDialog(container) {
  const body = document.createElement("div");
  body.className = "space-y-3 text-xs";

  const fileInput = document.createElement("input");
  fileInput.type   = "file";
  fileInput.accept = ".jsonl,.ndjson,.json";
  fileInput.id     = "import-file";
  body.appendChild(fileInput);

  const keyInput = document.createElement("input");
  keyInput.type        = "text";
  keyInput.id          = "import-key-id";
  keyInput.placeholder = "기록할 키 id (비우면 마스터 범위)";
  keyInput.value       = state.memoryFilter.key_id ?? "";
  keyInput.className   = "w-full bg-surface-container border border-outline-variant/30 px-3 py-1.5";
  body.appendChild(keyInput);

  const dryLabel = document.createElement("label");
  dryLabel.className = "flex items-center gap-2";
  const dryRun = document.createElement("input");
  dryRun.type    = "checkbox";
  dryRun.id      = "import-dry-run";
  dryRun.checked = true;
  dryLabel.appendChild(dryRun);
  dryLabel.appendChild(document.createTextNode("시험 실행(기록하지 않고 결과만 확인)"));
  body.appendChild(dryLabel);

  const result = document.createElement("div");
  result.id        = "import-result";
  result.className = "text-slate-300 whitespace-pre-wrap";
  body.appendChild(result);

  showModal("IMPORT", body, [{
    label: "RUN",
    cls  : "btn-primary",
    handler: async (e) => {
      const file = fileInput.files?.[0];
      if (!file) {
        result.textContent = "파일을 고르세요.";
        return;
      }
      const btn = e?.currentTarget;
      if (btn) btn.disabled = true;
      result.textContent = "처리 중...";
      const text   = await file.text();
      const isJson = /\.json$/i.test(file.name);
      const params = new URLSearchParams();
      if (keyInput.value.trim()) params.set("key_id", keyInput.value.trim());
      if (dryRun.checked) params.set("dryRun", "true");
      const res = await api("/import?" + params, {
        method : "POST",
        body   : text,
        headers: { "Content-Type": isJson ? "application/json" : "application/x-ndjson" }
      });
      if (btn) btn.disabled = false;
      if (!res.ok) {
        result.textContent = `실패 (${res.status}): ${res.data?.error ?? res.error ?? ""}`;
        return;
      }
      result.textContent = importSummary(res.data);
      if (!dryRun.checked) {
        showToast("IMPORT 완료", "success");
        closeModal();
        renderMemory(container);
      }
    }
  }]);
}

/** 메모리 조회 조건, 쪽, 선택한 파편과 주소 질의를 서로 옮긴다. */
export const memoryRoute = {
  fromQuery(query) {
    state.memoryFilter = {
      q:        query.get("q") ?? "",
      topic:    query.get("topic") ?? "",
      type:     query.get("type") ?? "",
      key_id:   query.get("key_id") ?? "",
      group_id: query.get("group_id") ?? ""
    };
    state.memoryPage         = Math.max(1, parseInt(query.get("page") ?? "", 10) || 1);
    state.selectedFragmentId = query.get("frag") || null;
  },
  toQuery() {
    return {
      ...state.memoryFilter,
      page: state.memoryPage > 1 ? state.memoryPage : "",
      frag: state.selectedFragmentId
    };
  }
};

function slotError(message) {
  const el = document.createElement("div");
  el.className   = "glass-panel p-4 text-xs text-error";
  el.textContent = message;
  return el;
}

/**
 * 메모리 운영 화면. 파편 목록, 검색 분석, 이상 징후를 따로 불러와 먼저 온 것부터 그린다.
 *
 * @param {HTMLElement} container
 */
export async function renderMemory(container) {
  const ctx = beginRender();
  syncRoute();
  container.textContent = "";

  const filterSlot = document.createElement("div");
  container.appendChild(filterSlot);

  /* Grid */
  const grid = document.createElement("div");
  grid.className = "grid grid-cols-12 gap-6 mt-6";

  /* Center: fragments */
  const centerCol = document.createElement("div");
  centerCol.className = "col-span-12 lg:col-span-8 space-y-6";
  centerCol.appendChild(loadingHtml());
  grid.appendChild(centerCol);

  /* Right: inspector slot + analytics + anomalies */
  const rightCol = document.createElement("div");
  rightCol.className = "col-span-12 lg:col-span-4 space-y-6";
  const inspectorSlot = document.createElement("div");
  inspectorSlot.id = "inspector-slot";
  rightCol.appendChild(inspectorSlot);
  const analyticsSlot = document.createElement("div");
  analyticsSlot.appendChild(loadingHtml());
  rightCol.appendChild(analyticsSlot);
  const anomalySlot = document.createElement("div");
  anomalySlot.appendChild(loadingHtml());
  rightCol.appendChild(anomalySlot);
  grid.appendChild(rightCol);
  container.appendChild(grid);

  /* Bottom: Search Activity */
  const bottomGrid = document.createElement("div");
  bottomGrid.className = "grid grid-cols-12 gap-6 mt-6";
  const bottomCol = document.createElement("div");
  bottomCol.className = "col-span-12";
  bottomGrid.appendChild(bottomCol);
  container.appendChild(bottomGrid);

  const params = new URLSearchParams();
  if (state.memoryFilter.q)        params.set("q",        state.memoryFilter.q);
  if (state.memoryFilter.topic)    params.set("topic",    state.memoryFilter.topic);
  if (state.memoryFilter.type)     params.set("type",     state.memoryFilter.type);
  if (state.memoryFilter.key_id)   params.set("key_id",   state.memoryFilter.key_id);
  if (state.memoryFilter.group_id) params.set("group_id", state.memoryFilter.group_id);
  params.set("page", state.memoryPage);

  const loadMain = (async () => {
    const [fragRes, groupsRes] = await Promise.all([
      api("/memory/fragments?" + params, { signal: ctx.signal }),
      api("/groups", { signal: ctx.signal })
    ]);
    if (!ctx.isCurrent()) return;
    if (groupsRes.ok) state.groups = groupsRes.data ?? [];

    if (fragRes.ok) {
      const data = fragRes.data ?? {};
      if (Array.isArray(fragRes.data)) {
        state.fragments   = fragRes.data;
        state.memoryPages = 1;
      } else {
        state.fragments   = data.items ?? data.fragments ?? [];
        state.memoryPages = Math.ceil((data.total ?? 0) / (data.limit ?? 20)) || 1;
      }
    } else {
      state.fragments = [];
    }

    filterSlot.textContent = "";
    filterSlot.appendChild(renderMemoryFilters());
    centerCol.textContent = "";
    if (!fragRes.ok) centerCol.appendChild(slotError(`파편 조회 실패 (${fragRes.status || fragRes.error})`));
    centerCol.appendChild(renderFragmentList(state.fragments));
    centerCol.appendChild(renderPagination());
    wireMemoryEvents(container);
    if (state.selectedFragmentId) showFragmentDetail(state.selectedFragmentId);
  })();

  const loadAnalytics = (async () => {
    const seRes = await api("/memory/search-events?days=7", { signal: ctx.signal });
    if (!ctx.isCurrent()) return;
    state.searchEvents = seRes.ok ? seRes.data : null;
    analyticsSlot.textContent = "";
    if (!seRes.ok) analyticsSlot.appendChild(slotError(`검색 분석 조회 실패 (${seRes.status || seRes.error})`));
    analyticsSlot.appendChild(renderRetrievalAnalytics(state.searchEvents));
    bottomCol.textContent = "";
    bottomCol.appendChild(renderRecentEventsChart(state.searchEvents));
  })();

  const loadAnomalies = (async () => {
    const anomalyRes = await api("/memory/anomalies", { signal: ctx.signal });
    if (!ctx.isCurrent()) return;
    state.anomalies = anomalyRes.ok ? anomalyRes.data : null;
    anomalySlot.textContent = "";
    if (!anomalyRes.ok) anomalySlot.appendChild(slotError(`이상 징후 조회 실패 (${anomalyRes.status || anomalyRes.error})`));
    anomalySlot.appendChild(renderAnomalyCards(state.anomalies));
  })();

  await Promise.all([loadMain, loadAnalytics, loadAnomalies]);
}

/** 필터, 내보내기, 가져오기, 쪽 이동, 파편 선택 이벤트를 연결한다. */
function wireMemoryEvents(container) {
  /* Event: search (버튼 + 입력 Enter 공용) */
  const readFilterInputs = () => {
    state.memoryFilter.q        = document.getElementById("filter-q")?.value ?? "";
    state.memoryFilter.topic    = document.getElementById("filter-topic")?.value ?? "";
    state.memoryFilter.type     = document.getElementById("filter-type")?.value ?? "";
    state.memoryFilter.key_id   = document.getElementById("filter-key-id")?.value ?? "";
    state.memoryFilter.group_id = document.getElementById("filter-group")?.value ?? "";
  };
  const applyFilters = () => {
    readFilterInputs();
    state.memoryPage         = 1;
    state.selectedFragmentId = null;
    renderMemory(container);
  };
  document.getElementById("filter-search")?.addEventListener("click", applyFilters);
  ["filter-q", "filter-topic", "filter-key-id"].forEach(id => {
    document.getElementById(id)?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") applyFilters();
    });
  });

  /* Event: export, import */
  document.getElementById("export-jsonl")?.addEventListener("click", () => {
    readFilterInputs();
    downloadExport();
  });
  document.getElementById("import-jsonl")?.addEventListener("click", () => openImportDialog(container));

  /* Event: pagination */
  container.querySelectorAll("[data-page]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.memoryPage         = parseInt(btn.dataset.page);
      state.selectedFragmentId = null;
      renderMemory(container);
    });
  });

  /* Event: fragment click — 부분 렌더 (전체 재렌더·재호출 없음) */
  container.querySelectorAll("[data-frag-id]").forEach(el => {
    el.addEventListener("click", () => showFragmentDetail(el.dataset.fragId));
  });
}
