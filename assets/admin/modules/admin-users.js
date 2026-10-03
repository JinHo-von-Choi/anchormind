/**
 * Memento MCP Admin Console — 관리자 계정 화면
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 계정 목록(이름, 역할, 상태, TOTP, 마지막 로그인)과 생성, 역할 교체, 비활성화와 활성화, TOTP 초기화, 세션 폐기,
 * 삭제를 한다. 서버는 능력 admin_user.manage(owner 전용)를 요구한다. 계정이 0개이면 첫 owner를 부트스트랩으로
 * 만든다(마스터 키 로그인에서만). 서버 값은 textContent로만 넣는다.
 */

import { state }     from "./state.js";
import { api }       from "./api.js";
import { fmtDate }   from "./format.js";
import { showToast } from "./ui.js";

/**
 * 역할 입력("owner, viewer@team-a")을 바인딩 목록으로 바꾼다.
 *
 * @param {string} text
 * @returns {Array<{ role: string, workspace: string|null }>}
 */
export function parseRolesInput(text) {
  return String(text || "").split(",").map((s) => s.trim()).filter(Boolean).map((item) => {
    const at = item.indexOf("@");
    return at < 0 ? { role: item, workspace: null } : { role: item.slice(0, at).trim(), workspace: item.slice(at + 1).trim() || null };
  });
}

/**
 * 바인딩 목록의 표시 문자열.
 *
 * @param {Array<{ role: string, workspace: string|null }>} roles
 * @returns {string}
 */
export function rolesLabel(roles) {
  return (roles || []).map((b) => (b.workspace ? `${b.role}@${b.workspace}` : b.role)).join(", ");
}

/**
 * 오류 응답의 표시 문구.
 *
 * @param {{ status: number, data: any }} res
 * @returns {string}
 */
export function errorLabel(res) {
  const reason = res.data?.reason || res.data?.cap || res.data?.error || "error";
  return `${res.status} ${reason}${res.data?.field ? ` (${res.data.field})` : ""}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, handler) {
  const b = el("button", "btn", label);
  b.addEventListener("click", handler);
  return b;
}

function field(type, placeholder) {
  const i = el("input", "login-input");
  i.type = type;
  i.placeholder = placeholder;
  i.autocomplete = "off";
  return i;
}

/**
 * 요청 하나를 보내고 결과를 알린 뒤 화면을 다시 그린다.
 */
async function act(container, path, options, okMessage) {
  const res = await api(path, options);
  if (res.ok) showToast(okMessage, "success");
  else showToast(errorLabel(res), "error");
  await renderAdminUsers(container);
  return res;
}

/**
 * 계정 행의 동작 단추들.
 */
function rowActions(container, user) {
  const cell = el("td", "");
  const base = `/admin-users/${encodeURIComponent(user.id)}`;
  cell.appendChild(button("ROLES", () => {
    const next = globalThis.prompt?.("roles (예: owner, viewer@team-a)", rolesLabel(user.roles));
    if (next) act(container, `${base}/roles`, { method: "PUT", body: { roles: parseRolesInput(next) } }, "roles updated");
  }));
  const nextStatus = user.status === "active" ? "disabled" : "active";
  cell.appendChild(button(nextStatus === "disabled" ? "DISABLE" : "ENABLE",
    () => act(container, base, { method: "PATCH", body: { status: nextStatus } }, `status ${nextStatus}`)));
  cell.appendChild(button("RESET TOTP", () => act(container, `${base}/totp-reset`, { method: "POST" }, "totp reset")));
  cell.appendChild(button("REVOKE SESSIONS", () => act(container, `${base}/sessions`, { method: "DELETE" }, "sessions revoked")));
  cell.appendChild(button("DELETE", () => {
    if (globalThis.confirm?.(`delete ${user.username}?`)) act(container, base, { method: "DELETE" }, "deleted");
  }));
  return cell;
}

/**
 * 계정 표.
 */
function usersTable(container, users) {
  const table = el("table", "w-full text-xs");
  const head  = el("tr", "");
  for (const h of ["USERNAME", "ROLES", "STATUS", "TOTP", "LAST LOGIN", ""]) head.appendChild(el("th", "text-left", h));
  table.appendChild(head);
  for (const u of users) {
    const tr = el("tr", "");
    tr.appendChild(el("td", "", u.username));
    tr.appendChild(el("td", "", rolesLabel(u.roles)));
    tr.appendChild(el("td", "", u.status));
    tr.appendChild(el("td", "", u.totpEnabled ? "on" : "off"));
    tr.appendChild(el("td", "", u.lastLoginAt ? fmtDate(u.lastLoginAt) : "-"));
    tr.appendChild(rowActions(container, u));
    table.appendChild(tr);
  }
  return table;
}

/**
 * 계정 생성 양식. 계정이 0개이면 첫 owner 부트스트랩이다.
 */
function createForm(container, empty) {
  const wrap     = el("div", "space-y-2");
  const username = field("text", "USERNAME");
  const password = field("password", "PASSWORD (12+)");
  const roles    = field("text", "ROLES (owner, viewer@team-a)");
  wrap.appendChild(el("div", "text-xs uppercase", empty ? "첫 owner 만들기(마스터 키 로그인 필요)" : "계정 만들기"));
  wrap.appendChild(username);
  wrap.appendChild(password);
  if (!empty) wrap.appendChild(roles);
  wrap.appendChild(button(empty ? "BOOTSTRAP OWNER" : "CREATE", () => {
    const body = empty
      ? { username: username.value.trim(), password: password.value }
      : { username: username.value.trim(), password: password.value, roles: parseRolesInput(roles.value) };
    password.value = "";
    act(container, empty ? "/admin-users/bootstrap" : "/admin-users", { method: "POST", body }, "created");
  }));
  return wrap;
}

/**
 * 관리자 계정 화면.
 *
 * @param {HTMLElement} container
 */
export async function renderAdminUsers(container) {
  const res = await api("/admin-users");
  container.textContent = "";
  const wrap = el("div", "space-y-6");
  wrap.appendChild(el("h2", "text-lg font-bold", "관리자 계정"));
  if (!res.ok) {
    wrap.appendChild(el("div", "text-xs", errorLabel(res)));
    container.appendChild(wrap);
    return;
  }
  state.adminUsers = res.data.users || [];
  wrap.appendChild(usersTable(container, state.adminUsers));
  wrap.appendChild(createForm(container, state.adminUsers.length === 0));
  container.appendChild(wrap);
}
