/**
 * Memento MCP Admin Console — 검색 진단 화면
 *
 * 작성자: 최진호
 * 작성일: 2026-10-28
 *
 * 세 가지를 한 화면에서 한다.
 *   1. 키 범위 검색: 지정한 키로 recall했을 때 무엇이 나오는지 확인한다(POST /search, 감사 기록이 남는다).
 *   2. 검색 이벤트: 기록된 검색 하나를 열어 경로와 선택 근거를 보고, 지금 상태로 다시 확인하거나 피드백을 남긴다.
 *      재실행은 부작용 없는 스냅샷 비교다.
 *   3. 시점 조회: 지정한 시각에 유효했던 파편을 중요도 순으로 최대 200개 본다.
 */

import { state, beginRender, syncRoute } from "./state.js";
import { api }                           from "./api.js";
import { showToast }                     from "./ui.js";
import { fmt, fmtDate, truncate, loadingHtml } from "./format.js";

/** 검색 이벤트 id와 주소 질의를 서로 옮긴다. */
export const searchLabRoute = {
  fromQuery(query) {
    const id = query.get("event");
    state.searchLabEventId = id && /^\d+$/.test(id) ? id : "";
  },
  toQuery() { return { event: state.searchLabEventId ?? "" }; }
};

/**
 * 쉼표로 나눈 입력을 배열로 바꾼다.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitList(text) {
  return String(text ?? "").split(",").map(v => v.trim()).filter(Boolean);
}

/**
 * 키 범위 검색 요청 본문. 비어 있는 항목은 뺀다.
 *
 * @param {{ keyIds: string, keywords: string, text: string, type: string, topic: string, pageSize: string|number }} form
 * @returns {Object}
 */
