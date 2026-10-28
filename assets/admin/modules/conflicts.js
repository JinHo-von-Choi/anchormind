/**
 * Memento MCP Admin Console — 모순 처리 화면
 *
 * 작성자: 최진호
 * 작성일: 2026-10-28
 *
 * 같은 키의 두 파편을 잇는 contradicts 링크를 보여 주고 해소한다. 한쪽을 남기면 다른 쪽은 만료되고
 * superseded_by 링크가 생긴다. 앵커 파편은 만료시킬 수 없다. 같은 모순을 다시 해소하면 처음 결정을 돌려준다.
 */

import { state, navigate, beginRender, syncRoute } from "./state.js";
import { api }                                     from "./api.js";
import { showToast }                               from "./ui.js";
import { fmtDate, loadingHtml }                    from "./format.js";

/** 입력 칸 스타일. 어두운 테마의 다른 화면 입력과 같다 */
const INPUT_CLASS = "bg-surface-container border border-outline-variant/30 rounded-sm px-3 py-1.5 text-xs text-on-surface placeholder:text-slate-500 focus:border-primary focus:outline-none";

/** 해소 결정 → 화면 문구 */
export const CONFLICT_DECISIONS = Object.freeze([
  { value: "keep_left",  label: "왼쪽 유지" },
  { value: "keep_right", label: "오른쪽 유지" },
  { value: "keep_both",  label: "둘 다 유지" },
  { value: "defer",      label: "보류" }
]);

/**
 * 결정 단추를 막아야 하는지. 만료될 쪽이 앵커이면 서버가 409로 거절하므로 미리 막는다.
 *
 * @param {Object} conflict
 * @param {string} decision
 * @returns {boolean}
 */
export function decisionBlocked(conflict, decision) {
  if (decision === "keep_left")  return conflict.right_anchor === true;
  if (decision === "keep_right") return conflict.left_anchor === true;
  return false;
}

