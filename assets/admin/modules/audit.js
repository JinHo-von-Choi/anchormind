/**
 * Memento MCP Admin Console — 감사 로그 뷰
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * admin_audit_events를 조회 조건(행위, 행위자, 대상, 결과, 기간)으로 최근 순으로 보여 준다.
 * 이어 보기는 seq 커서(nextBefore)로 한 쪽씩 붙인다. 같은 조건의 JSONL 내보내기와 체인 검증을 부른다.
 * 서버 값은 모두 textContent로만 넣는다.
 */

import { state }               from "./state.js";
import { api, API_BASE }       from "./api.js";
import { fmtDate, loadingHtml } from "./format.js";
import { showToast }           from "./ui.js";

/** 조회 조건 입력 칸과 서버 질의 매개변수 이름 */
export const AUDIT_FILTER_FIELDS = Object.freeze([
  { key: "action",      label: "ACTION",      placeholder: "admin.* 또는 memory.remember" },
  { key: "actor",       label: "ACTOR",       placeholder: "master 또는 키 id" },
  { key: "target_type", label: "TARGET TYPE", placeholder: "api_key, fragment ..." },
  { key: "target_id",   label: "TARGET ID",   placeholder: "" },
  { key: "outcome",     label: "OUTCOME",     placeholder: "success, failure, denied" },
  { key: "from",        label: "FROM",        placeholder: "2026-10-01" },
  { key: "to",          label: "TO",          placeholder: "2026-10-04" }
]);

export const AUDIT_PAGE_SIZE = 50;
const DETAIL_SUMMARY_MAX     = 140;

/**
 * 조회 조건을 질의 문자열로 바꾼다. 빈 값은 넣지 않는다.
 *
 * @param {Record<string, string>} filter
 * @param {{ before?: number|null, limit?: number|null }} [page]
 * @returns {string}
 */
export function buildAuditQuery(filter, { before = null, limit = AUDIT_PAGE_SIZE } = {}) {
  const params = new URLSearchParams();
  for (const { key } of AUDIT_FILTER_FIELDS) {
    const value = String(filter?.[key] ?? "").trim();
    if (value) params.set(key, value);
  }
  if (before !== null && before !== undefined) params.set("before", String(before));
  if (limit !== null && limit !== undefined) params.set("limit", String(limit));
  return params.toString();
}

/**
 * 행위자 표기. 키는 앞 8자만 보인다.
 *
 * @param {{ actorKind: string, actorKeyId?: string|null }} event
 * @returns {string}
 */
export function actorLabel(event) {
  if (event.actorKind === "key") return `key:${String(event.actorKeyId ?? "").slice(0, 8)}`;
  return event.actorKind;
}

/**
 * 대상 표기.
 *
 * @param {{ targetType?: string|null, targetId?: string|null }} event
 * @returns {string}
 */
export function targetLabel(event) {
  if (!event.targetType) return "-";
  return event.targetId ? `${event.targetType}:${event.targetId}` : event.targetType;
}

/**
 * detail 한 줄 요약. 객체와 배열은 JSON으로 적고 길면 자른다.
 *
 * @param {object|null} detail
 * @returns {string}
 */
export function detailSummary(detail) {
  const parts = Object.entries(detail ?? {}).map(([k, v]) => `${k}=${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`);
  const text  = parts.join(", ");
  return text.length > DETAIL_SUMMARY_MAX ? `${text.slice(0, DETAIL_SUMMARY_MAX)}...` : (text || "-");
}

/**
 * 체인 검증 결과 한 줄.
 *
 * @param {{ ok: boolean, checked: number, anchor?: string|null, complete?: boolean, broken?: { seq: number, reason: string }|null }} result
 * @returns {string}
 */
export function verifySummary(result) {
  if (!result) return "";
  if (!result.ok) return `체인 끊김: seq ${result.broken.seq} (${result.broken.reason}), 앞의 ${result.checked}행 확인`;
  if (result.checked === 0) return "확인할 행이 없다";
  const tail = result.complete === false ? ", 상한에서 멈춤" : "";
  return `체인 온전: ${result.checked}행 확인, 기준점 ${result.anchor}${tail}`;
}

/** 단추 하나 */
function button(id, icon, label, onClick) {
  const btn = document.createElement("button");
  btn.id        = id;
  btn.className = "btn px-3 py-1.5 flex items-center gap-1 text-xs";
  const i = document.createElement("span");
  i.className   = "material-symbols-outlined text-sm";
  i.textContent = icon;
  btn.appendChild(i);
  btn.appendChild(document.createTextNode(label));
  btn.addEventListener("click", onClick);
  return btn;
}

/** 조회 조건 입력 줄 */
function renderFilterBar(onApply) {
  const bar = document.createElement("div");
  bar.className = "flex flex-wrap items-end gap-3 bg-surface-container-low p-3 rounded-sm border-l-2 border-primary/40 mb-4";
  for (const field of AUDIT_FILTER_FIELDS) {
    const wrap  = document.createElement("label");
    wrap.className = "flex flex-col gap-1 text-[10px] text-slate-500 tracking-widest";
    wrap.appendChild(document.createTextNode(field.label));
    const input = document.createElement("input");
    input.type        = "text";
    input.id          = `audit-filter-${field.key}`;
    input.placeholder = field.placeholder;
    input.value       = state.auditFilter[field.key] ?? "";
    input.className   = "bg-surface-container text-[11px] text-on-surface border border-white/10 rounded-sm px-2 py-1.5 outline-none";
    wrap.appendChild(input);
    bar.appendChild(wrap);
  }
  bar.appendChild(button("audit-apply-btn", "search", "APPLY", onApply));
  return bar;
}

