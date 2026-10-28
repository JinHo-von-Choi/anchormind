/**
 * Memento MCP Admin Console — 자동 갱신 표시와 제어
 *
 * 작성자: 최진호
 * 작성일: 2026-10-28
 *
 * 주기마다 run을 부르고, 갱신 주기와 마지막 갱신 시각, 일시정지 버튼을 보여 주는 요소를 만든다.
 * 브라우저 탭이 가려져 있으면 부르지 않고, 탭으로 돌아오면 바로 한 번 부른다.
 * 화면을 떠날 때 stop()을 불러 타이머와 이벤트를 해제한다.
 */

/** 기본 갱신 주기(ms) */
export const AUTO_REFRESH_MS = 30000;

/**
 * 자동 갱신 문구.
 *
 * @param {{ paused: boolean, intervalMs: number, lastAt: number|null }} s
 * @returns {string}
 */
export function autoRefreshLabel({ paused, intervalMs, lastAt }) {
  if (paused) return "자동 갱신 일시정지";
  const base = `자동 갱신 ${Math.round(intervalMs / 1000)}초`;
  if (!lastAt) return base;
  const at = new Date(lastAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${base} · 마지막 갱신 ${at}`;
}

/**
 * 자동 갱신을 시작한다.
 *
 * @param {Function} run - 갱신 함수
 * @param {{ intervalMs?: number }} [options]
 * @returns {{ element: HTMLElement, markUpdated: (at?: number) => void, stop: () => void, isPaused: () => boolean }}
 */
export function createAutoRefresh(run, { intervalMs = AUTO_REFRESH_MS } = {}) {
  let paused = false;
  let lastAt = null;

  const element = document.createElement("div");
  element.className = "flex items-center gap-2 text-[10px] font-mono text-slate-500";
  element.dataset.autoRefresh = "true";

  const label = document.createElement("span");
  element.appendChild(label);

  const toggle = document.createElement("button");
  toggle.type      = "button";
  toggle.className = "btn px-2 py-1 text-[10px]";
  element.appendChild(toggle);

  function paint() {
    label.textContent  = autoRefreshLabel({ paused, intervalMs, lastAt });
    toggle.textContent = paused ? "재개" : "일시정지";
    toggle.setAttribute?.("aria-pressed", String(paused));
  }

  const visible = () => typeof document.visibilityState !== "string" || document.visibilityState !== "hidden";
  const timer   = setInterval(() => {
    if (!paused && visible()) run();
  }, intervalMs);
  const onVisibility = () => {
    if (!paused && document.visibilityState === "visible") run();
  };
  document.addEventListener("visibilitychange", onVisibility);

  toggle.addEventListener("click", () => {
    paused = !paused;
    paint();
    if (!paused) run();
  });
  paint();

  return {
    element,
    markUpdated(at = Date.now()) {
      lastAt = at;
      paint();
    },
    stop() {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    },
    isPaused: () => paused
  };
}
