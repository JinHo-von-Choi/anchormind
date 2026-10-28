/**
 * Memento MCP Admin Console — 검토 대기 화면
 *
 * 작성자: 최진호
 * 작성일: 2026-10-28
 *
 * 검토 관문에 걸린 파편을 오래된 순으로 보여 주고 승인 또는 거절한다. 결정하지 않은 파편은 만든 지
 * 30일이 지나면 자동으로 거절된다. 결정 요청에는 파편마다 멱등 키를 하나 붙여, 같은 단추를 다시 눌러도
 * 결정이 두 번 기록되지 않는다.
 */

import { state, beginRender, syncRoute } from "./state.js";
import { api }                           from "./api.js";
import { showToast }                     from "./ui.js";
import { fmtDate, truncate, loadingHtml } from "./format.js";

/** 한 번에 불러오는 검토 대기 수 */
export const REVIEW_PAGE_SIZE = 50;

/** 검토 사유 코드 → 화면 문구 */
const REASON_LABELS = {
  instruction_override: "지시 덮어쓰기 문구",
  low_trust_directive:  "낮은 신뢰 출처의 지시성 파편",
  anchor_unauthorized:  "권한 없는 앵커 요청",
  anchor_requested:     "앵커 지정 요청",
  mode_all:             "키 설정: 전부 검토"
};

/** 파편 id → 결정 멱등 키 */
const idempotencyKeys = new Map();

/**
 * 파편 하나의 결정 멱등 키. 같은 파편에는 같은 값을 돌려준다.
 *
 * @param {string} fragmentId
 * @returns {string}
 */
export function reviewIdempotencyKey(fragmentId) {
  if (!idempotencyKeys.has(fragmentId)) {
    const rand = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    idempotencyKeys.set(fragmentId, `review-${rand}`);
  }
  return idempotencyKeys.get(fragmentId);
}

/**
 * 검토 사유 문구.
 *
 * @param {string[]} reasons
 * @returns {string}
 */
export function reviewReasonLabel(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) return "-";
  return reasons.map(r => REASON_LABELS[r] ?? r).join(", ");
}

/**
 * 자동 거절까지 남은 일수 문구.
 *
 * @param {string} autoRejectAt
 * @param {number} [now]
 * @returns {string}
 */
export function autoRejectLabel(autoRejectAt, now = Date.now()) {
  if (!autoRejectAt) return "-";
  const days = Math.ceil((new Date(autoRejectAt).getTime() - now) / 86400000);
  return days <= 0 ? "오늘 자동 거절" : `${days}일 뒤 자동 거절`;
}

