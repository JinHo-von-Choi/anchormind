/**
 * Memento MCP Admin Console — 레이아웃 (스캐폴드 / 사이드바 / 커맨드바)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 */

import { state, navigate, renderView } from "./state.js";
import { relativeTime } from "./format.js";
import { logout } from "./auth.js";

/**
 * 오프캔버스 사이드바를 열거나 닫는다 (768px 이하 전용).
 * @param {boolean} [force] - true=열기, false=닫기, 생략 시 토글
 */
export function toggleSidebar(force) {
  const sb = document.getElementById("sidebar");
  if (!sb) return;
  const open = force ?? !sb.classList.contains("open");
  sb.classList.toggle("open", open);
  document.getElementById("sidebar-overlay")?.classList.toggle("visible", open);
  document.getElementById("sidebar-toggle")?.setAttribute("aria-expanded", String(open));
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") toggleSidebar(false);
});

document.addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.id === "sidebar-overlay") toggleSidebar(false);
});

const NAV_ITEMS = [
  { id: "overview", label: "개요",       icon: "dashboard" },
  { id: "keys",     label: "API 키",     icon: "vpn_key" },
  { id: "groups",   label: "그룹",       icon: "group" },
  { id: "memory",   label: "메모리 운영", icon: "memory" },
  { id: "sessions", label: "세션",       icon: "settings_input_component" },
  { id: "logs",     label: "로그",       icon: "terminal" },
  { id: "graph",    label: "지식 그래프", icon: "hub" },
  { id: "metrics",  label: "메트릭",     icon: "monitoring" }
];

/**
 * 미구현 뷰에 플레이스홀더 스캐폴드를 렌더링한다.
 *
 * @param {HTMLElement} container - 뷰 컨테이너 엘리먼트
 * @param {string}      viewId    - 뷰 이름 ("sessions" | "logs" 등)
 */
export function renderScaffold(container, viewId) { // eslint-disable-line no-unused-vars
  container.textContent = "";
  const wrap = document.createElement("div");
  wrap.className = "space-y-6";

  const scaffolds = {
    sessions: {
      title: "세션 관리",
      note:  "API 연동 대기 -- 현재 세션 수는 개요에서 확인 가능",
      sections: ["활성 세션 목록", "세션 상세", "만료된 세션 정리"]
    },
    logs: {
      title: "시스템 로그",
      note:  "API 연동 대기 -- Winston 로그 스트림 연동 예정",
      sections: ["로그 레벨 필터", "로그 목록", "로그 상세"]
    }
  };

  const cfg = scaffolds[viewId] ?? { title: viewId, note: "후속 구현 예정", sections: [] };

  const h = document.createElement("h2");
  h.className = "text-2xl font-headline font-bold tracking-tight";
  h.textContent = cfg.title;
  wrap.appendChild(h);

  const note = document.createElement("p");
  note.className = "text-sm text-slate-400 glass-panel p-4 border-l-2 border-secondary";
  note.textContent = cfg.note;
  wrap.appendChild(note);

  for (const label of cfg.sections) {
    const sec = document.createElement("div");
    sec.className = "glass-panel p-6 rounded-sm";
    const sh = document.createElement("h3");
    sh.className = "font-headline text-sm font-bold uppercase tracking-widest text-slate-400 mb-4";
    sh.textContent = label;
    sec.appendChild(sh);
    const ph = document.createElement("div");
    ph.className = "text-sm text-slate-600 text-center py-8 border border-dashed border-white/5";
    ph.textContent = "-- " + label + " --";
    sec.appendChild(ph);
    wrap.appendChild(sec);
  }

  container.appendChild(wrap);
}

/**
 * #sidebar 엘리먼트에 사이드바 네비게이션을 렌더링한다.
 * 현재 활성 뷰는 state.currentView 기준으로 하이라이트된다.
 */
export function renderSidebar() {
  const el = document.getElementById("sidebar");
  if (!el) return;

  el.textContent = "";

  /* Brand */
  const brand = document.createElement("div");
  brand.className = "px-6 mb-8";

  const brandTitle = document.createElement("div");
  brandTitle.className = "text-xl font-bold tracking-tighter text-primary font-headline";
  brandTitle.textContent = "MEMENTO MCP";
  brand.appendChild(brandTitle);

  const brandSub = document.createElement("div");
  brandSub.className = "text-[10px] text-slate-500 tracking-[0.2em] font-medium uppercase mt-1 font-label";
  brandSub.textContent = "OPERATIONS CONSOLE";
  brand.appendChild(brandSub);

  el.appendChild(brand);

  /* Nav */
  const nav = document.createElement("nav");
  nav.className = "flex-1 px-3 space-y-1";

  NAV_ITEMS.forEach(n => {
    const item = document.createElement("a");
    item.href = "#";
    const isActive = n.id === state.currentView;

    if (isActive) {
      item.className = "flex items-center gap-3 px-4 py-2.5 rounded-sm text-primary bg-primary/10 border-l-2 border-primary transition-all duration-200";
    } else {
      item.className = "flex items-center gap-3 px-4 py-2.5 rounded-sm text-slate-500 hover:text-slate-200 hover:bg-white/5 transition-all duration-200";
    }

    if (n.scaffold) {
      item.style.opacity = "0.6";
    }

    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined text-[20px]";
    icon.textContent = n.icon;
    item.appendChild(icon);

    const label = document.createElement("span");
    label.className = "text-sm font-medium";
    label.textContent = n.label;
    item.appendChild(label);

    item.addEventListener("click", (e) => { e.preventDefault(); navigate(n.id); toggleSidebar(false); });
    nav.appendChild(item);
  });
  el.appendChild(nav);

  /* Bottom: Settings + Logout */
  const bottom = document.createElement("div");
  bottom.className = "px-3 py-4 border-t border-primary/10 space-y-1 mt-auto";

  const logoutItem = document.createElement("a");
  logoutItem.href = "#";
  logoutItem.className = "flex items-center gap-3 px-4 py-2 text-slate-500 hover:text-red-400 transition-colors text-xs font-medium uppercase tracking-wider";
  const logoutIcon = document.createElement("span");
  logoutIcon.className = "material-symbols-outlined text-[18px]";
  logoutIcon.textContent = "logout";
  logoutItem.appendChild(logoutIcon);
  logoutItem.appendChild(document.createTextNode("LOGOUT"));
  logoutItem.addEventListener("click", (e) => { e.preventDefault(); logout(); });
  bottom.appendChild(logoutItem);

  el.appendChild(bottom);
}

