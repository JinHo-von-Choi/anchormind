/**
 * Memento MCP Admin Console — 인증 (로그인 / 로그아웃)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 */

import { state, navigate } from "./state.js";
import { api } from "./api.js";

/**
 * 로그인 화면을 #login-root에 렌더링한다.
 * 인증 성공 시 overview 뷰로 전환하고, 실패 시 에러 메시지를 표시한다.
 */
export function renderLogin() {
  const root = document.getElementById("login-root");
  if (!root) return;

  root.classList.remove("hidden");
  const app = document.getElementById("app");
  if (app) app.classList.remove("visible");

  root.textContent = "";
  const card = document.createElement("div");
  card.className = "login-card";

  const titleEl = document.createElement("div");
  titleEl.className = "login-title";
  titleEl.textContent = "ANCHORMIND";
  card.appendChild(titleEl);

  const sub = document.createElement("div");
  sub.className = "login-sub";
  sub.textContent = "Operations Console Authentication Required";
  card.appendChild(sub);

  const input = document.createElement("input");
  input.type = "password";
  input.className = "login-input";
  input.id = "login-key";
  input.placeholder = "ACCESS_KEY";
  input.autocomplete = "off";
  card.appendChild(input);

  const errEl = document.createElement("div");
  errEl.className = "login-error";
  errEl.id = "login-error";
  errEl.textContent = "AUTHENTICATION FAILED";
  card.appendChild(errEl);

  const btn = document.createElement("button");
  btn.className = "login-btn";
  btn.id = "login-btn";
  btn.textContent = "AUTHENTICATE";
  card.appendChild(btn);

  root.appendChild(card);

  async function attemptLogin() {
    const key = input.value.trim();
    if (!key) return;

    btn.disabled = true;
    state.masterKey = key;

    const res = await api("/auth", { method: "POST", body: { key } });
    if (res.ok) {
      sessionStorage.setItem("adminKey", key);
      root.classList.add("hidden");
      const appEl = document.getElementById("app");
      if (appEl) appEl.classList.add("visible");
      navigate("overview");
    } else {
      errEl.classList.add("visible");
      state.masterKey = "";
      sessionStorage.removeItem("adminKey");
      btn.disabled = false;
    }
  }

  btn.addEventListener("click", attemptLogin);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") attemptLogin(); });
}

/**
 * 세션을 초기화하고 로그인 화면으로 돌아간다.
 */
export function logout() {
  state.masterKey = "";
  sessionStorage.removeItem("adminKey");
  renderLogin();
}