export function buildSearchBody(form) {
  const body = {};
  const keyIds   = splitList(form.keyIds);
  const keywords = splitList(form.keywords);
  if (keyIds.length)   body.key_ids  = keyIds;
  if (keywords.length) body.keywords = keywords;
  if (String(form.text ?? "").trim())  body.text  = form.text.trim();
  if (String(form.type ?? "").trim())  body.type  = form.type.trim();
  if (String(form.topic ?? "").trim()) body.topic = form.topic.trim();
  const size = parseInt(form.pageSize, 10);
  if (Number.isInteger(size) && size > 0) body.pageSize = Math.min(size, 50);
  return body;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function field(placeholder, id, className = "form-input text-xs") {
  const input = el("input", className);
  input.type        = "text";
  input.id          = id;
  input.placeholder = placeholder;
  return input;
}

function section(title, subtitle) {
  const panel = el("section", "glass-panel p-5 space-y-3");
  panel.appendChild(el("h3", "text-[11px] font-bold font-headline tracking-widest text-slate-300 uppercase", title));
  if (subtitle) panel.appendChild(el("p", "text-[11px] text-slate-500", subtitle));
  return panel;
}

function fragmentRows(fragments, reasonsOf = () => null) {
  const list = el("div", "space-y-2");
  if (!fragments.length) {
    list.appendChild(el("div", "text-xs text-slate-500", "결과 없음"));
    return list;
  }
  for (const f of fragments) {
    const row = el("div", "text-[11px] border-l border-white/10 pl-2");
    const reasons = reasonsOf(f);
    row.appendChild(el("div", "font-mono text-slate-400",
      [f.id, f.type, f.topic, f.importance != null ? `중요도 ${Number(f.importance).toFixed(2)}` : null, reasons].filter(Boolean).join(" · ")));
    if (f.content) row.appendChild(el("div", "text-slate-300 whitespace-pre-wrap", truncate(f.content, 300)));
    list.appendChild(row);
  }
  return list;
}

/**
 * 검색 이벤트 상세.
 *
 * @param {Object} event - /search-events/:id 의 event
 * @returns {HTMLElement}
 */
export function renderSearchEvent(event) {
  const wrap = el("div", "space-y-1 text-[11px]");
  wrap.id = "search-event-detail";
  const rows = [
    ["이벤트", `#${event.id} · ${fmtDate(event.created_at)}`],
    ["경로", event.search_path ?? "-"],
    ["질의 유형", event.query_type ?? "-"],
    ["결과", `${fmt(event.result_count ?? 0)}건 (후보 ${fmt(event.candidate_count ?? 0)} · 예산 안 ${fmt(event.budget_kept ?? 0)})`],
    ["지연", `${fmt(event.latency_ms ?? 0)}ms`],
    ["필터", (event.filter_keys ?? []).join(", ") || "-"],
    ["키", event.key_id ?? "master"]
  ];
  for (const [k, v] of rows) {
    const row = el("div", "flex justify-between gap-4 border-b border-white/5 py-1");
    row.appendChild(el("span", "text-slate-500", k));
    row.appendChild(el("span", "font-mono text-slate-300 text-right break-all", String(v)));
    wrap.appendChild(row);
  }
  const selected = event.selected_fragment_ids ?? [];
  wrap.appendChild(el("div", "text-slate-500 mt-2", `선택된 파편 ${selected.length}개`));
  for (const id of selected) {
    const codes = event.selection_reasons?.[id]?.codes ?? [];
    wrap.appendChild(el("div", "font-mono text-slate-400", `${id}${codes.length ? " · " + codes.join(", ") : ""}`));
  }
  return wrap;
}

/**
 * 재실행 결과 문구.
 *
 * @param {Object} replay
 * @returns {string}
 */
export function replaySummary(replay) {
  if (!replay) return "-";
  if (replay.mode === "off") return `기록 당시 선택 ${replay.originalSelectedCount}개 (지금 상태 비교 안 함)`;
  return `기록 당시 선택 ${replay.originalSelectedCount}개 중 지금도 유효 ${replay.selected.length}개, 사라짐 ${replay.unavailableIds.length}개`;
}

/**
 * 검색 진단 화면.
 *
 * @param {HTMLElement} container
 */
export async function renderSearchLab(container) {
  const ctx = beginRender();
  syncRoute();
  container.textContent = "";

  const header = el("div", "mb-6");
  header.appendChild(el("h2", "text-2xl font-headline font-bold text-on-surface tracking-tight", "검색 진단"));
  header.appendChild(el("p", "text-sm text-slate-400 mt-1", "키 범위 검색, 기록된 검색 이벤트 확인, 특정 시점에 유효했던 파편 조회"));
  container.appendChild(header);

  const grid = el("div", "grid grid-cols-1 xl:grid-cols-2 gap-6");
  container.appendChild(grid);

  /* 1. 키 범위 검색 */
  const searchPanel = section("키 범위 검색", "지정한 키의 기억으로 recall합니다. 키를 비우면 전체 범위입니다. 호출마다 감사 기록이 남습니다.");
  const sForm = el("div", "grid grid-cols-2 gap-2");
  const sKeys     = field("키 id (쉼표로 여러 개)", "lab-key-ids");
  const sKeywords = field("키워드 (쉼표)", "lab-keywords");
  const sText     = field("자연어 질의", "lab-text");
  const sTopic    = field("topic", "lab-topic");
  const sType     = field("type", "lab-type");
  const sSize     = field("결과 수 (최대 50)", "lab-page-size");
  [sKeys, sKeywords, sText, sTopic, sType, sSize].forEach(i => sForm.appendChild(i));
  searchPanel.appendChild(sForm);
  const sBtn = el("button", "btn btn-primary", "검색");
  searchPanel.appendChild(sBtn);
  const sResult = el("div", "");
  searchPanel.appendChild(sResult);
  sBtn.addEventListener("click", async () => {
    const body = buildSearchBody({
      keyIds: sKeys.value, keywords: sKeywords.value, text: sText.value,
      type: sType.value, topic: sTopic.value, pageSize: sSize.value
    });
    if (!body.keywords && !body.text && !body.topic) {
      showToast("키워드, 자연어 질의, topic 중 하나는 필요합니다", "warning");
      return;
    }
    sBtn.disabled = true;
    sResult.textContent = "";
    sResult.appendChild(loadingHtml());
    const res = await api("/search", { method: "POST", body });
    sBtn.disabled = false;
    if (!ctx.isCurrent()) return;
    sResult.textContent = "";
    if (!res.ok) {
      sResult.appendChild(el("div", "text-xs text-error", `검색 실패 (${res.status || res.error})`));
      return;
    }
    const meta = el("div", "text-[11px] text-slate-400 mb-2",
      `${fmt(res.data.count)}건 / 전체 ${fmt(res.data.totalCount)}건 · 경로 ${res.data.searchPath ?? "-"}`);
    sResult.appendChild(meta);
    if (res.data.searchEventId) {
      const open = el("button", "btn text-[10px] mb-2", `이 검색 이벤트 열기 #${res.data.searchEventId}`);
      open.addEventListener("click", () => loadEvent(String(res.data.searchEventId)));
      sResult.appendChild(open);
    }
    sResult.appendChild(fragmentRows(res.data.fragments ?? []));
  });
  grid.appendChild(searchPanel);

  /* 2. 검색 이벤트 */
  const eventPanel = section("검색 이벤트", "이벤트 id로 열거나 아래 최근 결과 0건 검색에서 고릅니다.");
  const eRow = el("div", "flex gap-2");
  const eInput = field("이벤트 id", "lab-event-id", "form-input text-xs flex-1");
  eInput.value = state.searchLabEventId ?? "";
  const eBtn = el("button", "btn", "열기");
  eRow.appendChild(eInput);
  eRow.appendChild(eBtn);
  eventPanel.appendChild(eRow);
  const eDetail = el("div", "");
  eventPanel.appendChild(eDetail);
  const failedSlot = el("div", "space-y-1");
  eventPanel.appendChild(el("div", "text-[10px] text-slate-500 uppercase mt-3", "최근 결과 0건 검색"));
  eventPanel.appendChild(failedSlot);
  grid.appendChild(eventPanel);

  async function loadEvent(id) {
    if (!/^\d+$/.test(String(id))) {
      showToast("이벤트 id는 숫자입니다", "warning");
      return;
    }
    state.searchLabEventId = String(id);
    eInput.value = state.searchLabEventId;
    syncRoute();
    eDetail.textContent = "";
    eDetail.appendChild(loadingHtml());
    const res = await api(`/search-events/${id}`, { signal: ctx.signal });
    if (!ctx.isCurrent() || state.searchLabEventId !== String(id)) return;
    eDetail.textContent = "";
    if (!res.ok) {
      eDetail.appendChild(el("div", "text-xs text-error", res.status === 404 ? "없는 이벤트입니다" : `조회 실패 (${res.status || res.error})`));
      return;
    }
    eDetail.appendChild(renderSearchEvent(res.data.event));

    const actions = el("div", "flex flex-wrap gap-2 mt-3");
    const replayOut = el("div", "text-[11px] text-slate-300 mt-2");
    const replayBtn = el("button", "btn", "지금 상태로 확인");
    replayBtn.addEventListener("click", async () => {
      replayBtn.disabled = true;
      const r = await api(`/search-events/${id}/replay`, { method: "POST", body: { memory: "current" } });
      replayBtn.disabled = false;
      replayOut.textContent = "";
      if (!r.ok) {
        replayOut.textContent = `확인 실패 (${r.status})`;
        return;
      }
      replayOut.appendChild(el("div", "", replaySummary(r.data.replay)));
      replayOut.appendChild(fragmentRows(r.data.replay.selected ?? [], f => (f.reasons ?? []).join(", ") || null));
      if ((r.data.replay.unavailableIds ?? []).length) {
        replayOut.appendChild(el("div", "font-mono text-slate-500", `사라진 파편: ${r.data.replay.unavailableIds.join(", ")}`));
      }
    });
    actions.appendChild(replayBtn);
    for (const [label, relevant] of [["관련 있음", true], ["관련 없음", false]]) {
      const fb = el("button", "btn", `피드백: ${label}`);
      fb.addEventListener("click", async () => {
        fb.disabled = true;
        const r = await api(`/search-events/${id}/feedback`, { method: "POST", body: { relevant, sufficient: relevant } });
        fb.disabled = false;
        if (r.ok) showToast(r.data?.replayed ? "이미 피드백이 있는 이벤트입니다" : "피드백을 남겼습니다", "success");
        else showToast(`피드백 실패 (${r.status})`, "error");
      });
      actions.appendChild(fb);
    }
    eDetail.appendChild(actions);
    eDetail.appendChild(replayOut);
  }
  eBtn.addEventListener("click", () => loadEvent(eInput.value.trim()));
  eInput.addEventListener("keydown", (e) => { if (e.key === "Enter") eBtn.click(); });

  /* 3. 시점 조회 */
  const asOfPanel = section("시점 조회", "지정한 시각에 유효했던 파편을 중요도 순으로 최대 200개 보여 줍니다.");
  const aRow  = el("div", "flex flex-wrap gap-2");
  const aTime = el("input", "form-input text-xs");
  aTime.type = "datetime-local";
  aTime.id   = "lab-as-of";
  const aKeys = field("키 id (쉼표, 선택)", "lab-as-of-keys", "form-input text-xs flex-1");
  const aBtn  = el("button", "btn", "조회");
  aRow.appendChild(aTime);
  aRow.appendChild(aKeys);
  aRow.appendChild(aBtn);
  asOfPanel.appendChild(aRow);
  const aResult = el("div", "");
  asOfPanel.appendChild(aResult);
  aBtn.addEventListener("click", async () => {
    if (!aTime.value) {
      showToast("시각을 고르세요", "warning");
      return;
    }
    const asOf = new Date(aTime.value);
    if (Number.isNaN(asOf.getTime())) {
      showToast("시각 형식이 올바르지 않습니다", "warning");
      return;
    }
    const params = new URLSearchParams({ as_of: asOf.toISOString() });
    const keys = splitList(aKeys.value);
    if (keys.length) params.set("key_ids", keys.join(","));
    aBtn.disabled = true;
    aResult.textContent = "";
    aResult.appendChild(loadingHtml());
    const res = await api(`/memory/as-of?${params}`, { signal: ctx.signal });
    aBtn.disabled = false;
    if (!ctx.isCurrent()) return;
    aResult.textContent = "";
    if (!res.ok) {
      aResult.appendChild(el("div", "text-xs text-error", `조회 실패 (${res.status || res.error})`));
      return;
    }
    aResult.appendChild(el("div", "text-[11px] text-slate-400 mb-2", `${fmtDate(res.data.asOf)} 기준 ${fmt(res.data.fragments.length)}개`));
    aResult.appendChild(fragmentRows(res.data.fragments));
  });
  grid.appendChild(asOfPanel);

  if (state.searchLabEventId) loadEvent(state.searchLabEventId);

  failedSlot.appendChild(loadingHtml());
  const anomalies = await api("/memory/anomalies", { signal: ctx.signal });
  if (!ctx.isCurrent()) return;
  failedSlot.textContent = "";
  const failed = anomalies.ok ? (anomalies.data?.failedSearches ?? []) : [];
  if (!anomalies.ok) failedSlot.appendChild(el("div", "text-xs text-error", `조회 실패 (${anomalies.status || anomalies.error})`));
  else if (failed.length === 0) failedSlot.appendChild(el("div", "text-xs text-slate-500", "없음"));
  for (const ev of failed) {
    const btn = el("button", "block w-full text-left text-[11px] font-mono text-slate-400 hover:text-primary",
      `#${ev.id} · ${fmtDate(ev.created_at)} · ${ev.query_type ?? "-"} · ${(ev.filter_keys ?? []).join(",") || "필터 없음"} · ${fmt(ev.latency_ms ?? 0)}ms`);
    btn.addEventListener("click", () => loadEvent(String(ev.id)));
    failedSlot.appendChild(btn);
  }
}
