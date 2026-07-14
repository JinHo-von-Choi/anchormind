/**
 * Memento MCP Admin Console — API Keys 뷰
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 */

import { state }                        from "./state.js";
import { api }                           from "./api.js";
import { showToast, showModal, closeModal } from "./ui.js";
import { fmt, fmtDate, loadingHtml }     from "./format.js";

export function renderKeyKpiRow(keys) {
  const total    = keys.length;
  const active   = keys.filter(k => k.status === "active").length;
  const inactive = total - active;
  const groups   = new Set(keys.flatMap(k => k.groups ?? [])).size;

  const cards = [
    { label: "ACTIVE KEYS",  value: active,   border: "bg-tertiary" },
    { label: "REVOKED KEYS", value: inactive,  border: "bg-error" },
    { label: "TOTAL GROUPS", value: groups,    border: "bg-secondary" },
    { label: "NO GROUP",     value: keys.filter(k => !k.groups?.length).length, border: "bg-primary" }
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

export function renderKeyTable(keys) {
  const wrap = document.createElement("div");
  wrap.className = "glass-panel flex-1 flex flex-col min-h-0";

  const tableWrap = document.createElement("div");
  tableWrap.className = "overflow-x-auto";

  const table = document.createElement("table");
  table.className = "w-full text-left border-collapse";
  table.id = "keys-table";

  const thead = document.createElement("thead");
  thead.className = "bg-white/5 border-b border-white/5";
  const hRow = document.createElement("tr");
  ["Name", "Prefix", "Status", "Groups", "Created Date", "Usage (24h)", "Fragments", ""].forEach(h => {
    const th = document.createElement("th");
    th.className = "px-6 py-4 text-[10px] font-bold text-slate-400 tracking-widest uppercase font-label";
    th.textContent = h;
    hRow.appendChild(th);
  });
  thead.appendChild(hRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  tbody.className = "divide-y divide-white/5";
  keys.forEach(k => {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-white/5 transition-colors group cursor-pointer" + (k.id === state.selectedKeyId ? " bg-white/[0.02]" : "");
    tr.dataset.keyId = k.id;

    /* Name */
    const td1 = document.createElement("td");
    td1.className = "px-6 py-4";
    const nameWrap = document.createElement("div");
    nameWrap.className = "flex items-center gap-3";
    const statusDot = document.createElement("div");
    const isActive = k.status === "active";
    statusDot.className = "w-2 h-2 rounded-full " + (isActive ? "bg-tertiary" : "bg-slate-600");
    nameWrap.appendChild(statusDot);
    const nameSpan = document.createElement("span");
    nameSpan.className = "text-sm font-medium text-on-surface";
    nameSpan.textContent = k.name ?? "";
    nameWrap.appendChild(nameSpan);
    td1.appendChild(nameWrap);
    tr.appendChild(td1);

    /* Prefix */
    const td2 = document.createElement("td");
    td2.className = "px-6 py-4 font-mono text-xs text-primary";
    td2.textContent = k.key_prefix ?? "";
    tr.appendChild(td2);

    /* Status toggle */
    const td3 = document.createElement("td");
    td3.className = "px-6 py-4";
    const toggle = document.createElement("div");
    toggle.className = "w-8 h-4 rounded-full relative p-0.5 " + (isActive ? "bg-tertiary/20" : "bg-slate-800");
    const toggleDot = document.createElement("div");
    toggleDot.className = "absolute top-0.5 bottom-0.5 w-3 rounded-full " + (isActive ? "right-0.5 bg-tertiary" : "left-0.5 bg-slate-600");
    toggle.appendChild(toggleDot);
    td3.appendChild(toggle);
    tr.appendChild(td3);

    /* Groups */
    const td4 = document.createElement("td");
    td4.className = "px-6 py-4";
    const groupWrap = document.createElement("div");
    groupWrap.className = "flex gap-1";
    if (k.groups?.length) {
      k.groups.forEach(g => {
        const chip = document.createElement("span");
        chip.className = "px-2 py-0.5 bg-white/5 rounded-sm text-[10px] text-slate-400 border border-white/10 uppercase font-bold";
        chip.textContent = typeof g === "string" ? g : (g.name ?? g.id ?? "?");
        groupWrap.appendChild(chip);
      });
    } else {
      const noGroup = document.createElement("span");
      noGroup.className = "text-[10px] text-slate-600 italic";
      noGroup.textContent = "No groups";
      groupWrap.appendChild(noGroup);
    }
    td4.appendChild(groupWrap);
    tr.appendChild(td4);

    /* Created Date */
    const td5 = document.createElement("td");
    td5.className = "px-6 py-4 font-mono text-xs text-slate-500";
    td5.textContent = fmtDate(k.created_at);
    tr.appendChild(td5);

    /* Usage sparkline */
    const td6 = document.createElement("td");
    td6.className = "px-6 py-4";
    const usageWrap = document.createElement("div");
    usageWrap.className = "flex items-end gap-0.5 h-6";
    const usage = k.usage_today ?? 0;
    const heights = [2, 4, 3, 5, 6];
    heights.forEach((h, i) => {
      const bar = document.createElement("div");
      bar.className = "w-1 bg-primary/" + (20 + i * 20);
      bar.style.height = (usage > 0 ? h : 1) + "px";
      usageWrap.appendChild(bar);
    });
    const usageCount = document.createElement("span");
    usageCount.className = "ml-2 text-xs font-mono text-primary font-bold";
    usageCount.textContent = fmt(usage);
    usageWrap.appendChild(usageCount);
    td6.appendChild(usageWrap);
    tr.appendChild(td6);

    /* Fragments quota */
    const tdFrag = document.createElement("td");
    tdFrag.className = "px-6 py-4";
    const fragCount = k.fragment_count ?? 0;
    const fragLimit = k.fragment_limit;
    const fragSpan  = document.createElement("span");
    fragSpan.className = "text-xs font-mono";
    if (fragLimit == null) {
      fragSpan.classList.add("text-slate-400");
      fragSpan.textContent = fmt(fragCount) + " / Unlimited";
    } else {
      const ratio = fragLimit > 0 ? fragCount / fragLimit : 0;
      if (ratio >= 1.0) {
        fragSpan.classList.add("text-red-400");
      } else if (ratio >= 0.8) {
        fragSpan.classList.add("text-orange-400");
      } else {
        fragSpan.classList.add("text-on-surface");
      }
      fragSpan.textContent = fmt(fragCount) + " / " + fmt(fragLimit);
    }
    tdFrag.appendChild(fragSpan);
    tr.appendChild(tdFrag);

    /* Actions: more_vert */
    const td7 = document.createElement("td");
    td7.className = "px-6 py-4";
    const moreBtn = document.createElement("button");
    moreBtn.className = "text-slate-500 hover:text-slate-300";
    const moreIcon = document.createElement("span");
    moreIcon.className = "material-symbols-outlined";
    moreIcon.textContent = "more_vert";
    moreBtn.appendChild(moreIcon);
    td7.appendChild(moreBtn);
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
  countText.textContent = "Showing " + keys.length + " entries";
  footer.appendChild(countText);
  wrap.appendChild(footer);

  return wrap;
}

export function renderKeyInspector(key, container) {
  const panel = document.createElement("aside");
  panel.className = "w-96 bg-surface-container-high border-l border-white/5 flex flex-col p-6 gap-6 relative overflow-y-auto";
  panel.id = "key-inspector";

  if (!key) {
    const empty = document.createElement("div");
    empty.className = "flex flex-col items-center justify-center h-full text-slate-600";
    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined text-4xl mb-4";
    icon.textContent = "vpn_key";
    empty.appendChild(icon);
    const txt = document.createElement("div");
    txt.className = "text-xs uppercase tracking-widest";
    txt.textContent = "SELECT A KEY TO INSPECT";
    empty.appendChild(txt);
    panel.appendChild(empty);
    return panel;
  }

  /* Inspector Header */
  const headerDiv = document.createElement("div");
  headerDiv.className = "flex items-center justify-between";
  const headerLabel = document.createElement("h3");
  headerLabel.className = "text-xs font-bold text-slate-400 tracking-widest uppercase font-label flex items-center gap-2";
  const infoIcon = document.createElement("span");
  infoIcon.className = "material-symbols-outlined text-primary text-lg";
  infoIcon.textContent = "info";
  headerLabel.appendChild(infoIcon);
  headerLabel.appendChild(document.createTextNode("KEY INSPECTOR"));
  headerDiv.appendChild(headerLabel);

  const closeBtn = document.createElement("button");
  closeBtn.className = "text-slate-500 hover:text-slate-300";
  closeBtn.addEventListener("click", () => { state.selectedKeyId = null; });
  const closeIcon = document.createElement("span");
  closeIcon.className = "material-symbols-outlined";
  closeIcon.textContent = "close";
  closeBtn.appendChild(closeIcon);
  headerDiv.appendChild(closeBtn);
  panel.appendChild(headerDiv);

  /* Key Identity Card */
  const idCard = document.createElement("div");
  idCard.className = "bg-surface-container-highest p-4 rounded-sm border-l-2 border-primary";

  const idName = document.createElement("h4");
  idName.className = "text-on-surface font-bold text-lg";
  idName.textContent = key.name ?? "";
  idCard.appendChild(idName);

  const idPrefix = document.createElement("p");
  idPrefix.className = "text-xs font-mono text-primary mt-1";
  idPrefix.textContent = key.key_prefix ?? "";
  idCard.appendChild(idPrefix);

  const isActive = key.status === "active";

  const statusBadge = document.createElement("div");
  statusBadge.className = "inline-block mt-2 px-2 py-1 text-[10px] font-bold border " + (isActive ? "bg-tertiary/10 text-tertiary border-tertiary/20" : "bg-slate-800 text-slate-500 border-slate-700");
  statusBadge.textContent = (key.status ?? "").toUpperCase();
  idCard.appendChild(statusBadge);

  /* Stats */
  const statsDiv = document.createElement("div");
  statsDiv.className = "mt-4 space-y-2";

  const inspFragCount = key.fragment_count ?? 0;
  const inspFragLimit = key.fragment_limit;
  const fragDisplayVal = inspFragLimit != null
    ? fmt(inspFragCount) + " / " + fmt(inspFragLimit)
    : fmt(inspFragCount) + " / Unlimited";

  [
    { label: "Total Usage",  value: fmt(key.usage_today ?? 0) + " req" },
    { label: "Last Active",  value: fmtDate(key.created_at) },
    { label: "Fragments",    value: fragDisplayVal, fragQuota: true }
  ].forEach(f => {
    const row = document.createElement("div");
    row.className = "flex justify-between items-center";
    const lbl = document.createElement("span");
    lbl.className = "text-xs text-slate-400";
    lbl.textContent = f.label;
    row.appendChild(lbl);
    const valWrap = document.createElement("div");
    valWrap.className = "flex items-center gap-2";
    const val = document.createElement("span");
    val.className = "text-xs font-mono text-on-surface";
    if (f.fragQuota && inspFragLimit != null) {
      const ratio = inspFragLimit > 0 ? inspFragCount / inspFragLimit : 0;
      if (ratio >= 1.0) val.classList.add("text-red-400");
      else if (ratio >= 0.8) val.classList.add("text-orange-400");
    }
    val.textContent = f.value;
    valWrap.appendChild(val);
    if (f.fragQuota) {
      const changeBtn = document.createElement("button");
      changeBtn.className = "text-[9px] text-primary font-bold uppercase hover:underline";
      changeBtn.textContent = "Change Limit";
      changeBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const current = inspFragLimit != null ? String(inspFragLimit) : "";
        const input   = prompt("New fragment limit (leave empty for unlimited):", current);
        if (input === null) return;
        const newLimit = input.trim() === "" ? null : parseInt(input.trim());
        if (newLimit !== null && (isNaN(newLimit) || newLimit < 0)) {
          showToast("Invalid limit value", "warning");
          return;
        }
        const res = await api("/keys/" + key.id + "/fragment-limit", {
          method: "PUT",
          body: { fragment_limit: newLimit }
        });
        if (res.ok) {
          showToast("Fragment limit updated", "success");
          renderKeys(container);
        } else {
          showToast(res.data?.error ?? "Update failed", "error");
        }
      });
      valWrap.appendChild(changeBtn);
    }
    row.appendChild(valWrap);
    statsDiv.appendChild(row);
  });
  idCard.appendChild(statsDiv);

  /* Daily Limit — editable */
  const dailyRow = document.createElement("div");
  dailyRow.className = "flex justify-between items-center mt-2";
  const dailyLabel = document.createElement("span");
  dailyLabel.className = "text-[10px] font-bold text-slate-500 uppercase tracking-wider";
  dailyLabel.textContent = "DAILY RATE LIMIT";
  dailyRow.appendChild(dailyLabel);
  const dailyVal = document.createElement("input");
  dailyVal.type = "number";
  dailyVal.min = "1";
  dailyVal.max = "99999";
  dailyVal.step = "1000";
  dailyVal.value = String(key.daily_limit ?? 10000);
  dailyVal.className = "w-24 bg-transparent border border-outline-variant/30 rounded-sm px-2 py-1 text-right text-sm font-mono text-on-surface focus:border-primary focus:outline-none";
  dailyVal.addEventListener("change", async () => {
    const val = parseInt(dailyVal.value);
    if (!val || val < 1) { showToast("1 이상 입력", "warning"); dailyVal.value = key.daily_limit; return; }
    const r = await api("/keys/" + key.id + "/daily-limit", { method: "PUT", body: { daily_limit: val } });
    if (r.ok) { showToast("Daily limit updated", "success"); key.daily_limit = val; }
    else showToast(r.data?.error ?? "Update failed", "error");
  });
  dailyRow.appendChild(dailyVal);
  idCard.appendChild(dailyRow);

  /* Permissions — toggle */
  const permRow = document.createElement("div");
  permRow.className = "flex justify-between items-center";
  const permLabel = document.createElement("span");
  permLabel.className = "text-[10px] font-bold text-slate-500 uppercase tracking-wider";
  permLabel.textContent = "PERMISSIONS";
  permRow.appendChild(permLabel);

  const permBtns = document.createElement("div");
  permBtns.className = "flex gap-1";
  ["read", "write"].forEach(p => {
    const btn = document.createElement("button");
    const active = (key.permissions || []).includes(p);
    btn.className = "px-2 py-0.5 text-[10px] font-bold rounded-sm border " +
      (active ? "bg-primary/20 text-primary border-primary/30" : "bg-transparent text-slate-600 border-white/10");
    btn.textContent = p.toUpperCase();
    btn.addEventListener("click", async () => {
      const current = new Set(key.permissions || []);
      if (current.has(p)) current.delete(p); else current.add(p);
      const perms = Array.from(current);
      if (!perms.length) { showToast("At least one permission required", "warning"); return; }
      const r = await api("/keys/" + key.id + "/permissions", { method: "PUT", body: { permissions: perms } });
      if (r.ok) { showToast("Permissions updated", "success"); key.permissions = perms; renderKeys(container); }
      else showToast(r.data?.error ?? "Update failed", "error");
    });
    permBtns.appendChild(btn);
  });
  permRow.appendChild(permBtns);
  idCard.appendChild(permRow);

  /* Fragment Limit — editable */
  const fragRow = document.createElement("div");
  fragRow.className = "flex justify-between items-center";
  const fragLabel = document.createElement("span");
  fragLabel.className = "text-[10px] font-bold text-slate-500 uppercase tracking-wider";
  fragLabel.textContent = "FRAGMENT LIMIT";
  fragRow.appendChild(fragLabel);

  const fragVal = document.createElement("input");
  fragVal.type = "number";
  fragVal.min = "0";
  fragVal.max = "99999";
  fragVal.step = "1000";
  fragVal.value = key.fragment_limit != null ? String(key.fragment_limit) : "";
  fragVal.placeholder = "Unlimited";
  fragVal.className = "w-24 bg-transparent border border-outline-variant/30 rounded-sm px-2 py-1 text-right text-sm font-mono text-on-surface focus:border-primary focus:outline-none";
  fragVal.addEventListener("change", async () => {
    const raw = fragVal.value.trim();
    const limit = raw === "" ? null : parseInt(raw);
    if (limit !== null && (isNaN(limit) || limit < 0)) { showToast("0 이상 입력 또는 빈칸(무제한)", "warning"); return; }
    const r = await api("/keys/" + key.id + "/fragment-limit", { method: "PUT", body: { fragment_limit: limit } });
    if (r.ok) { showToast("Fragment limit updated", "success"); key.fragment_limit = limit; }
    else showToast(r.data?.error ?? "Update failed", "error");
  });
  fragRow.appendChild(fragVal);
  idCard.appendChild(fragRow);

  panel.appendChild(idCard);

  /* Assigned Groups */
  const groupsSection = document.createElement("div");
  const groupsLabel = document.createElement("div");
  groupsLabel.className = "text-[10px] font-bold text-slate-400 tracking-widest uppercase mb-2 font-label";
  groupsLabel.textContent = "ASSIGNED GROUPS";
  groupsSection.appendChild(groupsLabel);

  const groupChips = document.createElement("div");
  groupChips.className = "flex flex-wrap gap-2 mb-2";
  if (key.groups?.length) {
    key.groups.forEach(g => {
      const gName = typeof g === "string" ? g : (g.name ?? g.id ?? "?");
      const chip = document.createElement("span");
      chip.className = "px-2 py-0.5 bg-white/5 rounded-sm text-[10px] text-slate-400 border border-white/10 uppercase font-bold flex items-center gap-1";
      chip.textContent = gName;
      const rmIcon = document.createElement("span");
      rmIcon.className = "material-symbols-outlined text-[12px] text-slate-500 cursor-pointer hover:text-error";
      rmIcon.textContent = "close";
      const gId = typeof g === "string" ? g : g.id;
      rmIcon.addEventListener("click", async (e) => {
        e.stopPropagation();
        await api("/groups/" + gId + "/members/" + key.id, { method: "DELETE" });
        showToast("Removed from group", "success");
        renderKeys(container);
      });
      chip.appendChild(rmIcon);
      groupChips.appendChild(chip);
    });
  }

  const addGroupBtn = document.createElement("button");
  addGroupBtn.className = "px-2 py-0.5 border border-dashed border-white/10 text-[10px] text-slate-500 uppercase hover:border-primary hover:text-primary transition-colors cursor-pointer";
  addGroupBtn.textContent = "ADD GROUP";
  addGroupBtn.addEventListener("click", () => {
    const form = document.createElement("div");
    const g1 = document.createElement("div");
    g1.className = "form-group";
    const l1 = document.createElement("label");
    l1.className = "form-label";
    l1.textContent = "SELECT GROUP";
    g1.appendChild(l1);
    const sel = document.createElement("select");
    sel.className = "form-select";
    sel.id = "modal-assign-group";
    const existingGroupIds = new Set((key.groups ?? []).map(g => typeof g === "string" ? g : g.id));
    const available = (state.groups ?? []).filter(g => !existingGroupIds.has(g.id));
    if (!available.length) {
      const opt = document.createElement("option");
      opt.textContent = "(no available groups)";
      opt.disabled = true;
      sel.appendChild(opt);
    }
    available.forEach(g => {
      const opt = document.createElement("option");
      opt.value = g.id;
      opt.textContent = g.name;
      sel.appendChild(opt);
    });
    g1.appendChild(sel);
    form.appendChild(g1);

    showModal("Assign to Group", form, [
      { id: "assign", label: "ASSIGN", cls: "btn-primary", handler: async () => {
        const groupId = document.getElementById("modal-assign-group")?.value;
        if (!groupId) return;
        await api("/groups/" + groupId + "/members", { method: "POST", body: { key_id: key.id } });
        closeModal();
        showToast("Assigned to group", "success");
        renderKeys(container);
      }}
    ]);
  });
  groupChips.appendChild(addGroupBtn);
  groupsSection.appendChild(groupChips);
  panel.appendChild(groupsSection);

  /* Groups Directory */
  const dirSection = document.createElement("div");
  dirSection.className = "mt-auto border-t border-white/5 pt-6";
  const dirLabel = document.createElement("div");
  dirLabel.className = "text-[10px] font-bold text-slate-400 tracking-widest uppercase mb-2 font-label";
  dirLabel.textContent = "GROUPS DIRECTORY";
  dirSection.appendChild(dirLabel);

  const dirList = document.createElement("div");
  dirList.className = "space-y-1";
  state.groups.forEach(g => {
    const row = document.createElement("div");
    row.className = "flex items-center justify-between p-2 hover:bg-white/5 transition-colors";
    const name = document.createElement("span");
    name.className = "text-xs text-slate-300";
    name.textContent = g.name;
    row.appendChild(name);
    const assignBtn = document.createElement("button");
    assignBtn.className = "text-[9px] text-primary font-bold uppercase cursor-pointer hover:text-primary/80";
    assignBtn.textContent = "ASSIGN";
    assignBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await api("/groups/" + g.id + "/members", { method: "POST", body: { key_id: key.id } });
      showToast("Assigned to " + g.name, "success");
      renderKeys(container);
    });
    row.appendChild(assignBtn);
    dirList.appendChild(row);
  });
  dirSection.appendChild(dirList);
  panel.appendChild(dirSection);

  /* Danger Zone */
  const danger = document.createElement("div");
  danger.className = "pt-6 border-t border-white/5";
  const dangerLabel = document.createElement("p");
  dangerLabel.className = "text-[10px] font-bold text-error tracking-widest uppercase mb-3 font-label";
  dangerLabel.textContent = "DANGER ZONE";
  danger.appendChild(dangerLabel);

  const dangerGrid = document.createElement("div");
  dangerGrid.className = "space-y-2";

  const toggleStatus = isActive ? "inactive" : "active";
  const toggleBtn = document.createElement("button");
  toggleBtn.className = "w-full py-2 border border-error/30 text-error text-[10px] font-bold hover:bg-error/10 transition-all uppercase";
  toggleBtn.textContent = isActive ? "REVOKE KEY" : "ACTIVATE KEY";
  toggleBtn.dataset.keyAction = "toggle";
  toggleBtn.dataset.keyId     = key.id;
  toggleBtn.dataset.status    = toggleStatus;
  dangerGrid.appendChild(toggleBtn);

  const delBtn = document.createElement("button");
  delBtn.className = "w-full py-2 bg-error text-on-error text-[10px] font-bold hover:brightness-110 transition-all uppercase";
  delBtn.textContent = "DELETE PERMANENTLY";
  delBtn.dataset.keyAction = "delete";
  delBtn.dataset.keyId     = key.id;
  dangerGrid.appendChild(delBtn);

  danger.appendChild(dangerGrid);
  panel.appendChild(danger);

  return panel;
}

export async function renderKeys(container) {
  container.textContent = "";
  container.appendChild(loadingHtml());

  const [res, gRes] = await Promise.all([api("/keys"), api("/groups")]);
  if (res.ok) state.keys   = res.data ?? [];
  if (gRes.ok) state.groups = gRes.data ?? [];

  const selectedKey = state.keys.find(k => k.id === state.selectedKeyId) ?? null;

  container.textContent = "";

  /* Header */
  const header = document.createElement("div");
  header.className = "flex justify-between items-end mb-8";
  const headerLeft = document.createElement("div");
  const h2 = document.createElement("h2");
  h2.className = "text-2xl font-headline font-bold text-on-surface tracking-tight";
  h2.textContent = "API Key Management";
  headerLeft.appendChild(h2);
  const subtitle = document.createElement("p");
  subtitle.className = "text-sm text-slate-400 mt-1";
  subtitle.textContent = "Operational key cycles and group access control.";
  headerLeft.appendChild(subtitle);
  header.appendChild(headerLeft);

  const createBtn = document.createElement("button");
  createBtn.className = "btn-primary px-5 py-2.5 bg-primary-container text-on-primary-fixed font-bold text-sm flex items-center gap-2";
  createBtn.id = "create-key-btn";
  const addIcon = document.createElement("span");
  addIcon.className = "material-symbols-outlined text-lg";
  addIcon.textContent = "add";
  createBtn.appendChild(addIcon);
  createBtn.appendChild(document.createTextNode("CREATE API KEY"));
  header.appendChild(createBtn);
  container.appendChild(header);

  /* KPI Row */
  container.appendChild(renderKeyKpiRow(state.keys));

  /* Filter Bar */
  const filterBar = document.createElement("div");
  filterBar.className = "glass-panel p-2 rounded-sm flex items-center gap-4 mb-6";

  const groupChip = document.createElement("div");
  groupChip.className = "px-3 py-1 bg-surface-variant text-[10px] font-bold flex items-center gap-2 rounded-sm text-primary";
  const groupSelect = document.createElement("select");
  groupSelect.id = "key-filter-group";
  groupSelect.className = "bg-transparent border-none outline-none text-[10px] font-bold text-slate-400 cursor-pointer";
  const groupOptAll = document.createElement("option");
  groupOptAll.value = "";
  groupOptAll.textContent = "GROUP: ALL";
  groupSelect.appendChild(groupOptAll);
  const groupOptNone = document.createElement("option");
  groupOptNone.value = "__none__";
  groupOptNone.textContent = "GROUP: UNASSIGNED";
  if (state.keyFilterGroup === "__none__") groupOptNone.selected = true;
  groupSelect.appendChild(groupOptNone);
  const seenGroups = new Map();
  state.keys.forEach(k => (k.groups ?? []).forEach(g => {
    const gid  = typeof g === "string" ? g : g.id;
    const gname = typeof g === "string" ? g : g.name;
    if (!seenGroups.has(gid)) seenGroups.set(gid, gname);
  }));
  for (const [gid, gname] of seenGroups) {
    const opt = document.createElement("option");
    opt.value = gid;
    opt.textContent = "GROUP: " + (gname ?? gid).toUpperCase();
    if (state.keyFilterGroup === gid) opt.selected = true;
    groupSelect.appendChild(opt);
  }
  groupChip.appendChild(groupSelect);
  filterBar.appendChild(groupChip);

  const statusChip = document.createElement("div");
  statusChip.className = "px-3 py-1 bg-surface-variant text-[10px] font-bold flex items-center gap-2 rounded-sm text-primary";
  const statusSelect = document.createElement("select");
  statusSelect.id = "key-filter-status";
  statusSelect.className = "bg-transparent border-none outline-none text-[10px] font-bold text-slate-400 cursor-pointer";
  ["", "active", "inactive"].forEach(v => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v ? "STATUS: " + v.toUpperCase() : "STATUS: ALL";
    if (state.keyFilterStatus === v) opt.selected = true;
    statusSelect.appendChild(opt);
  });
  statusChip.appendChild(statusSelect);
  filterBar.appendChild(statusChip);

  const countLabel = document.createElement("span");
  countLabel.className = "ml-auto text-[10px] text-slate-500 font-mono";
  countLabel.id = "key-filter-count";
  filterBar.appendChild(countLabel);

  container.appendChild(filterBar);

  /* Apply filters */
  let filteredKeys = state.keys;
  if (state.keyFilterStatus) {
    filteredKeys = filteredKeys.filter(k => k.status === state.keyFilterStatus);
  }
  if (state.keyFilterGroup === "__none__") {
    filteredKeys = filteredKeys.filter(k => !k.groups?.length);
  } else if (state.keyFilterGroup) {
    filteredKeys = filteredKeys.filter(k =>
      (k.groups ?? []).some(g => (typeof g === "string" ? g : g.id) === state.keyFilterGroup)
    );
  }
  countLabel.textContent = filteredKeys.length + " / " + state.keys.length;

  /* Split layout */
  const split = document.createElement("div");
  split.className = "flex gap-0";
  split.style.minHeight = "400px";

  split.appendChild(renderKeyTable(filteredKeys));
  split.appendChild(renderKeyInspector(selectedKey, container));
  container.appendChild(split);

  /* Event: table row click */
  container.querySelectorAll("#keys-table tbody tr").forEach(tr => {
    tr.addEventListener("click", () => {
      state.selectedKeyId = tr.dataset.keyId;
      renderKeys(container);
    });
  });

  /* Event: create key */
  createBtn.addEventListener("click", () => {
    const form = document.createElement("div");

    const g1 = document.createElement("div");
    g1.className = "form-group";
    const l1 = document.createElement("label");
    l1.className = "form-label";
    l1.textContent = "KEY NAME / IDENTIFIER";
    g1.appendChild(l1);
    const nameInput = document.createElement("input");
    nameInput.className = "form-input";
    nameInput.id = "modal-key-name";
    nameInput.placeholder = "e.g. analytical-hub-prod";
    g1.appendChild(nameInput);
    form.appendChild(g1);

    const g2 = document.createElement("div");
    g2.className = "form-group";
    const l2 = document.createElement("label");
    l2.className = "form-label";
    l2.textContent = "DAILY RATE LIMIT";
    g2.appendChild(l2);
    const limitInput = document.createElement("input");
    limitInput.className = "form-input";
    limitInput.id = "modal-key-limit";
    limitInput.type = "number";
    limitInput.min = "1";
    limitInput.max = "99999";
    limitInput.step = "1000";
    limitInput.value = "10000";
    g2.appendChild(limitInput);
    form.appendChild(g2);

    const g3 = document.createElement("div");
    g3.className = "form-group";
    const l3 = document.createElement("label");
    l3.className = "form-label";
    l3.textContent = "FRAGMENT LIMIT";
    g3.appendChild(l3);
    const fragLimitInput = document.createElement("input");
    fragLimitInput.className = "form-input";
    fragLimitInput.id = "modal-key-frag-limit";
    fragLimitInput.type = "number";
    fragLimitInput.min = "0";
    fragLimitInput.max = "99999";
    fragLimitInput.step = "1000";
    fragLimitInput.placeholder = "5000";
    g3.appendChild(fragLimitInput);
    const fragHint = document.createElement("p");
    fragHint.className = "text-[10px] text-slate-500 mt-1";
    fragHint.textContent = "Leave empty for unlimited";
    g3.appendChild(fragHint);
    form.appendChild(g3);

    const g4 = document.createElement("div");
    g4.className = "form-group";
    const l4 = document.createElement("label");
    l4.className = "form-label";
    l4.textContent = "PERMISSIONS";
    g4.appendChild(l4);

    const permWrap = document.createElement("div");
    permWrap.className = "flex gap-4";

    const readLabel = document.createElement("label");
    readLabel.className = "flex items-center gap-2 text-sm text-on-surface cursor-pointer";
    const readCb = document.createElement("input");
    readCb.type = "checkbox";
    readCb.id = "modal-perm-read";
    readCb.checked = true;
    readCb.className = "accent-primary";
    readLabel.appendChild(readCb);
    readLabel.appendChild(document.createTextNode("Read"));
    permWrap.appendChild(readLabel);

    const writeLabel = document.createElement("label");
    writeLabel.className = "flex items-center gap-2 text-sm text-on-surface cursor-pointer";
    const writeCb = document.createElement("input");
    writeCb.type = "checkbox";
    writeCb.id = "modal-perm-write";
    writeCb.checked = true;
    writeCb.className = "accent-primary";
    writeLabel.appendChild(writeCb);
    writeLabel.appendChild(document.createTextNode("Write"));
    permWrap.appendChild(writeLabel);

    g4.appendChild(permWrap);
    form.appendChild(g4);

    showModal("Generate New API Credential", form, [
      { id: "create", label: "GENERATE AND VIEW SECRET", cls: "btn-primary", handler: async () => {
        const name        = document.getElementById("modal-key-name")?.value.trim();
        const daily_limit = parseInt(document.getElementById("modal-key-limit")?.value) || 10000;
        const fragLimitRaw = document.getElementById("modal-key-frag-limit")?.value.trim();
        const fragment_limit = fragLimitRaw ? parseInt(fragLimitRaw) : null;
        if (!name) { showToast("Name required", "warning"); return; }
        const perms = [];
        if (document.getElementById("modal-perm-read")?.checked) perms.push("read");
        if (document.getElementById("modal-perm-write")?.checked) perms.push("write");
        const body = { name, daily_limit, permissions: perms };
        if (fragment_limit != null) body.fragment_limit = fragment_limit;
        const res = await api("/keys", { method: "POST", body });
        closeModal();
        if (res.ok && res.data?.raw_key) {
          const keyDisplay = document.createElement("div");
          const note = document.createElement("p");
          note.className = "text-xs text-primary leading-relaxed mb-4";
          note.textContent = "This secret key will only be displayed once. Store it in a secure vault.";
          keyDisplay.appendChild(note);

          const copyWrap = document.createElement("div");
          copyWrap.className = "copy-wrap";
          const copyVal = document.createElement("span");
          copyVal.className = "copy-value";
          copyVal.textContent = res.data.raw_key;
          copyWrap.appendChild(copyVal);
          const copyBtn = document.createElement("button");
          copyBtn.className = "copy-btn";
          copyBtn.textContent = "COPY";
          copyBtn.addEventListener("click", () => {
            navigator.clipboard.writeText(res.data.raw_key).then(() => showToast("Copied", "success"));
          });
          copyWrap.appendChild(copyBtn);
          keyDisplay.appendChild(copyWrap);

          showModal("Credential Generated", keyDisplay, [
            { id: "done", label: "DONE", cls: "btn-primary", handler: () => { closeModal(); renderKeys(container); } }
          ]);
        } else {
          showToast(res.data?.error ?? "Generation failed", "error");
          renderKeys(container);
        }
      }}
    ]);
  });

  /* Event: inspector actions */
  container.querySelectorAll("[data-key-action]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = btn.dataset.keyAction;
      const keyId  = btn.dataset.keyId;

      if (action === "toggle") {
        const newStatus = btn.dataset.status;
        const msg = document.createElement("span");
        msg.className = "text-sm text-slate-300";
        msg.textContent = "Change this key to " + newStatus + " status?";
        showModal("Confirm Status Change", msg, [
          { id: "confirm", label: "CONFIRM", cls: "btn-primary", handler: async () => {
            await api("/keys/" + keyId, { method: "PUT", body: { status: newStatus } });
            closeModal();
            showToast("Status updated", "success");
            renderKeys(container);
          }}
        ]);
      }

      if (action === "delete") {
        const msg = document.createElement("span");
        msg.className = "text-sm text-error";
        msg.textContent = "This action is irreversible. Delete permanently?";
        showModal("Confirm Permanent Deletion", msg, [
          { id: "confirm", label: "DELETE", cls: "btn-danger", handler: async () => {
            await api("/keys/" + keyId, { method: "DELETE" });
            closeModal();
            state.selectedKeyId = null;
            showToast("Key deleted", "success");
            renderKeys(container);
          }}
        ]);
      }
    });
  });

  /* Event: filter selects */
  document.getElementById("key-filter-group")?.addEventListener("change", (e) => {
    state.keyFilterGroup = e.target.value;
    renderKeys(container);
  });
  document.getElementById("key-filter-status")?.addEventListener("change", (e) => {
    state.keyFilterStatus = e.target.value;
    renderKeys(container);
  });
}