/** 검토 대상 키 조건과 주소 질의를 서로 옮긴다. */
export const reviewRoute = {
  fromQuery(query) { state.reviewKeyId = query.get("key_id") ?? ""; },
  toQuery()        { return { key_id: state.reviewKeyId }; }
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 결정 요청 본문.
 *
 * @param {string} fragmentId
 * @param {{ note?: string, applyAnchor?: boolean }} options
 * @returns {Object}
 */
export function reviewDecisionBody(fragmentId, { note = "", applyAnchor = false } = {}) {
  const body = { idempotencyKey: reviewIdempotencyKey(fragmentId), applyAnchor: applyAnchor === true };
  const trimmed = String(note ?? "").trim();
  if (trimmed) body.note = trimmed.slice(0, 500);
  return body;
}

/**
 * 검토 대기 행 하나.
 *
 * @param {Object} item
 * @param {(row: HTMLElement, item: Object, decision: "approve"|"reject", options: Object) => void} onDecide
 * @returns {HTMLElement}
 */
export function renderReviewItem(item, onDecide) {
  const row = el("div", "glass-panel p-4 space-y-2");
  row.dataset.reviewId = item.id;

  const head = el("div", "flex flex-wrap justify-between gap-2 text-[10px] font-mono text-slate-400");
  head.appendChild(el("span", "", `${item.type ?? "-"} · ${item.topic ?? "-"} · ${item.key_name ?? item.key_id ?? "master"}${item.workspace ? " · " + item.workspace : ""}`));
  head.appendChild(el("span", "", `${fmtDate(item.created_at)} · ${autoRejectLabel(item.auto_reject_at)}`));
  row.appendChild(head);

  row.appendChild(el("div", "text-[11px] text-slate-300 whitespace-pre-wrap", truncate(item.content_preview ?? "", 500)));
  row.appendChild(el("div", "text-[10px] text-slate-500",
    `사유: ${reviewReasonLabel(item.review_reasons)} · 출처 ${item.origin ?? "-"} · 신뢰 등급 ${item.trust_tier ?? "-"}`));

  const actions = el("div", "flex flex-wrap items-center gap-2");
  const note = el("input", "form-input flex-1 text-xs");
  note.type        = "text";
  note.maxLength   = 500;
  note.placeholder = "결정 메모(선택)";
  actions.appendChild(note);

  let anchorCb = null;
  if ((item.review_reasons ?? []).includes("anchor_unauthorized")) {
    const label = el("label", "flex items-center gap-1 text-[10px] text-slate-400");
    anchorCb = el("input", "accent-primary");
    anchorCb.type = "checkbox";
    label.appendChild(anchorCb);
    label.appendChild(document.createTextNode("승인하면서 앵커 적용"));
    actions.appendChild(label);
  }

  const approve = el("button", "btn btn-primary", "승인");
  approve.dataset.reviewAction = "approve";
  approve.addEventListener("click", () => onDecide(row, item, "approve", { note: note.value, applyAnchor: anchorCb?.checked === true }));
  const reject = el("button", "btn", "거절");
  reject.dataset.reviewAction = "reject";
  reject.addEventListener("click", () => onDecide(row, item, "reject", { note: note.value }));
  actions.appendChild(approve);
  actions.appendChild(reject);
  row.appendChild(actions);
  return row;
}

/**
 * 결정 결과 문구.
 *
 * @param {"approve"|"reject"} decision
 * @param {Object} data - 결정 응답
 * @returns {string}
 */
export function decisionMessage(decision, data) {
  const base = decision === "approve" ? "승인했습니다" : "거절했습니다";
  if (data?.replayed) return `${base} (이미 처리된 요청)`;
  if (decision === "approve" && data?.anchorApplied) return `${base} · 앵커 적용`;
  return base;
}

/**
 * 검토 대기 화면.
 *
 * @param {HTMLElement} container
 */
export async function renderReview(container) {
  const ctx = beginRender();
  syncRoute();
  container.textContent = "";

  const header = el("div", "flex justify-between items-end mb-6");
  const left   = el("div", "");
  left.appendChild(el("h2", "text-2xl font-headline font-bold text-on-surface tracking-tight", "검토 대기"));
  left.appendChild(el("p", "text-sm text-slate-400 mt-1", "검토 관문에 걸린 파편입니다. 만든 지 30일이 지나면 자동으로 거절됩니다."));
  header.appendChild(left);

  const filters = el("div", "flex gap-2 items-center");
  const keyInput = el("input", "form-input text-xs w-56");
  keyInput.type        = "text";
  keyInput.id          = "review-key-id";
  keyInput.placeholder = "키 id (master = 마스터 키)";
  keyInput.value       = state.reviewKeyId;
  const apply = el("button", "btn", "조회");
  apply.addEventListener("click", () => {
    state.reviewKeyId = keyInput.value.trim();
    renderReview(container);
  });
  keyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") apply.click(); });
  filters.appendChild(keyInput);
  filters.appendChild(apply);
  header.appendChild(filters);
  container.appendChild(header);

  const countLine = el("div", "text-xs text-slate-500 mb-3", "");
  container.appendChild(countLine);
  const list = el("div", "space-y-3");
  list.appendChild(loadingHtml());
  container.appendChild(list);
  const moreSlot = el("div", "mt-4");
  container.appendChild(moreSlot);

  let shown = 0;

  async function decide(row, item, decision, options) {
    row.querySelectorAll("button").forEach(b => { b.disabled = true; });
    const res = await api(`/review/${encodeURIComponent(item.id)}/${decision}`, {
      method: "POST",
      body  : reviewDecisionBody(item.id, options)
    });
    if (res.ok) {
      showToast(decisionMessage(decision, res.data), "success");
      idempotencyKeys.delete(item.id);
      row.remove();
      shown -= 1;
      countLine.textContent = `표시 중 ${shown}건`;
      return;
    }
    row.querySelectorAll("button").forEach(b => { b.disabled = false; });
    if (res.status === 409 && res.data?.state) {
      showToast(`이미 ${res.data.state} 상태입니다`, "warning");
      row.remove();
      return;
    }
    showToast(`결정 실패 (${res.status}${res.data?.error ? ": " + res.data.error : ""})`, "error");
  }

  async function loadPage(cursor) {
    const params = new URLSearchParams({ limit: String(REVIEW_PAGE_SIZE) });
    if (state.reviewKeyId) params.set("key_id", state.reviewKeyId);
    if (cursor) params.set("cursor", cursor);
    const res = await api(`/review?${params}`, { signal: ctx.signal });
    if (!ctx.isCurrent()) return;
    if (!cursor) list.textContent = "";
    moreSlot.textContent = "";
    if (!res.ok) {
      list.appendChild(el("div", "glass-panel p-4 text-xs text-error",
        `검토 대기 조회 실패 (${res.status}${res.data?.field ? ", " + res.data.field : ""})`));
      return;
    }
    const items = res.data?.items ?? [];
    for (const item of items) list.appendChild(renderReviewItem(item, decide));
    shown += items.length;
    countLine.textContent = shown === 0 ? "검토 대기 파편이 없습니다." : `표시 중 ${shown}건`;
    if (res.data?.nextCursor && items.length === REVIEW_PAGE_SIZE) {
      const more = el("button", "btn", "더 보기");
      more.addEventListener("click", () => {
        more.disabled = true;
        loadPage(res.data.nextCursor);
      });
      moreSlot.appendChild(more);
    }
  }

  await loadPage(null);
}