/** 감사 행 표 */
function renderTable(events) {
  const panel = document.createElement("div");
  panel.className = "glass-panel rounded-sm overflow-x-auto";
  if (events.length === 0) {
    const empty = document.createElement("div");
    empty.className   = "text-center text-slate-500 text-sm py-16";
    empty.textContent = "감사 기록 없음";
    panel.appendChild(empty);
    return panel;
  }
  const table = document.createElement("table");
  table.className = "w-full text-[11px]";
  const head = document.createElement("tr");
  for (const title of ["SEQ", "TIME", "ACTION", "OUTCOME", "ACTOR", "TARGET", "DETAIL"]) {
    const th = document.createElement("th");
    th.className   = "text-left px-3 py-2 text-slate-500 tracking-widest";
    th.textContent = title;
    head.appendChild(th);
  }
  table.appendChild(head);
  for (const event of events) {
    const row = document.createElement("tr");
    row.className = "border-t border-white/5";
    for (const value of [String(event.seq), fmtDate(event.occurredAt), event.action, event.outcome,
      actorLabel(event), targetLabel(event), detailSummary(event.detail)]) {
      const td = document.createElement("td");
      td.className   = "px-3 py-1.5 align-top text-on-surface";
      td.textContent = value;
      row.appendChild(td);
    }
    table.appendChild(row);
  }
  panel.appendChild(table);
  return panel;
}

/** 입력 칸 값으로 조회 조건을 갱신한다. */
function readFilterInputs() {
  const next = {};
  for (const { key } of AUDIT_FILTER_FIELDS) next[key] = document.getElementById(`audit-filter-${key}`)?.value ?? "";
  state.auditFilter = next;
}

/** 현재 조건의 JSONL을 내려받는다(Bearer 헤더 필요). */
async function downloadAuditExport() {
  try {
    const query = buildAuditQuery(state.auditFilter, { limit: null });
    const resp  = await fetch(`${API_BASE}/audit/export?format=jsonl${query ? `&${query}` : ""}`, {
      headers: { "Authorization": `Bearer ${state.masterKey}` }
    });
    if (!resp.ok) {
      showToast(`EXPORT 실패 (${resp.status})`, "error");
      return;
    }
    const url = URL.createObjectURL(await resp.blob());
    const a   = document.createElement("a");
    a.href     = url;
    a.download = "audit-events.jsonl";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("EXPORT 완료", "info");
  } catch (err) {
    showToast(`EXPORT 실패: ${err.message}`, "error");
  }
}

/**
 * 감사 로그 뷰를 그린다.
 *
 * @param {HTMLElement} container
 * @param {{ append?: boolean }} [options] append: 다음 쪽을 이어 붙인다
 */
export async function renderAudit(container, { append = false } = {}) {
  if (!append) {
    container.textContent = "";
    container.appendChild(loadingHtml());
  }
  const before = append ? state.auditNextBefore : null;
  const res    = await api(`/audit?${buildAuditQuery(state.auditFilter, { before })}`);
  if (res.ok) {
    state.auditEvents     = append ? [...state.auditEvents, ...(res.data?.events ?? [])] : (res.data?.events ?? []);
    state.auditNextBefore = res.data?.nextBefore ?? null;
  } else {
    if (!append) state.auditEvents = [];
    showToast(`감사 조회 실패 (${res.status}${res.data?.field ? `, ${res.data.field}` : ""})`, "error");
  }

  container.textContent = "";
  const header = document.createElement("div");
  header.className = "flex justify-between items-end mb-6";
  const left = document.createElement("div");
  const h2   = document.createElement("h2");
  h2.className   = "text-2xl font-headline font-bold text-on-surface tracking-tight";
  h2.textContent = "Audit Log";
  left.appendChild(h2);
  const sub = document.createElement("p");
  sub.className   = "text-sm text-slate-400 mt-1";
  sub.textContent = "관리 변경, 기억 쓰기, 앵커, 관문 차단의 해시 체인 기록";
  left.appendChild(sub);
  header.appendChild(left);

  const actions = document.createElement("div");
  actions.className = "flex gap-2";
  actions.appendChild(button("audit-refresh-btn", "refresh", "REFRESH", () => renderAudit(container)));
  actions.appendChild(button("audit-export-btn", "download", "EXPORT JSONL", () => downloadAuditExport()));
  actions.appendChild(button("audit-verify-btn", "verified", "VERIFY", async () => {
    const v = await api("/audit/verify", { method: "POST", body: {} });
    state.auditVerify = v.ok ? v.data : null;
    if (!v.ok) showToast(`검증 실패 (${v.status})`, "error");
    renderAudit(container);
  }));
  header.appendChild(actions);
  container.appendChild(header);

  if (state.auditVerify) {
    const banner = document.createElement("div");
    banner.id          = "audit-verify-result";
    banner.className   = `glass-panel p-3 mb-4 text-sm border-l-2 ${state.auditVerify.ok ? "border-primary" : "border-error"}`;
    banner.textContent = verifySummary(state.auditVerify);
    container.appendChild(banner);
  }

  container.appendChild(renderFilterBar(() => {
    readFilterInputs();
    renderAudit(container);
  }));
  container.appendChild(renderTable(state.auditEvents));

  if (state.auditNextBefore !== null) {
    const more = button("audit-more-btn", "expand_more", "MORE", () => renderAudit(container, { append: true }));
    more.className += " mt-4";
    container.appendChild(more);
  }
}