/** 해소 상태 조건과 주소 질의를 서로 옮긴다. */
export const conflictsRoute = {
  fromQuery(query) { state.conflictStatus = query.get("status") === "all" ? "all" : "open"; },
  toQuery()        { return { status: state.conflictStatus === "all" ? "all" : "" }; }
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sideCard(label, id, topic, preview, validTo, anchor) {
  const card = el("div", "flex-1 bg-surface-container-highest p-3 space-y-1 border border-white/5");
  const head = el("div", "flex justify-between text-[10px] font-mono text-slate-400");
  const link = el("button", "text-primary hover:underline", `${label} · ${id}`);
  link.title = "메모리 운영에서 상세 보기";
  link.addEventListener("click", () => navigate("memory", { frag: id }));
  head.appendChild(link);
  head.appendChild(el("span", "", [topic ?? "-", anchor ? "앵커" : "", validTo ? "만료 " + fmtDate(validTo) : "유효"].filter(Boolean).join(" · ")));
  card.appendChild(head);
  card.appendChild(el("div", "text-[11px] text-slate-300 whitespace-pre-wrap", preview ?? ""));
  return card;
}

/**
 * 모순 하나.
 *
 * @param {Object} conflict - /memory/conflicts 항목
 * @param {(row: HTMLElement, conflict: Object, decision: string, reason: string) => void} onResolve
 * @returns {HTMLElement}
 */
export function renderConflictItem(conflict, onResolve) {
  const row = el("div", "glass-panel p-4 space-y-3");
  row.dataset.conflictId = String(conflict.id);
  row.appendChild(el("div", "text-[10px] font-mono text-slate-500", `모순 #${conflict.id} · ${fmtDate(conflict.created_at)}`));

  const pair = el("div", "flex flex-col md:flex-row gap-3");
  pair.appendChild(sideCard("왼쪽", conflict.left_id, conflict.left_topic, conflict.left_preview, conflict.left_valid_to, conflict.left_anchor));
  pair.appendChild(sideCard("오른쪽", conflict.right_id, conflict.right_topic, conflict.right_preview, conflict.right_valid_to, conflict.right_anchor));
  row.appendChild(pair);

  if (conflict.decision) {
    const label = CONFLICT_DECISIONS.find(d => d.value === conflict.decision)?.label ?? conflict.decision;
    row.appendChild(el("div", "text-[11px] text-slate-400",
      `해소됨: ${label} · ${fmtDate(conflict.resolved_at)}${conflict.reason ? " · " + conflict.reason : ""}`));
    return row;
  }

  const actions = el("div", "flex flex-wrap items-center gap-2");
  const reason  = el("input", INPUT_CLASS + " flex-1");
  reason.type        = "text";
  reason.maxLength   = 500;
  reason.placeholder = "해소 사유(선택)";
  actions.appendChild(reason);
  for (const d of CONFLICT_DECISIONS) {
    const btn = el("button", d.value === "defer" ? "btn" : "btn btn-primary", d.label);
    btn.dataset.decision = d.value;
    if (decisionBlocked(conflict, d.value)) {
      btn.disabled = true;
      btn.title    = "만료될 쪽이 앵커 파편이라 고를 수 없습니다";
    }
    btn.addEventListener("click", () => onResolve(row, conflict, d.value, reason.value));
    actions.appendChild(btn);
  }
  row.appendChild(actions);
  return row;
}

/**
 * 모순 처리 화면.
 *
 * @param {HTMLElement} container
 */
export async function renderConflicts(container) {
  const ctx = beginRender();
  syncRoute();
  container.textContent = "";

  const header = el("div", "flex justify-between items-end mb-6");
  const left   = el("div", "");
  left.appendChild(el("h2", "text-2xl font-headline font-bold text-on-surface tracking-tight", "모순 처리"));
  left.appendChild(el("p", "text-sm text-slate-400 mt-1", "같은 키에서 서로 모순으로 표시된 파편 쌍입니다. 남길 쪽을 고르면 다른 쪽은 만료됩니다."));
  header.appendChild(left);

  const toggle = el("div", "flex gap-2");
  for (const [value, label] of [["open", "미해결"], ["all", "전체 (최근 100건)"]]) {
    const btn = el("button", state.conflictStatus === value ? "btn btn-primary" : "btn", label);
    btn.addEventListener("click", () => {
      state.conflictStatus = value;
      renderConflicts(container);
    });
    toggle.appendChild(btn);
  }
  header.appendChild(toggle);
  container.appendChild(header);

  const list = el("div", "space-y-3");
  list.appendChild(loadingHtml());
  container.appendChild(list);

  async function resolve(row, conflict, decision, reason) {
    row.querySelectorAll("button[data-decision]").forEach(b => { b.disabled = true; });
    const body = { decision };
    if (reason.trim()) body.reason = reason.trim();
    const res = await api(`/memory/conflicts/${encodeURIComponent(conflict.id)}/resolve`, { method: "POST", body });
    if (res.ok) {
      showToast(res.data?.replayed ? "이미 해소된 모순입니다" : "해소했습니다", "success");
      if (state.conflictStatus === "open") row.remove();
      else renderConflicts(container);
      return;
    }
    row.querySelectorAll("button[data-decision]").forEach(b => { b.disabled = decisionBlocked(conflict, b.dataset.decision); });
    showToast(`해소 실패 (${res.status}${res.data?.error ? ": " + res.data.error : ""})`, "error");
  }

  const query = new URLSearchParams(state.conflictStatus === "open" ? { status: "open" } : {});
  const res   = await api("/memory/conflicts?" + query, { signal: ctx.signal });
  if (!ctx.isCurrent()) return;
  list.textContent = "";
  if (!res.ok) {
    list.appendChild(el("div", "glass-panel p-4 text-xs text-error", `모순 조회 실패 (${res.status || res.error})`));
    return;
  }
  const conflicts = res.data?.conflicts ?? [];
  if (conflicts.length === 0) {
    list.appendChild(el("div", "text-xs text-slate-500", state.conflictStatus === "open" ? "미해결 모순이 없습니다." : "모순 기록이 없습니다."));
    return;
  }
  for (const c of conflicts) list.appendChild(renderConflictItem(c, resolve));
}
