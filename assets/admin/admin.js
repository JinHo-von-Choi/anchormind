/**
 * Memento MCP Admin Console — ESM Entry Point
 *
 * 작성자: 최진호
 * 작성일: 2026-03-26
 * 수정일: 2026-04-20 (metrics 모듈 추가)
 */

import { state, registerView, renderView, setSidebarRenderer } from "./modules/state.js";
import { renderLogin } from "./modules/auth.js";
import { renderSidebar, renderCommandBar } from "./modules/layout.js";
import { renderOverview } from "./modules/overview.js";
import { renderKeys } from "./modules/keys.js";
import { renderGroups } from "./modules/groups.js";
import { renderSessions } from "./modules/sessions.js";
import { renderGraph } from "./modules/graph.js";
import { renderLogs } from "./modules/logs.js";
import { renderMemory } from "./modules/memory.js";
import { mountMetricsView } from "./modules/metrics.js";
import { api } from "./modules/api.js";

/** 현재 마운트된 metrics 인스턴스 (뷰 전환 시 unmount 처리) */
let _metricsMount = null;

function renderMetrics(container) {
  if (_metricsMount) {
    _metricsMount.unmount();
    _metricsMount = null;
  }
  _metricsMount = mountMetricsView(container);
}

/* ── View Registration ── */
registerView("overview", renderOverview);
registerView("keys",     renderKeys);
registerView("groups",   renderGroups);
registerView("sessions", renderSessions);
registerView("graph",    renderGraph);
registerView("logs",     renderLogs);
registerView("memory",   renderMemory);
registerView("metrics",  renderMetrics);

/* ── Bootstrap ── */
function init() {
  setSidebarRenderer(renderSidebar);
  const urlKey = new URLSearchParams(window.location.search).get("key");
  if (urlKey && !state.masterKey) {
    state.masterKey = urlKey;
    sessionStorage.setItem("adminKey", urlKey);
  }

  if (state.masterKey) {
    api("/auth", { method: "POST", body: { key: state.masterKey } })
      .then(res => {
        if (res.ok) {
          document.getElementById("login-root")?.classList.add("hidden");
          document.getElementById("app")?.classList.add("visible");
          renderSidebar();
          renderCommandBar();
          renderView();
          /** healthFlags 실측 표시: stats 로드 후 커맨드바 갱신 */
          api("/stats").then(statsRes => {
            if (statsRes.ok) {
              state.stats = statsRes.data;
              state.lastUpdated = Date.now();
              renderCommandBar();
            }
          });
        } else {
          state.masterKey = "";
          sessionStorage.removeItem("adminKey");
          renderLogin();
        }
      });
  } else {
    renderLogin();
  }
}

document.addEventListener("DOMContentLoaded", init);
