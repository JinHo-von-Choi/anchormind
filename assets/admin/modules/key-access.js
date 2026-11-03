/**
 * Memento MCP Admin Console — 키 그룹 접근 카드
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * 키 인스펙터에 이 키가 그룹으로 읽을 수 있는 다른 키(받은 쓰기 권한, 공유 workspace 제한)와, 최근 며칠 동안
 * 다른 키의 recall 결과에 이 키의 파편이 들어간 기록을 보여 준다. 자료는 GET /keys/:id/access 한 번이다.
 */

import { api }              from "./api.js";
import { fmt, fmtDate }     from "./format.js";

/** 공유 읽기 기록을 모으는 기간(일). 관리 API는 1~90일을 받는다. */
export const KEY_ACCESS_DAYS = 7;

/**
 * 키 id를 이름으로 바꾼다. 목록에 없는 키(지워졌거나 다른 범위)는 id 앞 8자를 보여 준다.
 *
 * @param {string|null} id
 * @param {Map<string, string>} names
 * @returns {string}
 */
export function keyLabel(id, names) {
  if (id == null) return "master";
  return names.get(id) ?? `${String(id).slice(0, 8)}…`;
}

/**
 * 읽을 수 있는 키 한 줄의 설명. 받은 쓰기 권한과 공유 workspace 제한을 붙인다.
 *
 * @param {string} id
 * @param {{ groupGrants?: Record<string, string[]>, groupShareScopes?: Record<string, string[]> }} access
 * @returns {string}
 */
export function readableKeyDetail(id, access) {
  const grants = ["link", "amend", "forget"].filter((a) => (access.groupGrants?.[a] ?? []).includes(id));
  const scope  = access.groupShareScopes?.[id];
  const parts  = [grants.length ? `read + ${grants.join(", ")}` : "read"];
  parts.push(Array.isArray(scope) ? `workspaces: ${scope.length ? scope.join(", ") : "(none)"}` : "all workspaces");
  return parts.join(" · ");
}

function line(text, cls = "text-slate-400") {
  const p = document.createElement("p");
  p.className = `text-[10px] ${cls}`;
  p.textContent = text;
  return p;
}

function subTitle(text) {
  const h = document.createElement("div");
  h.className = "text-[10px] font-bold text-slate-500 uppercase tracking-wider mt-2";
  h.textContent = text;
  return h;
}

/**
 * 접근 자료로 카드 본문을 채운다.
 *
 * @param {HTMLElement} body
 * @param {object} access GET /keys/:id/access 응답
 * @param {Map<string, string>} names 키 id → 이름
 */
export function fillKeyAccess(body, access, names) {
  body.textContent = "";

  body.appendChild(subTitle("CAN READ"));
  const readable = access.readableKeyIds ?? [];
  if (readable.length === 0) body.appendChild(line("Only its own fragments (no group access)"));
  for (const id of readable) {
    const row = document.createElement("div");
    row.className = "flex justify-between gap-2";
    const name = document.createElement("span");
    name.className = "text-xs text-on-surface";
    name.textContent = keyLabel(id, names);
    const detail = document.createElement("span");
    detail.className = "text-[10px] text-slate-400 text-right";
    detail.textContent = readableKeyDetail(id, access);
    row.appendChild(name);
    row.appendChild(detail);
    body.appendChild(row);
  }

  body.appendChild(subTitle(`READ BY OTHER KEYS (LAST ${access.days ?? KEY_ACCESS_DAYS} DAYS)`));
  const reads = access.sharedReads ?? [];
  if (reads.length === 0) body.appendChild(line("No recall by other keys returned this key's fragments"));
  for (const r of reads) {
    const row = document.createElement("div");
    row.className = "flex justify-between gap-2";
    const name = document.createElement("span");
    name.className = "text-xs text-on-surface";
    name.textContent = r.reader_key_id == null ? "master" : (r.reader_name ?? keyLabel(r.reader_key_id, names));
    const detail = document.createElement("span");
    detail.className = "text-[10px] text-slate-400 text-right";
    detail.textContent = `${fmt(r.searches)} recalls · ${fmt(r.fragments)} fragments · last ${fmtDate(r.last_at)}`;
    row.appendChild(name);
    row.appendChild(detail);
    body.appendChild(row);
  }
}

/**
 * 그룹 접근 카드. 자료는 카드를 붙인 뒤 비동기로 읽는다.
 *
 * @param {object} key
 * @param {Array<{ id: string, name: string }>} keys 이름 표시에 쓸 키 목록
 * @param {{ load?: (id: string) => Promise<{ ok: boolean, data?: object }> }} [deps]
 * @returns {HTMLElement}
 */
export function renderKeyAccessCard(key, keys, { load = (id) => api(`/keys/${id}/access?days=${KEY_ACCESS_DAYS}`) } = {}) {
  const card = document.createElement("div");
  card.className = "bg-surface-container-highest p-4 rounded-sm border-l-2 border-secondary space-y-1";
  card.id = "key-access-card";

  const title = document.createElement("h4");
  title.className = "text-[10px] font-bold text-slate-400 tracking-widest uppercase font-label";
  title.textContent = "GROUP ACCESS";
  card.appendChild(title);

  const body = document.createElement("div");
  body.className = "space-y-1";
  body.appendChild(line("Loading…"));
  card.appendChild(body);

  const names = new Map((keys ?? []).map((k) => [k.id, k.name]));
  card.ready = Promise.resolve(load(key.id)).then((res) => {
    if (res?.ok) fillKeyAccess(body, res.data ?? {}, names);
    else { body.textContent = ""; body.appendChild(line(res?.data?.error ?? "Could not load group access", "text-error")); }
  }).catch(() => {
    body.textContent = "";
    body.appendChild(line("Could not load group access", "text-error"));
  });
  return card;
}
