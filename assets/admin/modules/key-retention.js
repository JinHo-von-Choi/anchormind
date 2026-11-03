/**
 * Memento MCP Admin Console — 키 보존 정책 카드
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * 키 인스펙터에 이 키의 보존 정책(키 전체 또는 workspace 하나, 최대 보존 일수)을 보여 주고 넣거나 지운다.
 * 정리 주기가 created_at이 이 일수보다 오래된 파편을 지운다(앵커 제외). 자료는 GET/PUT /keys/:id/retention이다.
 */

import { api }       from "./api.js";
import { showToast } from "./ui.js";

/**
 * 정책 한 줄의 글.
 *
 * @param {{ workspace: string|null, max_age_days: number }} p
 * @returns {string}
 */
export function retentionLabel(p) {
  return `${p.workspace ?? "All workspaces"}: delete after ${p.max_age_days} days`;
}

/**
 * 입력 "workspace=days" 또는 "days"(키 전체)를 읽는다. "*"는 키 전체다. 일수를 비우면("workspace=", "*=") 지우기다.
 * 취소는 undefined, 형식이 틀리면 null.
 *
 * @param {string|null|undefined} text
 * @returns {{ workspace: string|null, max_age_days: number|null }|null|undefined}
 */
export function parseRetentionInput(text) {
  if (text === null || text === undefined) return undefined;
  const raw = String(text).trim();
  const eq  = raw.lastIndexOf("=");
  const ws  = eq >= 0 ? raw.slice(0, eq).trim() : "";
  const val = (eq >= 0 ? raw.slice(eq + 1) : raw).trim();
  const workspace = ws === "" || ws === "*" ? null : ws;
  if (val === "") return eq >= 0 ? { workspace, max_age_days: null } : null;
  if (!/^\d+$/.test(val) || Number(val) < 1 || Number(val) > 36500) return null;
  return { workspace, max_age_days: Number(val) };
}

/**
 * 보존 정책 카드. 목록은 카드를 붙인 뒤 비동기로 읽는다.
 *
 * @param {object} key
 * @param {{ load?: Function, save?: Function, ask?: Function }} [deps]
 * @returns {HTMLElement}
 */
export function renderKeyRetentionCard(key, {
  load = (id) => api(`/keys/${id}/retention`),
  save = (id, body) => api(`/keys/${id}/retention`, { method: "PUT", body }),
  ask  = (message, current) => globalThis.prompt?.(message, current)
} = {}) {
  const card = document.createElement("div");
  card.className = "bg-surface-container-highest p-4 rounded-sm border-l-2 border-outline space-y-1";
  card.id = "key-retention-card";

  const title = document.createElement("h4");
  title.className = "text-[10px] font-bold text-slate-400 tracking-widest uppercase font-label";
  title.textContent = "RETENTION";
  card.appendChild(title);

  const list = document.createElement("div");
  list.className = "space-y-1";
  card.appendChild(list);

  const show = (policies) => {
    list.textContent = "";
    const rows = policies.length ? policies.map(retentionLabel) : ["No retention policy (global TTL rules only)"];
    for (const text of rows) {
      const p = document.createElement("p");
      p.className = "text-[10px] text-slate-400";
      p.textContent = text;
      list.appendChild(p);
    }
  };
  const refresh = () => Promise.resolve(load(key.id)).then((res) => {
    if (res?.ok) show(res.data?.policies ?? []);
    else show([]);
  });

  const editBtn = document.createElement("button");
  editBtn.className = "text-[9px] text-primary font-bold uppercase hover:underline";
  editBtn.id = "key-retention-edit";
  editBtn.textContent = "Set Policy";
  editBtn.addEventListener("click", async () => {
    const input = parseRetentionInput(ask(
      "Retention: 'days' for all workspaces, 'workspace=days' for one workspace, 'workspace=' or '*=' to remove (fragments older than days are deleted, anchors kept)", ""
    ));
    if (input === undefined) return;
    if (input === null) { showToast("Enter days (1-36500), workspace=days, or workspace=", "warning"); return; }
    const res = await save(key.id, input);
    if (res?.ok) { showToast("Retention policy updated", "success"); await refresh(); }
    else showToast(res?.data?.error ?? "Update failed", "error");
  });
  card.appendChild(editBtn);

  card.ready = refresh().catch(() => show([]));
  return card;
}
