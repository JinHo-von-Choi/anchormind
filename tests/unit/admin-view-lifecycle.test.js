/**
 * 관리 콘솔 화면 수명과 URL 해시 경로 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-28
 *
 * 화면을 옮기거나 같은 화면을 다시 그리면 앞 렌더 문맥이 무효가 되고 요청이 취소되는지, 화면을 떠날 때
 * 정리 함수가 불리는지, 해시와 state가 서로 옮겨지는지 본다. 메트릭 화면의 자동 갱신이 다른 화면으로
 * 옮긴 뒤에도 돌아 화면을 덮던 결함과, 늦게 온 응답이 새 화면을 덮던 결함의 회귀 시험이다.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const listeners = {};
const container = { textContent: "x", tagName: "MAIN" };
const appEl     = { classList: { contains: (c) => c === "visible" } };

const location = { hash: "" };
const history  = {
  pushes  : [],
  replaces: [],
  pushState(_s, _t, hash)    { this.pushes.push(hash); location.hash = hash; },
  replaceState(_s, _t, hash) { this.replaces.push(hash); location.hash = hash; }
};
globalThis.window   = { addEventListener: (type, fn) => { listeners[type] = fn; } };
globalThis.location = location;
globalThis.history  = history;
globalThis.document = {
  getElementById: (id) => (id === "view-container" ? container : id === "app" ? appEl : null)
};

const {
  state, registerView, navigate, beginRender, onViewCleanup, syncRoute,
  parseHash, buildHash, applyHash, startRouter, closeView
} = await import("../../assets/admin/modules/state.js");

const calls = [];
let lastCtx = null;

registerView("alpha", () => { calls.push("alpha"); lastCtx = beginRender(); });
registerView("beta", () => { calls.push("beta"); lastCtx = beginRender(); }, {
  fromQuery(q) { state.betaFilter = q.get("f") ?? ""; state.betaPage = Number(q.get("page") ?? 1); },
  toQuery()    { return { f: state.betaFilter, page: state.betaPage > 1 ? state.betaPage : "" }; }
});

beforeEach(() => {
  calls.length = 0;
  history.pushes.length = 0;
  history.replaces.length = 0;
  location.hash = "";
  state.betaFilter = "";
  state.betaPage = 1;
  closeView();
});

describe("화면 수명", () => {
  it("다른 화면으로 옮기면 앞 렌더 문맥이 무효가 되고 요청 신호가 취소된다", () => {
    navigate("alpha");
    const first = lastCtx;
    assert.equal(first.isCurrent(), true);
    navigate("beta");
    assert.equal(first.isCurrent(), false, "늦게 온 응답은 그리지 않아야 한다");
    assert.equal(first.signal.aborted, true);
    assert.equal(lastCtx.isCurrent(), true);
  });

  it("같은 화면을 다시 그려도 앞 렌더 문맥은 무효다", () => {
    navigate("alpha");
    const first  = beginRender();
    const second = beginRender();
    assert.equal(first.isCurrent(), false);
    assert.equal(second.isCurrent(), true);
  });

  it("화면을 떠날 때 등록한 정리 함수를 한 번 부른다", () => {
    let stopped = 0;
    navigate("alpha");
    onViewCleanup(() => { stopped += 1; });
    navigate("beta");
    assert.equal(stopped, 1, "자동 갱신 타이머 같은 정리 함수가 불려야 한다");
    navigate("alpha");
    assert.equal(stopped, 1, "이미 부른 정리 함수는 다시 부르지 않는다");
  });

  it("정리 함수가 실패해도 다음 정리 함수와 렌더는 계속된다", () => {
    let later = false;
    navigate("alpha");
    const origError = console.error;
    console.error = () => {};
    onViewCleanup(() => { throw new Error("boom"); });
    onViewCleanup(() => { later = true; });
    navigate("beta");
    console.error = origError;
    assert.equal(later, true);
    assert.deepEqual(calls.slice(-1), ["beta"]);
  });

  it("closeView는 정리 함수를 부르고 화면을 비운다", () => {
    let stopped = false;
    navigate("alpha");
    onViewCleanup(() => { stopped = true; });
    container.textContent = "content";
    closeView();
    assert.equal(stopped, true);
    assert.equal(container.textContent, "");
  });
});

describe("URL 해시 경로", () => {
  it("parseHash와 buildHash는 서로 옮겨진다", () => {
    const hash = buildHash("beta", { f: "a b", page: 2, empty: "", none: null });
    assert.equal(hash, "#/beta?f=a+b&page=2");
    const { view, query } = parseHash(hash);
    assert.equal(view, "beta");
    assert.equal(query.get("f"), "a b");
  });

  it("navigate는 기록을 하나 더하고 질의를 state에 옮긴다", () => {
    navigate("beta", { f: "x", page: "3" });
    assert.equal(state.betaFilter, "x");
    assert.equal(state.betaPage, 3);
    assert.deepEqual(history.pushes, ["#/beta?f=x&page=3"]);
  });

  it("syncRoute는 기록을 더하지 않고 현재 state를 주소에 반영한다", () => {
    navigate("beta");
    state.betaFilter = "y";
    syncRoute();
    assert.equal(location.hash, "#/beta?f=y");
    assert.equal(history.pushes.length, 1);
    assert.equal(history.replaces.at(-1), "#/beta?f=y");
  });

  it("등록되지 않은 화면의 해시는 무시한다", () => {
    state.currentView = "alpha";
    assert.equal(applyHash("#/nope?f=1"), false);
    assert.equal(state.currentView, "alpha");
  });

  it("startRouter는 주소의 화면을 열고, 주소가 비면 현재 화면을 연다", () => {
    location.hash = "#/beta?f=z";
    startRouter();
    assert.equal(state.currentView, "beta");
    assert.equal(state.betaFilter, "z");
    assert.deepEqual(calls.slice(-1), ["beta"]);
  });

  it("뒤로 가기(popstate)는 주소의 화면과 질의를 다시 그린다", () => {
    navigate("alpha");
    location.hash = "#/beta?f=back";
    listeners.popstate();
    assert.equal(state.currentView, "beta");
    assert.equal(state.betaFilter, "back");
    assert.deepEqual(calls.slice(-1), ["beta"]);
  });
});
