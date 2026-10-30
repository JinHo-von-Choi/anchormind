/**
 * Memento MCP Admin Console — 상태 관리 및 라우터
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 * 수정일: 2026-10-28 (화면 수명 관리, URL 해시 경로)
 *
 * 순환 의존을 방지하기 위해 뷰 렌더러는 registerView()로,
 * 사이드바 리렌더러는 setSidebarRenderer()로 외부에서 주입한다.
 * 이 모듈은 state, 뷰 레지스트리, 화면 수명, URL 해시 경로를 담당한다.
 *
 * 화면 수명: 렌더러는 시작할 때 beginRender()로 렌더 문맥을 받는다. 같은 화면을 다시 그리거나 다른 화면으로
 * 옮기면 앞 문맥은 무효가 되고 그 문맥의 요청은 취소된다. 렌더러는 await 뒤 ctx.isCurrent()가 거짓이면
 * 그리지 않는다. 타이머와 이벤트처럼 화면을 떠날 때 멈춰야 하는 것은 onViewCleanup()에 등록한다.
 *
 * URL 해시 경로: "#/<뷰>?<질의>". 뷰를 등록할 때 route({ fromQuery, toQuery })를 주면 질의와 state를
 * 서로 옮긴다. 렌더러가 syncRoute()를 부르면 현재 state가 주소에 반영되고(기록 교체), navigate()는
 * 기록을 하나 더한다. 뒤로 가기와 앞으로 가기는 주소의 화면과 질의를 다시 그린다.
 */

export const state = {
  masterKey:   "",
  userSession: false,
  currentUser: null,
  adminUsers:  [],
  currentView: "overview",
  stats:       null,
  keys:        [],
  groups:      [],
  memoryData:  null,
  loading:     false,
  lastUpdated: null,

  selectedKeyId:     null,
  selectedGroupId:   null,
  selectedSessionId: null,

  keyFilterGroup:  "",
  keyFilterStatus: "",

  memoryFilter: { q: "", topic: "", type: "", key_id: "", group_id: "" },
  memoryPage:   1,
  memoryPages:  1,
  fragments:    [],
  selectedFragment: null,
  selectedFragmentId: null,
  anomalies:    null,
  searchEvents: null,

  logFile:   "",
  logLevel:  "",
  logSearch: "",
  logTail:   200,
  logLines:  [],
  logFiles:  [],
  logStats:  null,

  auditFilter:     { action: "", actor: "", target_type: "", target_id: "", outcome: "", from: "", to: "" },
  auditEvents:     [],
  auditNextBefore: null,
  auditVerify:     null,

  reviewKeyId:     "",
  conflictStatus:  "open"
};

/** 뷰 이름 → { renderer, route } 레지스트리 */
const viewRegistry = {};

/** 사이드바 리렌더 콜백 (admin.js에서 주입 — layout.js 직접 import 시 순환 의존 발생) */
let sidebarRenderer = null;

/** 현재 렌더 문맥 { seq, controller } */
let activeRender = null;
let renderSeq    = 0;

/** 화면을 떠날 때 부를 정리 함수 */
let viewCleanups = [];

/**
 * 사이드바 리렌더러를 주입한다.
 * @param {Function} fn - 사이드바를 다시 그리는 함수
 */
export function setSidebarRenderer(fn) {
  sidebarRenderer = fn;
}

/**
 * 뷰 렌더러를 등록한다.
 * @param {string}   name     - 뷰 이름 ("overview", "keys" 등)
 * @param {Function} renderer - (container: HTMLElement) => void
 * @param {{ fromQuery?: (query: URLSearchParams) => void, toQuery?: () => Object }} [route] - 주소 질의와 state 변환
 */
export function registerView(name, renderer, route = null) {
  viewRegistry[name] = { renderer, route };
}

/**
 * 등록된 뷰인지 확인한다.
 * @param {string} name
 * @returns {boolean}
 */
export function hasView(name) {
  return Object.prototype.hasOwnProperty.call(viewRegistry, name);
}

/**
 * 새 렌더 문맥을 시작한다. 앞 문맥은 무효가 되고 그 문맥의 요청은 취소된다.
 *
 * @returns {{ signal: AbortSignal, isCurrent: () => boolean }}
 */
export function beginRender() {
  activeRender?.controller.abort();
  const seq        = ++renderSeq;
  const controller = new AbortController();
  activeRender     = { seq, controller };
  return { signal: controller.signal, isCurrent: () => activeRender?.seq === seq };
}

/**
 * 현재 화면을 떠날 때 부를 정리 함수를 등록한다.
 * @param {Function} fn
 */
export function onViewCleanup(fn) {
  if (typeof fn === "function") viewCleanups.push(fn);
}

/** 현재 화면의 렌더 문맥을 끝내고 정리 함수를 부른다. */
function teardownView() {
  activeRender?.controller.abort();
  activeRender = null;
  const cleanups = viewCleanups;
  viewCleanups   = [];
  for (const fn of cleanups) {
    try {
      fn();
    } catch (err) {
      console.error("[admin] view cleanup failed", err);
    }
  }
}

