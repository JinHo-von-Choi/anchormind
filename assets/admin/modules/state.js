/**
 * Memento MCP Admin Console — 상태 관리 및 라우터
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 *
 * 순환 의존을 방지하기 위해 뷰 렌더러는 registerView()로,
 * 사이드바 리렌더러는 setSidebarRenderer()로 외부에서 주입한다.
 * 이 모듈은 state와 뷰 레지스트리만 담당한다.
 */

export const state = {
  masterKey:   sessionStorage.getItem("adminKey") || "",
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

  memoryFilter: { topic: "", type: "", key_id: "", group_id: "" },
  memoryPage:   1,
  memoryPages:  1,
  fragments:    [],
  selectedFragment: null,
  anomalies:    null,
  searchEvents: null,

  logFile:   "",
  logLevel:  "",
  logSearch: "",
  logTail:   200,
  logLines:  [],
  logFiles:  [],
  logStats:  null
};

/** 뷰 이름 → 렌더러 함수 매핑 레지스트리 */
const viewRenderers = {};

/** 사이드바 리렌더 콜백 (admin.js에서 주입 — layout.js 직접 import 시 순환 의존 발생) */
let sidebarRenderer = null;

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
 */
export function registerView(name, renderer) {
  viewRenderers[name] = renderer;
}

/**
 * 현재 뷰 컨테이너에 등록된 렌더러를 호출하여 화면을 그린다.
 * 등록되지 않은 뷰는 무시한다.
 */
export function renderView() {
  const container = document.getElementById("view-container");
  if (!container) return;
  container.textContent = "";
  const renderer = viewRenderers[state.currentView];
  if (renderer) renderer(container);
}

/**
 * 지정 뷰로 전환하고 화면을 갱신한다.
 * 주입된 sidebarRenderer로 사이드바 활성 하이라이트를 함께 갱신한다.
 * @param {string} view - 전환할 뷰 이름
 */
export function navigate(view) {
  state.currentView = view;
  if (sidebarRenderer) sidebarRenderer();
  renderView();
}
