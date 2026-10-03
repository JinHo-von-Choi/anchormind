/**
 * 관리 콘솔 관리자 계정 로그인과 계정 화면 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 순수 함수(역할 입력 해석, 두 번째 요소 필드, 인증 헤더), 로그인 화면의 계정 구역과 TOTP 등록 흐름, 계정 화면 렌더
 * 구조(서버 값은 textContent), 뷰 등록을 본다.
 */

import { describe, it, beforeEach } from "node:test";
import assert                       from "node:assert/strict";
import { readFileSync }             from "node:fs";
import path                         from "node:path";
import { fileURLToPath }            from "node:url";
import { setupDom, flatQuery }      from "./admin-test-helper.js";

setupDom();

const { parseRolesInput, rolesLabel, errorLabel, renderAdminUsers } = await import("../../assets/admin/modules/admin-users.js");
const { secondFactorFields, renderLogin, renderEnrollment } = await import("../../assets/admin/modules/auth.js");
const { authHeaders, readCookie } = await import("../../assets/admin/modules/api.js");
const { state } = await import("../../assets/admin/modules/state.js");

const ROOT      = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read      = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");

function allText(node) {
  if (!node || typeof node !== "object") return typeof node === "string" ? node : "";
  return [node.textContent ?? "", ...(node.children ?? []).map(allText)].join(" ");
}

let calls;
let replies;
beforeEach(() => {
  calls   = [];
  replies = [];
  state.masterKey   = "";
  state.userSession = false;
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const r = replies.shift() ?? { status: 200, body: {} };
    return { ok: r.status < 400, status: r.status, headers: { get: () => "application/json" }, json: async () => r.body };
  };
});

describe("순수 함수", () => {
  it("역할 입력을 바인딩으로 바꾸고 다시 표시 문자열로 만든다", () => {
    const roles = parseRolesInput(" owner, viewer@team-a ,, reviewer@ ");
    assert.deepEqual(roles, [{ role: "owner", workspace: null }, { role: "viewer", workspace: "team-a" }, { role: "reviewer", workspace: null }]);
    assert.equal(rolesLabel(roles), "owner, viewer@team-a, reviewer");
  });

  it("6자리 숫자는 TOTP, 그 밖은 복구 코드, 빈 값은 필드 없음이다", () => {
    assert.deepEqual(secondFactorFields(" 123456 "), { totp: "123456" });
    assert.deepEqual(secondFactorFields("abcde-fg234"), { recoveryCode: "abcde-fg234" });
    assert.deepEqual(secondFactorFields(""), {});
  });

  it("마스터 키가 있으면 Bearer, 없으면 비GET에만 CSRF 쿠키 값을 헤더로 보낸다", () => {
    state.masterKey = "mk";
    assert.deepEqual(authHeaders("POST", "mmcp_csrf=abc"), { Authorization: "Bearer mk" });
    state.masterKey = "";
    assert.deepEqual(authHeaders("GET", "mmcp_csrf=abc"), {});
    assert.deepEqual(authHeaders("POST", "a=1; mmcp_csrf=abc"), { "X-CSRF-Token": "abc" });
    assert.deepEqual(authHeaders("DELETE", ""), {});
    assert.equal(readCookie("x=1; mmcp_csrf=v=2", "mmcp_csrf"), "v=2");
  });

  it("오류 문구는 상태와 사유, 필드를 담는다", () => {
    assert.equal(errorLabel({ status: 409, data: { reason: "last_owner" } }), "409 last_owner");
    assert.equal(errorLabel({ status: 400, data: { reason: "too_short", field: "password" } }), "400 too_short (password)");
  });
});

describe("로그인 화면", () => {
  it("마스터 키 입력과 함께 계정 이름, 비밀번호, 코드 입력이 있다", () => {
    const root = globalThis.document.createElement("div");
    root.id = "login-root";
    root.classList = { add() {}, remove() {} };
    const original = globalThis.document.getElementById;
    globalThis.document.getElementById = (id) => (id === "login-root" ? root : null);
    try {
      renderLogin();
    } finally {
      globalThis.document.getElementById = original;
    }
    const ids = flatQuery(root, "input").map((i) => i.id);
    for (const id of ["login-key", "login-username", "login-password", "login-code"]) assert.ok(ids.includes(id), id);
  });

  it("TOTP 등록 화면은 비밀을 보여 주고 확인하면 POST /auth/totp 뒤 복구 코드를 보여 준다", async () => {
    const card = globalThis.document.createElement("div");
    renderEnrollment(card, { enrollToken: "tok", secret: "ABCDEFGH", otpauthUri: "otpauth://totp/x" });
    assert.match(allText(card), /ABCDEFGH/);
    const input = flatQuery(card, "input")[0];
    input.value = "123456";
    replies.push({ status: 200, body: { ok: true, recoveryCodes: ["aaaaa-bbbbb", "ccccc-ddddd"] } });
    const btn = flatQuery(card, "button")[0];
    await btn._listeners.click[0]();
    assert.match(calls[0].url, /\/auth\/totp$/);
    assert.deepEqual(JSON.parse(calls[0].options.body), { enrollToken: "tok", code: "123456" });
    assert.match(allText(card), /aaaaa-bbbbb/);
    assert.equal(state.userSession, true);
  });
});

describe("계정 화면", () => {
  it("목록을 textContent로 그리고 계정이 없으면 부트스트랩 양식이다", async () => {
    const container = globalThis.document.createElement("div");
    replies.push({ status: 200, body: { users: [{ id: "u1", username: "<b>ops</b>", roles: [{ role: "owner", workspace: null }], status: "active", totpEnabled: true }] } });
    await renderAdminUsers(container);
    assert.match(allText(container), /<b>ops<\/b>/);
    assert.match(allText(container), /CREATE/);
    replies.push({ status: 200, body: { users: [] } });
    await renderAdminUsers(container);
    assert.match(allText(container), /BOOTSTRAP OWNER/);
  });

  it("권한이 없으면 오류 문구만 보여 준다", async () => {
    const container = globalThis.document.createElement("div");
    replies.push({ status: 403, body: { error: "Forbidden", cap: "admin_user.manage" } });
    await renderAdminUsers(container);
    assert.match(allText(container), /403 admin_user\.manage/);
  });

  it("소스는 innerHTML을 쓰지 않고 뷰와 사이드바 항목이 등록된다", () => {
    assert.doesNotMatch(read("assets", "admin", "modules", "admin-users.js"), /innerHTML/);
    assert.doesNotMatch(read("assets", "admin", "modules", "auth.js"), /innerHTML/);
    assert.match(read("assets", "admin", "admin.js"), /registerView\("adminUsers", renderAdminUsers\)/);
    assert.match(read("assets", "admin", "modules", "layout.js"), /id: "adminUsers"/);
  });
});
