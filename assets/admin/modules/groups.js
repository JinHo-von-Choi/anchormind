/**
 * Memento MCP Admin Console — Groups 뷰
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 */

import { state, beginRender, syncRoute } from "./state.js";
import { api }                           from "./api.js";
import { showToast, showModal, closeModal } from "./ui.js";
import { fmt, fmtDate, loadingHtml }     from "./format.js";

export function renderGroupKpiRow(groups, keys) {
  const totalGroups  = groups.length;
  const totalMembers = groups.reduce((sum, g) => sum + (g.member_count ?? 0), 0);
  const emptyGroups  = groups.filter(g => (g.member_count ?? 0) === 0).length;
  const noGroupKeys  = keys.filter(k => !k.groups?.length).length;

  const cards = [
    { label: "TOTAL GROUPS",   value: totalGroups,  border: "bg-secondary" },
    { label: "TOTAL MEMBERS",  value: totalMembers, border: "bg-tertiary" },
    { label: "EMPTY GROUPS",   value: emptyGroups,  border: "bg-error" },
    { label: "UNASSIGNED KEYS", value: noGroupKeys,  border: "bg-primary" }
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

export function renderGroupTable(groups) {
  const wrap = document.createElement("div");
  wrap.className = "glass-panel flex-1 flex flex-col min-h-0";

  const table = document.createElement("table");
  table.className = "w-full text-left border-collapse";
  table.id = "groups-table";

  const thead = document.createElement("thead");
  thead.className = "bg-white/5 border-b border-white/5";
  const hRow = document.createElement("tr");
  ["Name", "Description", "Members", "Created", ""].forEach(h => {
    const th = document.createElement("th");
    th.className = "px-6 py-4 text-[10px] font-bold text-slate-400 tracking-widest uppercase font-label";
    th.textContent = h;
    hRow.appendChild(th);
  });
  thead.appendChild(hRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  tbody.className = "divide-y divide-white/5";

  groups.forEach(g => {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-white/5 transition-colors group cursor-pointer" + (g.id === state.selectedGroupId ? " bg-white/[0.02]" : "");
    tr.dataset.groupId = g.id;

    /* Name */
    const td1 = document.createElement("td");
    td1.className = "px-6 py-4";
    const nameWrap = document.createElement("div");
    nameWrap.className = "flex items-center gap-3";
    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined text-lg text-secondary";
    icon.textContent = "shield";
    nameWrap.appendChild(icon);
    const name = document.createElement("span");
    name.className = "text-sm font-medium text-on-surface";
    name.textContent = g.name;
    nameWrap.appendChild(name);
    td1.appendChild(nameWrap);
    tr.appendChild(td1);

    /* Description */
    const td2 = document.createElement("td");
    td2.className = "px-6 py-4 text-xs text-slate-400";
    td2.textContent = g.description ?? "--";
    tr.appendChild(td2);

    /* Members */
    const td3 = document.createElement("td");
    td3.className = "px-6 py-4 text-xs font-mono text-on-surface";
    td3.textContent = fmt(g.member_count ?? 0);
    tr.appendChild(td3);

    /* Created */
    const td4 = document.createElement("td");
    td4.className = "px-6 py-4 font-mono text-xs text-slate-500";
    td4.textContent = fmtDate(g.created_at);
    tr.appendChild(td4);

    /* Actions */
    const td5 = document.createElement("td");
    td5.className = "px-6 py-4";
    const moreBtn = document.createElement("button");
    moreBtn.className = "text-slate-500 hover:text-slate-300";
    const moreIcon = document.createElement("span");
    moreIcon.className = "material-symbols-outlined";
    moreIcon.textContent = "more_vert";
    moreBtn.appendChild(moreIcon);
    td5.appendChild(moreBtn);
    tr.appendChild(td5);

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  wrap.appendChild(table);

  /* Footer */
  const footer = document.createElement("div");
  footer.className = "mt-auto p-4 border-t border-white/5 flex justify-between items-center bg-white/[0.01]";
  const countText = document.createElement("span");
  countText.className = "text-xs text-slate-500";
  countText.textContent = "Showing " + groups.length + " groups";
  footer.appendChild(countText);
  wrap.appendChild(footer);

  return wrap;
}

export function renderGroupInspector(selected, members) {
  const panel = document.createElement("aside");
  panel.className = "w-96 bg-surface-container-high border-l border-white/5 flex flex-col p-6 gap-6 relative overflow-y-auto";
  panel.id = "group-inspector";

  if (!selected) {
    const empty = document.createElement("div");
    empty.className = "flex flex-col items-center justify-center h-full text-slate-600";
    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined text-4xl mb-4";
    icon.textContent = "group";
    empty.appendChild(icon);
    const txt = document.createElement("div");
    txt.className = "text-xs uppercase tracking-widest";
    txt.textContent = "SELECT A GROUP TO INSPECT";
    empty.appendChild(txt);
    panel.appendChild(empty);
    return panel;
  }

  /* Header */
  const headerDiv = document.createElement("div");
  headerDiv.className = "flex items-center justify-between";
  const headerLabel = document.createElement("h3");
  headerLabel.className = "text-xs font-bold text-slate-400 tracking-widest uppercase font-label flex items-center gap-2";
  const infoIcon = document.createElement("span");
  infoIcon.className = "material-symbols-outlined text-secondary text-lg";
  infoIcon.textContent = "info";
  headerLabel.appendChild(infoIcon);
  headerLabel.appendChild(document.createTextNode("GROUP INSPECTOR"));
  headerDiv.appendChild(headerLabel);

  const closeBtn = document.createElement("button");
  closeBtn.className = "text-slate-500 hover:text-slate-300";
  closeBtn.dataset.groupAction = "close";
  const closeIcon = document.createElement("span");
  closeIcon.className = "material-symbols-outlined";
  closeIcon.textContent = "close";
  closeBtn.appendChild(closeIcon);
  headerDiv.appendChild(closeBtn);
  panel.appendChild(headerDiv);

  /* Group Identity */
  const idCard = document.createElement("div");
  idCard.className = "bg-surface-container-highest p-4 rounded-sm border-l-2 border-secondary";
  const gName = document.createElement("h4");
  gName.className = "text-on-surface font-bold text-lg";
  gName.textContent = selected.name;
  idCard.appendChild(gName);
  if (selected.description) {
    const gDesc = document.createElement("p");
    gDesc.className = "text-xs text-slate-400 mt-1";
    gDesc.textContent = selected.description;
    idCard.appendChild(gDesc);
  }
  const memberCount = document.createElement("div");
  memberCount.className = "mt-2 text-[10px] font-mono text-slate-500 uppercase";
  memberCount.textContent = fmt(selected.member_count ?? 0) + " Members";
  idCard.appendChild(memberCount);
  panel.appendChild(idCard);

  /* Member List */
  const membersLabel = document.createElement("div");
  membersLabel.className = "text-[10px] font-bold text-slate-400 tracking-widest uppercase mb-2 font-label";
  membersLabel.textContent = "MEMBERS";
  panel.appendChild(membersLabel);

  const memberList = document.createElement("div");
  memberList.className = "space-y-1";
  if (members && members.length) {
    members.forEach(m => {
      const row = document.createElement("div");
      row.className = "flex items-center justify-between p-2 bg-surface-container border border-white/5";
      const left = document.createElement("div");
      const mName = document.createElement("div");
      mName.className = "text-xs text-slate-200";
      mName.textContent = m.name ?? "";
      left.appendChild(mName);
      const mPrefix = document.createElement("div");
      mPrefix.className = "text-[10px] font-mono text-primary";
      mPrefix.textContent = m.key_prefix ?? "";
      left.appendChild(mPrefix);
      row.appendChild(left);
      const rmBtn = document.createElement("button");
      rmBtn.className = "text-[9px] text-error font-bold uppercase";
      rmBtn.textContent = "REMOVE";
      rmBtn.dataset.removeMember = m.id;
      row.appendChild(rmBtn);
      memberList.appendChild(row);
    });
  } else {
    const empty = document.createElement("div");
    empty.className = "text-[10px] text-slate-600 text-center py-4";
    empty.textContent = "No members";
    memberList.appendChild(empty);
  }
  panel.appendChild(memberList);

  /* Add member button */
  const addMemberBtn = document.createElement("button");
  addMemberBtn.className = "w-full py-2 border border-dashed border-white/10 text-[10px] text-slate-400 uppercase hover:border-secondary/30 hover:text-secondary transition-all";
  addMemberBtn.id = "add-member-btn";
  addMemberBtn.textContent = "ADD MEMBER";
  panel.appendChild(addMemberBtn);

  /* Danger Zone */
  const danger = document.createElement("div");
  danger.className = "pt-6 border-t border-white/5 mt-auto";
  const delBtn = document.createElement("button");
  delBtn.className = "w-full py-2 bg-error text-on-error text-[10px] font-bold hover:brightness-110 transition-all uppercase";
  delBtn.id = "delete-group-btn";
  delBtn.textContent = "DELETE GROUP";
  danger.appendChild(delBtn);
  panel.appendChild(danger);

  return panel;
}

/** 선택한 그룹과 주소 질의를 서로 옮긴다. */
export const groupsRoute = {
  fromQuery(query) { state.selectedGroupId = query.get("group") || null; },
  toQuery()        { return { group: state.selectedGroupId }; }
};

export async function renderGroups(container) {
  const ctx = beginRender();
  syncRoute();
  container.textContent = "";
  container.appendChild(loadingHtml());

  const [gRes, kRes] = await Promise.all([
    api("/groups", { signal: ctx.signal }),
    api("/keys", { signal: ctx.signal })
  ]);
  if (!ctx.isCurrent()) return;
  if (gRes.ok) state.groups = gRes.data ?? [];
  if (kRes.ok) state.keys   = kRes.data ?? [];

  const selected = state.groups.find(g => g.id === state.selectedGroupId) ?? null;
  let members = [];
  if (selected) {
    const mRes = await api("/groups/" + selected.id + "/members", { signal: ctx.signal });
    if (!ctx.isCurrent()) return;
    if (mRes.ok) members = mRes.data ?? [];
  }

  container.textContent = "";

  /* Header */
  const header = document.createElement("div");
  header.className = "flex justify-between items-end mb-8";
  const headerLeft = document.createElement("div");
  const h2 = document.createElement("h2");
  h2.className = "text-2xl font-headline font-bold text-on-surface tracking-tight";
  h2.textContent = "Group Management";
  headerLeft.appendChild(h2);
  const subtitle = document.createElement("p");
  subtitle.className = "text-sm text-slate-400 mt-1";
  subtitle.textContent = "Organize API keys into logical access groups.";
  headerLeft.appendChild(subtitle);
  header.appendChild(headerLeft);

  const createBtn = document.createElement("button");
  createBtn.className = "btn-primary px-5 py-2.5 bg-primary-container text-on-primary-fixed font-bold text-sm flex items-center gap-2";
  const addIcon = document.createElement("span");
  addIcon.className = "material-symbols-outlined text-lg";
  addIcon.textContent = "add";
  createBtn.appendChild(addIcon);
  createBtn.appendChild(document.createTextNode("CREATE GROUP"));
  header.appendChild(createBtn);
  container.appendChild(header);

  /* KPI Row */
  container.appendChild(renderGroupKpiRow(state.groups, state.keys));

  /* Split layout */
  const split = document.createElement("div");
  split.className = "flex gap-0";
  split.style.minHeight = "400px";

  split.appendChild(renderGroupTable(state.groups));
  split.appendChild(renderGroupInspector(selected, members));
  container.appendChild(split);

  /* Event: table row click */
  container.querySelectorAll("#groups-table tbody tr").forEach(tr => {
    tr.addEventListener("click", () => {
      state.selectedGroupId = tr.dataset.groupId;
      renderGroups(container);
    });
  });

  /* Event: close inspector */
  container.querySelector("[data-group-action='close']")?.addEventListener("click", () => {
    state.selectedGroupId = null;
    renderGroups(container);
  });

  /* Event: add member */
  document.getElementById("add-member-btn")?.addEventListener("click", () => {
    const form = document.createElement("div");
    const g1 = document.createElement("div");
    g1.className = "form-group";
    const l1 = document.createElement("label");
    l1.className = "form-label";
    l1.textContent = "SELECT API KEY";
    g1.appendChild(l1);
    const sel = document.createElement("select");
    sel.className = "form-select";
    sel.id = "modal-member-key";
    state.keys.forEach(k => {
      const opt = document.createElement("option");
      opt.value = k.id;
      opt.textContent = k.name + " (" + (k.key_prefix ?? "") + ")";
      sel.appendChild(opt);
    });
    g1.appendChild(sel);
    form.appendChild(g1);

    showModal("Add Member", form, [
      { id: "add", label: "ADD", cls: "btn-primary", handler: async () => {
        const keyId = document.getElementById("modal-member-key")?.value;
        if (!keyId) return;
        await api("/groups/" + state.selectedGroupId + "/members", { method: "POST", body: { key_id: keyId } });
        closeModal();
        showToast("Member added", "success");
        renderGroups(container);
      }}
    ]);
  });

  /* Event: remove member */
  container.querySelectorAll("[data-remove-member]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const keyId = btn.dataset.removeMember;
      await api("/groups/" + state.selectedGroupId + "/members/" + keyId, { method: "DELETE" });
      showToast("Member removed", "success");
      renderGroups(container);
    });
  });

  /* Event: delete group */
  document.getElementById("delete-group-btn")?.addEventListener("click", () => {
    const msg = document.createElement("span");
    msg.className = "text-sm text-error";
    msg.textContent = "This action is irreversible. Delete this group?";
    showModal("Confirm Group Deletion", msg, [
      { id: "confirm", label: "DELETE", cls: "btn-danger", handler: async () => {
        await api("/groups/" + state.selectedGroupId, { method: "DELETE" });
        closeModal();
        state.selectedGroupId = null;
        showToast("Group deleted", "success");
        renderGroups(container);
      }}
    ]);
  });

  /* Event: create group */
  createBtn.addEventListener("click", () => {
    const form = document.createElement("div");

    const g1 = document.createElement("div");
    g1.className = "form-group";
    const l1 = document.createElement("label");
    l1.className = "form-label";
    l1.textContent = "GROUP NAME";
    g1.appendChild(l1);
    const nameInput = document.createElement("input");
    nameInput.className = "form-input";
    nameInput.id = "modal-group-name";
    nameInput.placeholder = "e.g. CORE_OPERATIONS";
    g1.appendChild(nameInput);
    form.appendChild(g1);

    const g2 = document.createElement("div");
    g2.className = "form-group";
    const l2 = document.createElement("label");
    l2.className = "form-label";
    l2.textContent = "DESCRIPTION";
    g2.appendChild(l2);
    const descInput = document.createElement("input");
    descInput.className = "form-input";
    descInput.id = "modal-group-desc";
    descInput.placeholder = "(optional)";
    g2.appendChild(descInput);
    form.appendChild(g2);

    showModal("Create New Group", form, [
      { id: "create", label: "CREATE", cls: "btn-primary", handler: async () => {
        const name = document.getElementById("modal-group-name")?.value.trim();
        const description = document.getElementById("modal-group-desc")?.value.trim() || null;
        if (!name) { showToast("Name required", "warning"); return; }
        const res = await api("/groups", { method: "POST", body: { name, description } });
        closeModal();
        if (res.ok) { showToast("Group created", "success"); renderGroups(container); }
        else showToast(res.data?.error ?? "Creation failed", "error");
      }}
    ]);
  });
}