/** 현재 화면을 닫는다. 로그아웃처럼 다른 화면을 그리지 않고 떠날 때 쓴다. */
export function closeView() {
  teardownView();
  const container = document.getElementById("view-container");
  if (container) container.textContent = "";
}

/**
 * 현재 뷰 컨테이너에 등록된 렌더러를 호출하여 화면을 그린다.
 * 앞 화면의 요청, 타이머, 이벤트는 먼저 정리한다. 등록되지 않은 뷰는 무시한다.
 */
export function renderView() {
  const container = document.getElementById("view-container");
  if (!container) return;
  teardownView();
  container.textContent = "";
  const entry = viewRegistry[state.currentView];
  if (entry) entry.renderer(container);
}

/**
 * 해시 문자열을 뷰 이름과 질의로 나눈다.
 * @param {string} hash - location.hash ("#/memory?topic=a")
 * @returns {{ view: string, query: URLSearchParams }}
 */
export function parseHash(hash) {
  const raw = String(hash || "").replace(/^#\/?/, "");
  const idx = raw.indexOf("?");
  const view  = idx >= 0 ? raw.slice(0, idx) : raw;
  const query = new URLSearchParams(idx >= 0 ? raw.slice(idx + 1) : "");
  let name = view;
  try {
    name = decodeURIComponent(view);
  // iron-laws: ignore[IL-301] 잘못 인코딩된 주소 조각은 빈 화면 이름으로 처리한다
  } catch {
    name = "";
  }
  return { view: name, query };
}

/**
 * 뷰 이름과 질의로 해시 문자열을 만든다. 값이 비었거나 null인 질의 항목은 뺀다.
 * @param {string} view
 * @param {Object|null} [query]
 * @returns {string}
 */
export function buildHash(view, query = null) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return `#/${encodeURIComponent(view)}${qs ? "?" + qs : ""}`;
}

/** 현재 뷰와 state가 가리키는 해시 */
function currentHash() {
  const route = viewRegistry[state.currentView]?.route;
  return buildHash(state.currentView, route?.toQuery?.() ?? null);
}

function canUseHistory() {
  return typeof window !== "undefined" && typeof history !== "undefined" && typeof location !== "undefined";
}

/** 현재 state를 주소에 반영한다. 기록을 더하지 않는다. */
export function syncRoute() {
  if (!canUseHistory()) return;
  const hash = currentHash();
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

/**
 * 해시를 state에 적용한다. 등록된 뷰가 아니면 아무것도 바꾸지 않는다.
 * @param {string} hash
 * @returns {boolean} 적용했으면 true
 */
export function applyHash(hash) {
  const { view, query } = parseHash(hash);
  if (!hasView(view)) return false;
  state.currentView = view;
  viewRegistry[view].route?.fromQuery?.(query);
  return true;
}

/**
 * 지정 뷰로 전환하고 화면을 갱신한다. 주소 기록을 하나 더한다.
 * 주입된 sidebarRenderer로 사이드바 활성 하이라이트를 함께 갱신한다.
 * @param {string} view - 전환할 뷰 이름
 * @param {Object} [query] - 주면 그 뷰의 fromQuery로 state에 적용한다
 */
export function navigate(view, query = null) {
  state.currentView = view;
  if (query) viewRegistry[view]?.route?.fromQuery?.(new URLSearchParams(query));
  if (canUseHistory()) {
    const hash = currentHash();
    if (location.hash !== hash) history.pushState(null, "", hash);
  }
  if (sidebarRenderer) sidebarRenderer();
  renderView();
}

/** 로그인 뒤 앱 화면을 여는 처리기 (admin.js에서 주입) */
let appEnterHandler = null;

/**
 * 로그인 뒤 앱 화면을 여는 처리기를 주입한다.
 * @param {Function} fn
 */
export function setAppEnterHandler(fn) {
  appEnterHandler = fn;
}

/** 로그인 뒤 앱 화면을 연다. 처리기가 없으면 주소의 화면만 그린다. */
export function enterApp() {
  if (appEnterHandler) appEnterHandler();
  else startRouter();
}

/**
 * 로그인 뒤 주소의 화면을 연다. 주소가 등록된 뷰를 가리키지 않으면 개요를 연다.
 */
export function startRouter() {
  if (!canUseHistory() || !applyHash(location.hash)) state.currentView = hasView(state.currentView) ? state.currentView : "overview";
  syncRoute();
  if (sidebarRenderer) sidebarRenderer();
  renderView();
}

/** 뒤로 가기, 앞으로 가기, 주소 직접 수정 */
function onPopState() {
  if (!document.getElementById("app")?.classList.contains("visible")) return;
  if (!applyHash(location.hash)) return;
  if (sidebarRenderer) sidebarRenderer();
  renderView();
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("popstate", onPopState);
}