/**
 * #command-bar 엘리먼트에 상단 커맨드바를 렌더링한다.
 * 환경 배지, 헬스 상태, 마지막 동기화 시간, 새로고침 버튼, 유저 정보를 포함한다.
 */
export function renderCommandBar() {
  const el = document.getElementById("command-bar");
  if (!el) return;

  el.textContent = "";

  /* Left: Status badges */
  const left = document.createElement("div");
  left.className = "flex items-center gap-4";

  const menuBtn = document.createElement("button");
  menuBtn.id = "sidebar-toggle";
  menuBtn.className = "sidebar-toggle text-slate-400 hover:text-slate-200";
  menuBtn.setAttribute("aria-expanded", "false");
  menuBtn.setAttribute("aria-label", "메뉴 열기");
  const menuIcon = document.createElement("span");
  menuIcon.className = "material-symbols-outlined text-[22px]";
  menuIcon.textContent = "menu";
  menuBtn.appendChild(menuIcon);
  menuBtn.addEventListener("click", () => toggleSidebar());
  left.appendChild(menuBtn);

  const envBadge = document.createElement("span");
  envBadge.className = "px-2 py-0.5 bg-primary/10 text-primary border border-primary/20 text-[10px] font-mono tracking-widest font-bold rounded-sm";
  envBadge.textContent = "MASTER KEY";
  left.appendChild(envBadge);

  /** /stats healthFlags 실측 기반 상태 표시. stats 미로드 시 -- */
  const flags   = state.stats?.healthFlags ?? null;
  const healthy = Array.isArray(flags) && flags.length === 0;
  const healthDot = document.createElement("div");
  healthDot.className = "flex items-center gap-2";
  const dot = document.createElement("div");
  dot.className = "w-1.5 h-1.5 rounded-full " + (flags == null ? "bg-slate-600" : healthy ? "bg-tertiary" : "bg-error");
  healthDot.appendChild(dot);
  const healthText = document.createElement("span");
  healthText.className = "text-xs font-mono text-slate-400 uppercase tracking-tighter";
  healthText.textContent = flags == null
    ? "HEALTH: --"
    : healthy ? "HEALTH: OK" : `HEALTH: ${flags.length} FLAG${flags.length > 1 ? "S" : ""}`;
  if (!healthy && Array.isArray(flags) && flags.length > 0) healthText.title = flags.join(", ");
  healthDot.appendChild(healthText);
  left.appendChild(healthDot);

  const sep = document.createElement("div");
  sep.className = "h-4 w-px bg-slate-800";
  left.appendChild(sep);

  const syncText = document.createElement("span");
  syncText.className = "text-[10px] font-mono text-slate-500 uppercase";
  syncText.textContent = "SYNCED: " + (state.lastUpdated ? relativeTime(state.lastUpdated) : "--");
  left.appendChild(syncText);

  el.appendChild(left);

  /* Right: actions */
  const right = document.createElement("div");
  right.className = "flex items-center gap-4";

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "text-slate-400 hover:text-primary transition-all";
  const refreshIcon = document.createElement("span");
  refreshIcon.className = "material-symbols-outlined";
  refreshIcon.textContent = "refresh";
  refreshBtn.appendChild(refreshIcon);
  refreshBtn.addEventListener("click", async () => {
    renderView();
    const { api } = await import("./api.js");
    const res = await api("/stats");
    if (res.ok) {
      state.stats = res.data;
      state.lastUpdated = Date.now();
      renderCommandBar();
    }
  });
  right.appendChild(refreshBtn);

  const divider = document.createElement("div");
  divider.className = "h-8 w-px bg-white/10";
  right.appendChild(divider);

  const userIcon = document.createElement("span");
  userIcon.className = "material-symbols-outlined text-slate-400 text-3xl";
  userIcon.textContent = "account_circle";
  right.appendChild(userIcon);

  el.appendChild(right);
}
