/**
 * Memento MCP Admin Console — Sessions 뷰 렌더러
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 */

import { state }                                         from "./state.js";
import { api }                                           from "./api.js";
import { showToast, showModal, closeModal }              from "./ui.js";
import { fmt, relativeTime, fmtDate, fmtMs, loadingHtml } from "./format.js";

function renderSessionKpiRow(counts) {
  const cards = [
    { label: "STREAMABLE",   value: counts.streamable ?? 0,   border: "bg-primary" },
    { label: "LEGACY SSE",   value: counts.legacy ?? 0,       border: "bg-secondary" },
    { label: "UNREFLECTED",  value: counts.unreflected ?? 0,  border: "bg-error" },
    { label: "TOTAL",         value: counts.total ?? 0,        border: "bg-tertiary" }
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

function renderSessionTable(sessions) {
  const wrap = document.createElement("div");
  wrap.className = "glass-panel flex-1 flex flex-col min-h-0";

  const tableWrap = document.createElement("div");
  tableWrap.className = "overflow-x-auto";

  const table = document.createElement("table");
  table.className = "w-full text-left border-collapse";
  table.id = "sessions-table";

  const thead = document.createElement("thead");
  thead.className = "bg-white/5 border-b border-white/5";
  const hRow = document.createElement("tr");
  ["Session ID", "Type", "Key", "Created", "Last Active", "Tools", "Reflected"].forEach(h => {
    const th = document.createElement("th");
    th.className = "px-6 py-4 text-[10px] font-bold text-slate-400 tracking-widest uppercase font-label";
    th.textContent = h;
    hRow.appendChild(th);
  });
  thead.appendChild(hRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  tbody.className = "divide-y divide-white/5";

  sessions.forEach(s => {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-white/5 transition-colors group cursor-pointer" + (s.sessionId === state.selectedSessionId ? " bg-white/[0.02]" : "");
    tr.dataset.sessionId = s.sessionId;

    /* Session ID */
    const td1 = document.createElement("td");
    td1.className = "px-6 py-4 font-mono text-xs text-on-surface";
    td1.textContent = (s.sessionId ?? "").slice(0, 8);
    tr.appendChild(td1);

    /* Type */
    const td2 = document.createElement("td");
    td2.className = "px-6 py-4";
    const typeBadge = document.createElement("span");
    const isStreamable = s.type === "streamable";
    typeBadge.className = "px-2 py-0.5 text-[10px] font-bold rounded-sm " + (isStreamable ? "bg-primary/10 text-primary" : "bg-secondary/10 text-secondary");
    typeBadge.textContent = isStreamable ? "STREAM" : "SSE";
    td2.appendChild(typeBadge);
    tr.appendChild(td2);

    /* Key */
    const td3 = document.createElement("td");
    td3.className = "px-6 py-4 text-xs text-slate-400";
    td3.textContent = s.keyId ?? "master";
    tr.appendChild(td3);

    /* Created */
    const td4 = document.createElement("td");
    td4.className = "px-6 py-4 font-mono text-xs text-slate-500";
    td4.textContent = relativeTime(s.createdAt);
    tr.appendChild(td4);

    /* Last Active */
    const td5 = document.createElement("td");
    td5.className = "px-6 py-4 font-mono text-xs text-slate-500";
    td5.textContent = s.lastAccessedAt ? relativeTime(s.lastAccessedAt) : "-";
    tr.appendChild(td5);

    /* Tools */
    const td6 = document.createElement("td");
    td6.className = "px-6 py-4 text-xs font-mono text-on-surface";
    const toolCalls = s.activity?.toolCalls ?? {};
    const totalTools = Object.values(toolCalls).reduce((sum, v) => sum + (Number(v) || 0), 0);
    td6.textContent = totalTools > 0 ? fmt(totalTools) : "-";
    tr.appendChild(td6);

    /* Reflected */
    const td7 = document.createElement("td");
    td7.className = "px-6 py-4";
    const reflectDot = document.createElement("div");
    reflectDot.className = "w-2 h-2 rounded-full " + (s.activity?.reflected ? "bg-tertiary" : "bg-error");
    td7.appendChild(reflectDot);
    tr.appendChild(td7);

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  tableWrap.appendChild(table);
  wrap.appendChild(tableWrap);

  /* Footer */
  const footer = document.createElement("div");
  footer.className = "mt-auto p-4 border-t border-white/5 flex justify-between items-center bg-white/[0.01]";
  const countText = document.createElement("span");
  countText.className = "text-xs text-slate-500";
  countText.textContent = "Showing " + sessions.length + " sessions";
  footer.appendChild(countText);

  const btnWrap = document.createElement("div");
  btnWrap.className = "flex gap-2";

  const reflectAllBtn = document.createElement("button");
  reflectAllBtn.className = "btn px-3 py-1.5 text-[10px] font-bold flex items-center gap-1 border-secondary/30 text-secondary";
  reflectAllBtn.id = "session-reflect-all";
  const reflectIcon = document.createElement("span");
  reflectIcon.className = "material-symbols-outlined text-sm";
  reflectIcon.textContent = "auto_fix_high";
  reflectAllBtn.appendChild(reflectIcon);
  reflectAllBtn.appendChild(document.createTextNode("REFLECT ALL"));
  btnWrap.appendChild(reflectAllBtn);

  const cleanupBtn = document.createElement("button");
  cleanupBtn.className = "btn-primary px-3 py-1.5 text-[10px] font-bold flex items-center gap-1";
  cleanupBtn.id = "session-cleanup-footer";
  const cleanupIcon = document.createElement("span");
  cleanupIcon.className = "material-symbols-outlined text-sm";
  cleanupIcon.textContent = "cleaning_services";
  cleanupBtn.appendChild(cleanupIcon);
  cleanupBtn.appendChild(document.createTextNode("CLEANUP"));
  btnWrap.appendChild(cleanupBtn);

  footer.appendChild(btnWrap);

  wrap.appendChild(footer);

  return wrap;
}

function renderSessionInspector(data) {
  const panel = document.createElement("aside");
  panel.className = "w-96 bg-surface-container-high border-l border-white/5 flex flex-col p-6 gap-6 relative overflow-y-auto";
  panel.id = "session-inspector";

  /* Header */
  const headerDiv = document.createElement("div");
  headerDiv.className = "flex items-center justify-between";
  const headerLabel = document.createElement("h3");
  headerLabel.className = "text-xs font-bold text-slate-400 tracking-widest uppercase font-label flex items-center gap-2";
  const infoIcon = document.createElement("span");
  infoIcon.className = "material-symbols-outlined text-primary text-lg";
  infoIcon.textContent = "info";
  headerLabel.appendChild(infoIcon);
  headerLabel.appendChild(document.createTextNode("SESSION INSPECTOR"));
  headerDiv.appendChild(headerLabel);

  const closeBtn = document.createElement("button");
  closeBtn.className = "text-slate-500 hover:text-slate-300";
  closeBtn.dataset.sessionAction = "close";
  const closeIcon = document.createElement("span");
  closeIcon.className = "material-symbols-outlined";
  closeIcon.textContent = "close";
  closeBtn.appendChild(closeIcon);
  headerDiv.appendChild(closeBtn);
  panel.appendChild(headerDiv);

  const session = data.session ?? data;

  /* Identity Card */
  const idCard = document.createElement("div");
  idCard.className = "bg-surface-container-highest p-4 rounded-sm border-l-2 border-primary";

  const idLabel = document.createElement("div");
  idLabel.className = "text-[10px] font-bold text-slate-400 tracking-widest uppercase mb-1 font-label";
  idLabel.textContent = "SESSION ID";
  idCard.appendChild(idLabel);

  const idValue = document.createElement("p");
  idValue.className = "font-mono text-xs text-on-surface break-all";
  idValue.textContent = session.sessionId ?? "";
  idCard.appendChild(idValue);

  const isStreamable = session.type === "streamable";
  const typeBadge = document.createElement("div");
  typeBadge.className = "inline-block mt-2 px-2 py-1 text-[10px] font-bold rounded-sm " + (isStreamable ? "bg-primary/10 text-primary border border-primary/20" : "bg-secondary/10 text-secondary border border-secondary/20");
  typeBadge.textContent = isStreamable ? "STREAMABLE" : "LEGACY SSE";
  idCard.appendChild(typeBadge);

  const statsDiv = document.createElement("div");
  statsDiv.className = "mt-4 space-y-2";
  [
    { label: "Created",     value: fmtDate(session.createdAt) },
    { label: "Expires",     value: fmtDate(session.expiresAt) },
    { label: "Last Active", value: fmtDate(session.lastAccessedAt) },
    { label: "Key",         value: session.keyId ?? "master" }
  ].forEach(f => {
    const row = document.createElement("div");
    row.className = "flex justify-between items-center";
    const lbl = document.createElement("span");
    lbl.className = "text-xs text-slate-400";
    lbl.textContent = f.label;
    row.appendChild(lbl);
    const val = document.createElement("span");
    val.className = "text-xs font-mono text-on-surface";
    val.textContent = f.value;
    row.appendChild(val);
    statsDiv.appendChild(row);
  });
  idCard.appendChild(statsDiv);
  panel.appendChild(idCard);

  /* Activity Summary */
  const actLabel = document.createElement("div");
  actLabel.className = "text-[10px] font-bold text-slate-400 tracking-widest uppercase mb-2 font-label";
  actLabel.textContent = "TOOL CALLS";
  panel.appendChild(actLabel);

  const toolCalls = session.activity?.toolCalls ?? {};
  const toolEntries = Object.entries(toolCalls);
  if (toolEntries.length) {
    const toolList = document.createElement("div");
    toolList.className = "space-y-1";
    toolEntries.forEach(([name, count]) => {
      const row = document.createElement("div");
      row.className = "flex justify-between items-center p-2 bg-surface-container border border-white/5";
      const nameEl = document.createElement("span");
      nameEl.className = "text-xs text-slate-300";
      nameEl.textContent = name;
      row.appendChild(nameEl);
      const countEl = document.createElement("span");
      countEl.className = "text-xs font-mono text-primary font-bold";
      countEl.textContent = fmt(count);
      row.appendChild(countEl);
      toolList.appendChild(row);
    });
    panel.appendChild(toolList);
  } else {
    const noTools = document.createElement("div");
    noTools.className = "text-[10px] text-slate-600 text-center py-4";
    noTools.textContent = "No tool calls recorded";
    panel.appendChild(noTools);
  }

  /* Keywords */
  const keywords = session.keywords ?? [];
  if (keywords.length) {
    const kwLabel = document.createElement("div");
    kwLabel.className = "text-[10px] font-bold text-slate-400 tracking-widest uppercase mb-2 font-label mt-2";
    kwLabel.textContent = "KEYWORDS";
    panel.appendChild(kwLabel);

    const kwWrap = document.createElement("div");
    kwWrap.className = "flex flex-wrap gap-1";
    keywords.forEach(kw => {
      const chip = document.createElement("span");
      chip.className = "px-2 py-0.5 bg-white/5 rounded-sm text-[10px] text-slate-400 border border-white/10";
      chip.textContent = kw;
      kwWrap.appendChild(chip);
    });
    panel.appendChild(kwWrap);
  }

  /* Fragment Count */
  const fragCount = session.fragmentCount ?? 0;
  if (fragCount > 0) {
    const fragLabel = document.createElement("div");
    fragLabel.className = "text-[10px] font-bold text-slate-400 tracking-widest uppercase mb-1 font-label mt-2";
    fragLabel.textContent = "FRAGMENTS";
    panel.appendChild(fragLabel);
    const fragVal = document.createElement("div");
    fragVal.className = "text-sm font-mono text-on-surface";
    fragVal.textContent = fmt(fragCount);
    panel.appendChild(fragVal);
  }

  /* Search Events */
  const searchEvents = data.searchEvents ?? [];
  if (searchEvents.length) {
    const seLabel = document.createElement("div");
    seLabel.className = "text-[10px] font-bold text-slate-400 tracking-widest uppercase mb-2 font-label mt-2";
    seLabel.textContent = "SEARCH EVENTS";
    panel.appendChild(seLabel);

    const seList = document.createElement("div");
    seList.className = "space-y-1 max-h-40 overflow-y-auto";
    searchEvents.slice(0, 10).forEach(ev => {
      const row = document.createElement("div");
      row.className = "flex items-center gap-2 p-2 bg-surface-container border border-white/5 text-[10px]";

      const qType = document.createElement("span");
      qType.className = "text-primary font-bold uppercase";
      qType.textContent = ev.query_type ?? "";
      row.appendChild(qType);

      const results = document.createElement("span");
      results.className = "text-slate-400";
      results.textContent = fmt(ev.result_count ?? 0) + " results";
      row.appendChild(results);

      const latency = document.createElement("span");
      latency.className = "text-slate-500 font-mono ml-auto";
      latency.textContent = fmtMs(ev.latency_ms);
      row.appendChild(latency);

      const time = document.createElement("span");
      time.className = "text-slate-600";
      time.textContent = relativeTime(ev.created_at);
      row.appendChild(time);

      seList.appendChild(row);
    });
    panel.appendChild(seList);
  }

  /* Tool Feedback */
  const toolFeedback = data.toolFeedback ?? [];
  if (toolFeedback.length) {
    const tfLabel = document.createElement("div");
    tfLabel.className = "text-[10px] font-bold text-slate-400 tracking-widest uppercase mb-2 font-label mt-2";
    tfLabel.textContent = "TOOL FEEDBACK";
    panel.appendChild(tfLabel);

    const tfList = document.createElement("div");
    tfList.className = "space-y-1 max-h-40 overflow-y-auto";
    toolFeedback.slice(0, 10).forEach(fb => {
      const row = document.createElement("div");
      row.className = "flex items-center gap-2 p-2 bg-surface-container border border-white/5 text-[10px]";

      const toolName = document.createElement("span");
      toolName.className = "text-slate-300";
      toolName.textContent = fb.tool_name ?? "";
      row.appendChild(toolName);

      const relevantIcon = document.createElement("span");
      relevantIcon.className = "material-symbols-outlined text-sm " + (fb.relevant ? "text-tertiary" : "text-slate-600");
      relevantIcon.textContent = fb.relevant ? "check_circle" : "cancel";
      row.appendChild(relevantIcon);

      const sufficientIcon = document.createElement("span");
      sufficientIcon.className = "material-symbols-outlined text-sm " + (fb.sufficient ? "text-tertiary" : "text-slate-600");
      sufficientIcon.textContent = fb.sufficient ? "verified" : "unpublished";
      row.appendChild(sufficientIcon);

      tfList.appendChild(row);
    });
    panel.appendChild(tfList);
  }

  /* Danger Zone */
  const danger = document.createElement("div");
  danger.className = "pt-6 border-t border-white/5 mt-auto";
  const dangerLabel = document.createElement("p");
  dangerLabel.className = "text-[10px] font-bold text-error tracking-widest uppercase mb-3 font-label";
  dangerLabel.textContent = "DANGER ZONE";
  danger.appendChild(dangerLabel);

  const dangerGrid = document.createElement("div");
  dangerGrid.className = "space-y-2";

  if (!session.reflected) {
    const reflectBtn = document.createElement("button");
    reflectBtn.className = "w-full py-2 border border-primary/30 text-primary text-[10px] font-bold hover:bg-primary/10 transition-all uppercase";
    reflectBtn.textContent = "FORCE REFLECT";
    reflectBtn.dataset.sessionAction = "reflect";
    reflectBtn.dataset.sessionId     = session.sessionId;
    dangerGrid.appendChild(reflectBtn);
  }

  const terminateBtn = document.createElement("button");
  terminateBtn.className = "w-full py-2 bg-error text-on-error text-[10px] font-bold hover:brightness-110 transition-all uppercase";
  terminateBtn.textContent = "TERMINATE SESSION";
  terminateBtn.dataset.sessionAction = "terminate";
  terminateBtn.dataset.sessionId     = session.sessionId;
  dangerGrid.appendChild(terminateBtn);

  danger.appendChild(dangerGrid);
  panel.appendChild(danger);

  return panel;
}

export async function renderSessions(container) {
  container.textContent = "";
  container.appendChild(loadingHtml());

  const res = await api("/sessions");
  const data     = res.ok ? res.data : { sessions: [], counts: {} };
  const sessions = data.sessions ?? [];
  const counts   = data.counts ?? {};

  container.textContent = "";

  /* Header */
  const header = document.createElement("div");
  header.className = "flex justify-between items-end mb-8";
  const headerLeft = document.createElement("div");
  const h2 = document.createElement("h2");
  h2.className = "text-2xl font-headline font-bold text-on-surface tracking-tight";
  h2.textContent = "Session Management";
  headerLeft.appendChild(h2);
  const subtitle = document.createElement("p");
  subtitle.className = "text-sm text-slate-400 mt-1";
  subtitle.textContent = "Live session monitoring and lifecycle control.";
  headerLeft.appendChild(subtitle);
  header.appendChild(headerLeft);

  const cleanupBtn = document.createElement("button");
  cleanupBtn.className = "btn-primary px-5 py-2.5 bg-primary-container text-on-primary-fixed font-bold text-sm flex items-center gap-2";
  cleanupBtn.id = "session-cleanup-btn";
  const cleanupIcon = document.createElement("span");
  cleanupIcon.className = "material-symbols-outlined text-lg";
  cleanupIcon.textContent = "cleaning_services";
  cleanupBtn.appendChild(cleanupIcon);
  cleanupBtn.appendChild(document.createTextNode("CLEANUP"));
  header.appendChild(cleanupBtn);
  container.appendChild(header);

  /* KPI Row */
  container.appendChild(renderSessionKpiRow(counts));

  /* Split layout */
  const split = document.createElement("div");
  split.className = "flex gap-0";
  split.style.minHeight = "400px";

  split.appendChild(renderSessionTable(sessions));

  if (state.selectedSessionId) {
    const detailRes = await api("/sessions/" + state.selectedSessionId);
    if (detailRes.ok) {
      split.appendChild(renderSessionInspector(detailRes.data));
    }
  }

  container.appendChild(split);

  /* Event: table row click */
  container.querySelectorAll("#sessions-table tbody tr").forEach(tr => {
    tr.addEventListener("click", () => {
      state.selectedSessionId = tr.dataset.sessionId;
      renderSessions(container);
    });
  });

  /* Event: close inspector */
  container.querySelector("[data-session-action='close']")?.addEventListener("click", () => {
    state.selectedSessionId = null;
    renderSessions(container);
  });

  /* Event: force reflect */
  container.querySelector("[data-session-action='reflect']")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    const sid = e.currentTarget.dataset.sessionId;
    const reflectRes = await api("/sessions/" + sid + "/reflect", { method: "POST" });
    if (reflectRes.ok) {
      showToast("Session reflected", "success");
    } else {
      showToast(reflectRes.data?.error ?? "Reflect failed", "error");
    }
    renderSessions(container);
  });

  /* Event: terminate session */
  container.querySelector("[data-session-action='terminate']")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const sid = e.currentTarget.dataset.sessionId;
    const msg = document.createElement("span");
    msg.className = "text-sm text-error";
    msg.textContent = "This will immediately terminate the session. Proceed?";
    showModal("Confirm Session Termination", msg, [
      { id: "confirm", label: "TERMINATE", cls: "btn-danger", handler: async () => {
        await api("/sessions/" + sid, { method: "DELETE" });
        closeModal();
        state.selectedSessionId = null;
        showToast("Session terminated", "success");
        renderSessions(container);
      }}
    ]);
  });

  /* Event: cleanup (header + footer) */
  const handleCleanup = async () => {
    const cleanRes = await api("/sessions/cleanup", { method: "POST" });
    if (cleanRes.ok) {
      showToast("Cleanup completed", "success");
    } else {
      showToast(cleanRes.data?.error ?? "Cleanup failed", "error");
    }
    renderSessions(container);
  };

  document.getElementById("session-cleanup-btn")?.addEventListener("click", handleCleanup);
  document.getElementById("session-cleanup-footer")?.addEventListener("click", handleCleanup);

  /* Event: reflect all unreflected sessions */
  document.getElementById("session-reflect-all")?.addEventListener("click", async () => {
    const r = await api("/sessions/reflect-all", { method: "POST" });
    if (r.ok) {
      const d = r.data ?? {};
      showToast("Reflected " + (d.reflected ?? 0) + " sessions" + (d.failed ? " (" + d.failed + " failed)" : ""), "success");
    } else {
      showToast(r.data?.error ?? "Reflect all failed", "error");
    }
    renderSessions(container);
  });
}
