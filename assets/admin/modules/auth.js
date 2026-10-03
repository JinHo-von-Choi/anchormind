/**
 * Memento MCP Admin Console — 인증 (로그인 / 로그아웃)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 * 수정일: 2026-10-03 (관리자 계정 로그인, TOTP 등록)
 *
 * 로그인 화면은 두 경로를 둔다.
 *   마스터 키      ACCESS_KEY를 Bearer로 보낸다(기존 경로).
 *   관리자 계정    계정 이름, 비밀번호, TOTP 6자리 또는 복구 코드를 JSON으로 POST /auth에 보낸다. 서버가 세션 쿠키와
 *                  CSRF 쿠키를 준다. owner와 admin이 TOTP 등록 전이면 비밀과 등록 URI를 보여 주고 코드를 받아
 *                  POST /auth/totp로 등록을 마친 뒤 복구 코드 10개를 한 번 보여 준다.
 */

import { state, navigate } from "./state.js";
import { api } from "./api.js";

const TOTP_PATTERN = /^\d{6}$/;

/**
 * 두 번째 요소 입력을 요청 필드로 바꾼다. 6자리 숫자는 TOTP, 그 밖의 값은 복구 코드다.
 *
 * @param {string} code
 * @returns {Object}
 */
export function secondFactorFields(code) {
  const value = String(code || "").trim();
  if (value === "") return {};
  return TOTP_PATTERN.test(value) ? { totp: value } : { recoveryCode: value };
}

/** 앱 화면으로 들어간다. */
function enterApp() {
  document.getElementById("login-root")?.classList.add("hidden");
  document.getElementById("app")?.classList.add("visible");
  navigate("overview");
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function input(type, placeholder, id) {
  const node = el("input", "login-input");
  node.type = type;
  node.placeholder = placeholder;
  node.id = id;
  node.autocomplete = "off";
  return node;
}

/**
 * 복구 코드를 한 번 보여 주고 계속 단추로 앱에 들어간다.
 *
 * @param {HTMLElement} card
 * @param {string[]} codes
 */
export function renderRecoveryCodes(card, codes) {
  card.textContent = "";
  card.appendChild(el("div", "login-title", "RECOVERY CODES"));
  card.appendChild(el("div", "login-sub", "각 코드는 한 번만 쓸 수 있다. 지금 안전한 곳에 적어 둔다. 다시 보여 주지 않는다."));
  const list = el("div", "login-sub");
  list.id = "recovery-codes";
  for (const code of codes) list.appendChild(el("div", "", code));
  card.appendChild(list);
  const btn = el("button", "login-btn", "CONTINUE");
  btn.addEventListener("click", enterApp);
  card.appendChild(btn);
}

/**
 * TOTP 등록 화면. 비밀과 otpauth URI를 보여 주고 인증 앱의 코드를 받는다.
 *
 * @param {HTMLElement} card
 * @param {{ enrollToken: string, secret: string, otpauthUri: string }} enrollment
 */
export function renderEnrollment(card, enrollment) {
  card.textContent = "";
  card.appendChild(el("div", "login-title", "TOTP ENROLLMENT"));
  card.appendChild(el("div", "login-sub", "인증 앱에 아래 비밀(또는 URI)을 등록하고 표시된 6자리 코드를 넣는다."));
  card.appendChild(el("div", "login-sub", enrollment.secret));
  card.appendChild(el("div", "login-sub", enrollment.otpauthUri));
  const code  = input("text", "6-DIGIT CODE", "enroll-code");
  const error = el("div", "login-error", "CODE REJECTED");
  const btn   = el("button", "login-btn", "CONFIRM");
  card.appendChild(code);
  card.appendChild(error);
  card.appendChild(btn);
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const res = await api("/auth/totp", { method: "POST", body: { enrollToken: enrollment.enrollToken, code: code.value.trim() } });
    if (res.ok) {
      state.userSession = true;
      renderRecoveryCodes(card, res.data.recoveryCodes || []);
      return;
    }
    error.classList.add("visible");
    btn.disabled = false;
  });
}

/**
 * 관리자 계정 로그인 구역.
 *
 * @param {HTMLElement} card
 */
function appendAccountLogin(card) {
  card.appendChild(el("div", "login-sub", "ADMIN ACCOUNT"));
  const username = input("text", "USERNAME", "login-username");
  const password = input("password", "PASSWORD", "login-password");
  const code     = input("text", "TOTP OR RECOVERY CODE", "login-code");
  const error    = el("div", "login-error", "AUTHENTICATION FAILED");
  const btn      = el("button", "login-btn", "SIGN IN");
  btn.id = "login-account-btn";
  for (const node of [username, password, code, error, btn]) card.appendChild(node);

  async function attempt() {
    if (!username.value.trim() || !password.value) return;
    btn.disabled = true;
    state.masterKey = "";
    const res = await api("/auth", {
      method: "POST",
      body  : { username: username.value.trim(), password: password.value, ...secondFactorFields(code.value) }
    });
    password.value = "";
    if (res.ok && res.data?.enrollRequired) return renderEnrollment(card, res.data);
    if (res.ok) {
      state.userSession = true;
      return enterApp();
    }
    error.classList.add("visible");
    btn.disabled = false;
  }
  btn.addEventListener("click", attempt);
  code.addEventListener("keydown", (e) => { if (e.key === "Enter") attempt(); });
}

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
  const card = el("div", "login-card");
  card.appendChild(el("div", "login-title", "ANCHORMIND"));
  card.appendChild(el("div", "login-sub", "Operations Console Authentication Required"));

  const keyInput = input("password", "ACCESS_KEY", "login-key");
  card.appendChild(keyInput);

  const errEl = el("div", "login-error", "AUTHENTICATION FAILED");
  errEl.id = "login-error";
  card.appendChild(errEl);

  const btn = el("button", "login-btn", "AUTHENTICATE");
  btn.id = "login-btn";
  card.appendChild(btn);

  appendAccountLogin(card);
  root.appendChild(card);

  async function attemptLogin() {
    const key = keyInput.value.trim();
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
  keyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") attemptLogin(); });
}

/**
 * 세션을 초기화하고 로그인 화면으로 돌아간다. 관리자 계정 세션이면 서버 세션도 폐기한다.
 */
export async function logout() {
  if (state.userSession) {
    await api("/auth/logout", { method: "POST" });
    state.userSession = false;
    state.currentUser = null;
  }
  state.masterKey = "";
  sessionStorage.removeItem("adminKey");
  renderLogin();
}
