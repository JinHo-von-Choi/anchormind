/**
 * Memento MCP Admin Console — ESM Entry Point
 *
 * 작성자: 최진호
 * 작성일: 2026-03-26
 * 수정일: 2026-10-28 (화면 수명 관리, URL 경로, 검토 대기·모순 처리·검색 진단 화면)
 */

import { state, registerView, setSidebarRenderer, setAppEnterHandler, onViewCleanup, startRouter } from "./modules/state.js";
import { renderLogin } from "./modules/auth.js";
import { renderSidebar, renderCommandBar } from "./modules/layout.js";
import { renderOverview } from "./modules/overview.js";
import { renderKeys, keysRoute } from "./modules/keys.js";
import { renderGroups, groupsRoute } from "./modules/groups.js";
import { renderSessions, sessionsRoute } from "./modules/sessions.js";
import { renderGraph, graphRoute } from "./modules/graph.js";
import { renderLogs, logsRoute } from "./modules/logs.js";
import { renderAudit, auditRoute } from "./modules/audit.js";
import { renderAdminUsers } from "./modules/admin-users.js";
import { renderMemory, memoryRoute } from "./modules/memory.js";
import { renderReview, reviewRoute } from "./modules/review.js";
import { renderConflicts, conflictsRoute } from "./modules/conflicts.js";
import { renderSearchLab, searchLabRoute } from "./modules/search-lab.js";
import { mountMetricsView } from "./modules/metrics.js";
import { loadStats } from "./modules/stats.js";
import { api } from "./modules/api.js";

/** 메트릭 화면. 다른 화면으로 옮기면 자동 갱신을 멈춘다. */
function renderMetrics(container) {
  const mount = mountMetricsView(container);
  onViewCleanup(() => mount.unmount());
}

/* ── View Registration ── */
registerView("overview",   renderOverview);
registerView("keys",       renderKeys,       keysRoute);
registerView("groups",     renderGroups,     groupsRoute);
registerView("sessions",   renderSessions,   sessionsRoute);
registerView("graph",      renderGraph,      graphRoute);
registerView("logs",       renderLogs,       logsRoute);
registerView("audit",      renderAudit,      auditRoute);
registerView("adminUsers", renderAdminUsers);
registerView("memory",     renderMemory,     memoryRoute);
registerView("review",     renderReview,     reviewRoute);
registerView("conflicts",  renderConflicts,  conflictsRoute);
registerView("searchLab",  renderSearchLab,  searchLabRoute);
registerView("metrics",    renderMetrics);

/** 로그인 뒤 앱 화면을 연다. 주소가 가리키는 화면을 그리고 상단 표시줄 통계를 불러온다. */
function openApp() {
  document.getElementById("login-root")?.classList.add("hidden");
  document.getElementById("app")?.classList.add("visible");
  renderCommandBar();
  startRouter();
  /** healthFlags 실측 표시: 개요 화면과 같은 요청을 공유한다 */
  loadStats().then((res) => { if (res.ok) renderCommandBar(); });
}

/* ── Bootstrap ── */
function init() {
  setSidebarRenderer(renderSidebar);
  setAppEnterHandler(openApp);
  /** 마스터 키는 메모리에만 둔다. sessionStorage에 남아 있는 키는 지운다. */
  sessionStorage.removeItem("adminKey");
  const urlKey = new URLSearchParams(window.location.search).get("key");
  if (urlKey && !state.masterKey) state.masterKey = urlKey;

  if (state.masterKey) {
    api("/auth", { method: "POST", body: { key: state.masterKey } })
      .then(res => {
        if (res.ok) {
          openApp();
        } else {
          state.masterKey = "";
          renderLogin();
        }
      });
  } else {
    /** 관리자 계정 세션 쿠키가 있으면 그 세션으로 들어간다. */
    api("/me").then(res => {
      if (res.ok && res.data?.principal?.kind === "admin_session") {
        state.userSession = true;
        state.currentUser = res.data.principal;
        openApp();
      } else {
        renderLogin();
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", init);
