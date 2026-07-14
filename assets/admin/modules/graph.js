import { api }       from "./api.js";
import { showToast } from "./ui.js";

/** 노드 색상 모드: "type"(기본) | "agent" — 토글 버튼으로 전환 */
let colorMode       = "type";
let applyColorModeFn = null;

const AGENT_PALETTE = ["#aa8855", "#557799", "#669944", "#cc7755", "#8878d0", "#50a8a0", "#c4a06a", "#a05580"];

/** agent_id 문자열을 팔레트 색으로 결정적 매핑한다. */
function agentColor(agentId) {
  const str = String(agentId ?? "default");
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return AGENT_PALETTE[hash % AGENT_PALETTE.length];
}

async function renderGraph(container) {
  container.textContent = "";

  const wrap = document.createElement("div");
  wrap.className = "space-y-6";

  /* Header */
  const header = document.createElement("div");
  header.className = "flex items-center justify-between";

  const title = document.createElement("h2");
  title.className = "text-2xl font-headline font-bold tracking-tight";
  title.textContent = "Knowledge Graph";
  header.appendChild(title);

  const statsSpan = document.createElement("span");
  statsSpan.id = "graph-stats";
  statsSpan.className = "text-sm text-slate-400 font-mono";
  statsSpan.textContent = "--";
  header.appendChild(statsSpan);

  wrap.appendChild(header);

  /* Controls */
  const controls = document.createElement("div");
  controls.className = "glass-panel p-4 rounded-sm flex items-center gap-4 flex-wrap";

  const topicInput = document.createElement("input");
  topicInput.type = "text";
  topicInput.id = "graph-topic";
  topicInput.placeholder = "Topic filter";
  topicInput.className = "bg-surface-container border border-outline-variant/30 rounded-sm px-3 py-1.5 text-sm text-on-surface focus:border-primary focus:outline-none w-48";

  const limitLabel = document.createElement("label");
  limitLabel.className = "text-sm text-slate-400 flex items-center gap-2";
  limitLabel.textContent = "Limit: ";

  const limitRange = document.createElement("input");
  limitRange.type = "range";
  limitRange.id = "graph-limit";
  limitRange.min = "10";
  limitRange.max = "10000";
  limitRange.value = "50";
  limitRange.step = "10";
  limitRange.className = "w-32 accent-primary";

  const limitValue = document.createElement("span");
  limitValue.id = "graph-limit-value";
  limitValue.className = "font-mono text-on-surface w-8";
  limitValue.textContent = "50";

  limitRange.addEventListener("input", () => {
    limitValue.textContent = limitRange.value;
  });

  limitLabel.appendChild(limitRange);
  limitLabel.appendChild(limitValue);

  const loadBtn = document.createElement("button");
  loadBtn.className = "btn btn-primary";
  loadBtn.textContent = "LOAD";
  loadBtn.addEventListener("click", loadGraph);

  const groupSelect = document.createElement("select");
  groupSelect.id    = "graph-group-id";
  groupSelect.className = "bg-surface-container border border-outline-variant/30 rounded-sm px-3 py-1.5 text-sm text-on-surface focus:border-primary focus:outline-none";

  const grpOptAll   = document.createElement("option");
  grpOptAll.value   = "";
  grpOptAll.textContent = "All groups";
  groupSelect.appendChild(grpOptAll);

  const keySelect   = document.createElement("select");
  keySelect.id      = "graph-key-id";
  keySelect.className = "bg-surface-container border border-outline-variant/30 rounded-sm px-3 py-1.5 text-sm text-on-surface focus:border-primary focus:outline-none";

  const keyOptAll   = document.createElement("option");
  keyOptAll.value   = "";
  keyOptAll.textContent = "All keys";
  keySelect.appendChild(keyOptAll);

  /** /admin/keys + /admin/groups 비동기 로딩 후 캐스케이드 구성 */
  (async () => {
    const [keysR, groupsR] = await Promise.all([api("/keys"), api("/groups")]);
    const allKeys   = (keysR.ok   && Array.isArray(keysR.data))   ? keysR.data   : [];
    const allGroups = (groupsR.ok && Array.isArray(groupsR.data)) ? groupsR.data : [];

    /** keySelect를 주어진 키 목록으로 재구성 */
    function rebuildKeySelect(keys, groupLabel) {
      keySelect.innerHTML = "";
      const first = document.createElement("option");
      first.value       = "";
      first.textContent = groupLabel ? `All (${groupLabel})` : "All keys";
      keySelect.appendChild(first);
      for (const k of keys) {
        const opt = document.createElement("option");
        opt.value       = String(k.id);
        opt.textContent = k.name || k.key_prefix || String(k.id);
        keySelect.appendChild(opt);
      }
    }

    rebuildKeySelect(allKeys, null);

    for (const g of allGroups) {
      const opt = document.createElement("option");
      opt.value       = String(g.id);
      opt.textContent = g.name || String(g.id);
      groupSelect.appendChild(opt);
    }

    /** 그룹 선택 → keySelect를 해당 그룹 키만으로 재구성 */
    groupSelect.addEventListener("change", () => {
      const gid = groupSelect.value;
      if (gid) {
        const grp       = allGroups.find(g => String(g.id) === gid);
        const filtered  = allKeys.filter(k => Array.isArray(k.groups) && k.groups.some(g => String(g.id) === gid));
        rebuildKeySelect(filtered, grp?.name ?? gid);
      } else {
        rebuildKeySelect(allKeys, null);
      }
    });
  })();

  controls.appendChild(topicInput);
  controls.appendChild(groupSelect);
  controls.appendChild(keySelect);
  controls.appendChild(limitLabel);
  controls.appendChild(loadBtn);

  /* Legend */
  const TYPE_COLORS = {
    fact: "#5b8ef0", decision: "#8b5cf6", error: "#ef4444",
    procedure: "#22c55e", preference: "#f59e0b", relation: "#6b7280",
    episode: "#ec4899"
  };
  const colorToggle = document.createElement("button");
  colorToggle.id = "graph-color-mode";
  colorToggle.className = "flex items-center gap-2 bg-transparent border border-outline-variant px-3 py-1 text-[10px] font-bold text-slate-400 hover:text-primary";
  colorToggle.textContent = "COLOR: TYPE";
  colorToggle.addEventListener("click", () => {
    colorMode = colorMode === "type" ? "agent" : "type";
    colorToggle.textContent = colorMode === "type" ? "COLOR: TYPE" : "COLOR: AGENT";
    if (applyColorModeFn) applyColorModeFn();
  });
  controls.appendChild(colorToggle);

  const legend = document.createElement("div");
  legend.id = "graph-legend";
  legend.className = "flex items-center gap-3 ml-auto";
  for (const [t, c] of Object.entries(TYPE_COLORS)) {
    const chip = document.createElement("span");
    chip.className = "flex items-center gap-1 text-xs text-slate-400";
    const dot = document.createElement("span");
    dot.className = "inline-block w-2.5 h-2.5 rounded-full";
    dot.style.backgroundColor = c;
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(t));
    legend.appendChild(chip);
  }
  controls.appendChild(legend);

  wrap.appendChild(controls);

  /* Graph Tooltip */
  const tooltip = document.createElement("div");
  tooltip.id = "graph-tooltip";
  Object.assign(tooltip.style, {
    position:      "fixed",
    display:       "none",
    maxWidth:      "280px",
    background:    "rgba(8,12,28,0.92)",
    border:        "1px solid rgba(120,160,220,0.25)",
    borderRadius:  "10px",
    padding:       "12px 14px",
    fontSize:      "12px",
    lineHeight:    "1.6",
    color:         "#d4dff0",
    backdropFilter:"blur(12px)",
    boxShadow:     "0 4px 24px rgba(0,0,0,0.6), 0 0 12px rgba(80,120,200,0.12)",
    pointerEvents: "none",
    zIndex:        "9999",
    transition:    "opacity 0.12s ease",
  });
  document.body.appendChild(tooltip);

  /* SVG Canvas */
  const canvasWrap = document.createElement("div");
  canvasWrap.style.position = "relative";
  canvasWrap.className = "glass-panel rounded-sm overflow-hidden";

  const svgNS = "http://www.w3.org/2000/svg";
  const svg   = document.createElementNS(svgNS, "svg");
  svg.id = "graph-canvas";
  svg.setAttribute("width", "100%");
  svg.style.minHeight       = "600px";
  svg.style.height          = "clamp(600px, 60vh, 1200px)";
  svg.style.backgroundColor = "#0e1322";
  canvasWrap.appendChild(svg);

  wrap.appendChild(canvasWrap);
  container.appendChild(wrap);

  /* Auto-load */
  loadGraph();
}

let _moonRafId = null; // 위성 애니메이션 rAF ID — 재로딩 시 취소

async function loadGraph() {
  if (_moonRafId !== null) { cancelAnimationFrame(_moonRafId); _moonRafId = null; }
  const topic   = document.getElementById("graph-topic")?.value   || "";
  const limit   = document.getElementById("graph-limit")?.value   || "50";
  const keyId   = document.getElementById("graph-key-id")?.value  || "";
  const groupId = document.getElementById("graph-group-id")?.value || "";

  const params = new URLSearchParams({ limit });
  if (topic)   params.set("topic",    topic);
  if (keyId)   params.set("key_id",   keyId);
  else if (groupId) params.set("group_id", groupId);

  const res = await api(`/memory/graph?${params.toString()}`);

  if (!res.ok || !res.data) {
    showToast("그래프 데이터 로딩 실패", "error");
    return;
  }
  const data = res.data;

  if (typeof d3 === "undefined") {
    showToast("D3.js가 로드되지 않았습니다", "error");
    return;
  }

  const TYPE_COLORS = {
    fact:       { base: "#5592d0", light: "#9ec4e8", dark: "#2a4f8a", link: "#4582c0" },
    decision:   { base: "#8878d0", light: "#bcb0e8", dark: "#3c2880", link: "#7868c0" },
    error:      { base: "#c05050", light: "#e49090", dark: "#701c1c", link: "#b04040" },
    procedure:  { base: "#50a870", light: "#8ccca8", dark: "#1c5835", link: "#409860" },
    preference: { base: "#d09820", light: "#e8c870", dark: "#785810", link: "#c08810" },
    relation:   { base: "#6080a0", light: "#a0b8cc", dark: "#304860", link: "#507090" },
    episode:    { base: "#b85898", light: "#dca0c8", dark: "#682858", link: "#a84888" },
  };
  const FALLBACK = TYPE_COLORS.relation;

  /**
   * 노드 밝기 계수 — 항성/행성 밝기 차이 모사
   * - anchor/pinned: 200%
   * - preference: 140%
   * - 나머지: ±30% 결정적 난수 (node id 기반)
   */
  const nodeBrightness = (d) => {
    if (d.is_anchor || d.pinned || d.anchor) return 2.0;
    if (d.type === "preference") return 1.4;
    const seed = (d.id || "").split("").reduce((a, c) => a + c.charCodeAt(0), 0);
    return 0.7 + (Math.sin(seed * 91.3 + 17.7) * 0.5 + 0.5) * 0.6; // 0.70 ~ 1.30
  };

  const svg = d3.select("#graph-canvas");
  svg.selectAll("*").remove();

  const width  = svg.node().clientWidth  || 800;
  const height = svg.node().clientHeight || 600;
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const nodeById = new Map(data.nodes.map(n => [n.id, n]));
  const nodeIds  = new Set(data.nodes.map(n => n.id));
  const links    = data.edges
    .filter(e => nodeIds.has(e.from_id) && nodeIds.has(e.to_id))
    .map(e => ({ source: e.from_id, target: e.to_id, type: e.relation_type, weight: e.weight }));

  /** G2: 인접맵 사전 구축 — hover O(L) → O(1) */
  const adjMap = new Map();
  links.forEach((l, i) => {
    const sId = typeof l.source === "object" ? l.source.id : l.source;
    const tId = typeof l.target === "object" ? l.target.id : l.target;
    if (!adjMap.has(sId)) adjMap.set(sId, new Set());
    if (!adjMap.has(tId)) adjMap.set(tId, new Set());
    adjMap.get(sId).add(i);
    adjMap.get(tId).add(i);
  });

  /** ── SVG Defs: 필터 + 그라데이션 ── */
  const defs = svg.append("defs");

  /** 노드 글로우 필터 (normal) */
  const fNodeNorm = defs.append("filter")
    .attr("id", "nodeGlow").attr("x", "-60%").attr("y", "-60%")
    .attr("width", "220%").attr("height", "220%");
  fNodeNorm.append("feGaussianBlur").attr("in", "SourceGraphic").attr("stdDeviation", "4").attr("result", "blur");
  const mNodeNorm = fNodeNorm.append("feMerge");
  mNodeNorm.append("feMergeNode").attr("in", "blur");
  mNodeNorm.append("feMergeNode").attr("in", "blur");
  mNodeNorm.append("feMergeNode").attr("in", "SourceGraphic");

  /** 노드 글로우 필터 (hover — 10% 강화) */
  const fNodeHov = defs.append("filter")
    .attr("id", "nodeGlowHover").attr("x", "-80%").attr("y", "-80%")
    .attr("width", "260%").attr("height", "260%");
  fNodeHov.append("feGaussianBlur").attr("in", "SourceGraphic").attr("stdDeviation", "6").attr("result", "blur");
  const mNodeHov = fNodeHov.append("feMerge");
  mNodeHov.append("feMergeNode").attr("in", "blur");
  mNodeHov.append("feMergeNode").attr("in", "blur");
  mNodeHov.append("feMergeNode").attr("in", "blur");
  mNodeHov.append("feMergeNode").attr("in", "SourceGraphic");

  /** 링크 글로우 필터 (normal) */
  const fLinkNorm = defs.append("filter")
    .attr("id", "linkGlow").attr("x", "-20%").attr("y", "-400%")
    .attr("width", "140%").attr("height", "900%");
  fLinkNorm.append("feGaussianBlur").attr("in", "SourceGraphic").attr("stdDeviation", "2").attr("result", "blur");
  const mLinkNorm = fLinkNorm.append("feMerge");
  mLinkNorm.append("feMergeNode").attr("in", "blur");
  mLinkNorm.append("feMergeNode").attr("in", "SourceGraphic");

  /** 링크 글로우 필터 (hover) */
  const fLinkHov = defs.append("filter")
    .attr("id", "linkGlowHover").attr("x", "-20%").attr("y", "-400%")
    .attr("width", "140%").attr("height", "900%");
  fLinkHov.append("feGaussianBlur").attr("in", "SourceGraphic").attr("stdDeviation", "3.5").attr("result", "blur");
  const mLinkHov = fLinkHov.append("feMerge");
  mLinkHov.append("feMergeNode").attr("in", "blur");
  mLinkHov.append("feMergeNode").attr("in", "blur");
  mLinkHov.append("feMergeNode").attr("in", "SourceGraphic");

  /** 성운(nebula) 방사형 그라데이션 — 매우 절제된 색조 */
  [
    ["#101828", "#070b18"],
    ["#141228", "#08060f"],
    ["#1a0f10", "#090507"],
    ["#0c1810", "#060a07"],
    ["#161108", "#090704"],
  ].forEach(([inner, outer], i) => {
    const rg = defs.append("radialGradient")
      .attr("id", `nebula-${i}`).attr("cx", "50%").attr("cy", "50%").attr("r", "50%");
    rg.append("stop").attr("offset", "0%").attr("stop-color", inner).attr("stop-opacity", "0.9");
    rg.append("stop").attr("offset", "100%").attr("stop-color", outer).attr("stop-opacity", "0");
  });

  /** 타입별 노드 방사형 그라데이션 (구형 광원 효과) */
  Object.entries(TYPE_COLORS).forEach(([type, c]) => {
    const rg = defs.append("radialGradient")
      .attr("id", `grad-${type}`).attr("cx", "35%").attr("cy", "35%").attr("r", "65%");
    rg.append("stop").attr("offset", "0%").attr("stop-color", c.light).attr("stop-opacity", "0.95");
    rg.append("stop").attr("offset", "55%").attr("stop-color", c.base);
    rg.append("stop").attr("offset", "100%").attr("stop-color", c.dark);
  });

  /** ── 배경: 은하계 스타필드 (zoom 영향 없는 고정 레이어) ── */
  const bg = svg.append("g").attr("class", "bg-layer").style("pointer-events", "none");

  /* 딥스페이스 바탕 */
  bg.append("rect").attr("width", width).attr("height", height).attr("fill", "#070b18");

  /* 성운 블롭 */
  [
    { x: width * 0.15, y: height * 0.25, rx: width * 0.35, ry: height * 0.45, idx: 0 },
    { x: width * 0.72, y: height * 0.65, rx: width * 0.30, ry: height * 0.40, idx: 1 },
    { x: width * 0.50, y: height * 0.05, rx: width * 0.25, ry: height * 0.30, idx: 2 },
    { x: width * 0.88, y: height * 0.18, rx: width * 0.20, ry: height * 0.28, idx: 3 },
    { x: width * 0.08, y: height * 0.80, rx: width * 0.22, ry: height * 0.30, idx: 4 },
  ].forEach(n => {
    bg.append("ellipse")
      .attr("cx", n.x).attr("cy", n.y).attr("rx", n.rx).attr("ry", n.ry)
      .attr("fill", `url(#nebula-${n.idx})`).attr("opacity", 0.5);
  });

  /* 별 — 결정적 의사난수(seed 기반) */
  const rng = s => { const x = Math.sin(s + 1) * 10000; return x - Math.floor(x); };
  for (let i = 0; i < 220; i++) {
    const r  = rng(i * 3 + 2) * 1.4 + 0.2;
    const op = rng(i * 7 + 5) * 0.55 + 0.15;
    bg.append("circle")
      .attr("cx", rng(i * 3 + 0) * width)
      .attr("cy", rng(i * 3 + 1) * height)
      .attr("r",  r).attr("fill", "white").attr("opacity", op);
  }
  /* 밝은 별 (글로우) */
  for (let i = 0; i < 18; i++) {
    bg.append("circle")
      .attr("cx", rng(i * 11 + 100) * width)
      .attr("cy", rng(i * 11 + 101) * height)
      .attr("r", rng(i * 11 + 102) * 1.2 + 0.8)
      .attr("fill", "white").attr("opacity", 0.85)
      .attr("filter", "url(#nodeGlow)");
  }

  /** ── zoom + pan ── */
  const zoomBehavior = d3.zoom()
    .scaleExtent([0.1, 5])
    .on("zoom", (e) => g.attr("transform", e.transform));
  svg.call(zoomBehavior);

  /** zoom 가능한 메인 그래프 레이어 */
  const g = svg.append("g");

  /** ── 행성 장식 데이터 (결정적 난수) ── */
  const fragRng  = (id, salt) => {
    const seed = (id || "").split("").reduce((a, c) => a + c.charCodeAt(0), 0);
    const x    = Math.sin(seed * salt + 1) * 10000;
    return x - Math.floor(x); // 0~1
  };
  const nodeR    = d => {
    const base   = 4 + (d.importance || 0.5) * 10;
    const jitter = 0.85 + fragRng(d.id, 127.3) * 0.30;   // ±15%
    return base * jitter;
  };

  const planetData = [];
  data.nodes.forEach(d => {
    if (d.is_anchor || d.pinned || d.anchor) return; // 항성(앵커)은 제외
    if (fragRng(d.id, 47.3) > 0.55) return;          // ~55% 노드만 행성화

    const hasRing   = fragRng(d.id, 13.7) < 0.40;
    const nMoons    = Math.floor(fragRng(d.id, 31.1) * 3.7);
    const ringTilt  = 0.16 + fragRng(d.id, 5.3)  * 0.30;       // 납작도
    const ringRot   = (fragRng(d.id, 9.1) - 0.5) * 60;         // 기울기 ±30°
    const ringSizeM = 1.7  + fragRng(d.id, 71.3) * 0.9;        // 크기 배율 1.7~2.6
    const ringWidth = 0.35 + fragRng(d.id, 83.7) * 0.9;        // 두께 0.35~1.25
    /* 색상: base/light/dark 중 가중 혼합 (밝은 쪽 편향) */
    const ringColorIdx = fragRng(d.id, 97.1);                   // 0~1
    const ringOpacity  = 0.25 + fragRng(d.id, 61.9) * 0.30;    // 투명도 0.25~0.55

    const moons = Array.from({ length: nMoons }, (_, i) => ({
      orbitR:  nodeR(d) * (1.85 + fragRng(d.id, 17.3 + i * 7) * 1.1),
      period:  5 + fragRng(d.id, 23.7 + i * 11) * 10,  // 5~15초
      phase:   fragRng(d.id, 37.1 + i * 13) * Math.PI * 2,
      r:       0.9 + fragRng(d.id, 43.3 + i * 7) * 1.4,
      yScale:  0.45 + fragRng(d.id, 59.1 + i * 3) * 0.35, // 궤도 납작도
    }));

    planetData.push({ node: d, hasRing, ringTilt, ringRot, ringSizeM, ringWidth, ringColorIdx, ringOpacity, moons });
  });

  /** 행성 장식 레이어 — 노드/링크보다 뒤에 렌더 */
  const decoG = g.append("g").attr("class", "planet-deco-layer");

  /** 고리 */
  planetData.filter(p => p.hasRing).forEach(p => {
    const r   = nodeR(p.node);
    const tc  = TYPE_COLORS[p.node.type] || FALLBACK;
    /* 색상: idx < 0.45 → light, 0.45~0.75 → base, > 0.75 → 중간 혼합 */
    const ringColor = p.ringColorIdx < 0.45 ? tc.light
                    : p.ringColorIdx < 0.75 ? tc.base
                    : tc.link;
    const ell = decoG.append("ellipse")
      .attr("data-pid", p.node.id)
      .attr("rx", r * p.ringSizeM)
      .attr("ry", r * p.ringSizeM * p.ringTilt)
      .attr("fill", "none")
      .attr("stroke", ringColor)
      .attr("stroke-width", r * p.ringWidth * 0.08 + p.ringWidth * 0.3)
      .attr("stroke-opacity", p.ringOpacity)
      .attr("filter", "url(#linkGlow)");
    p._ringEl = ell;
  });

  /** 위성 */
  const moonEntries = [];
  planetData.forEach(p => {
    const tc = TYPE_COLORS[p.node.type] || FALLBACK;
    p.moons.forEach(m => {
      const moonEl = decoG.append("circle")
        .attr("r", m.r)
        .attr("fill", tc.light)
        .attr("fill-opacity", 0.72)
        .attr("filter", "url(#nodeGlow)");
      moonEntries.push({ el: moonEl, planet: p, moon: m });
    });
  });

  /** ── Force Simulation ── */
  const chargeStrength = data.nodes.length > 80 ? -80 : data.nodes.length > 30 ? -150 : -200;

  const sim = d3.forceSimulation(data.nodes)
    .alphaDecay(0.05)
    .force("link",    d3.forceLink(links).id(d => d.id).distance(80))
    .force("charge",  d3.forceManyBody().strength(chargeStrength))
    .force("center",  d3.forceCenter(width / 2, height / 2))
    .force("collide", d3.forceCollide().radius(d => 8 + (d.importance || 0.5) * 10));

  /** 링크 색상 헬퍼 — 소스 노드 타입 기준 */
  const linkColor = (d) => {
    const srcId   = typeof d.source === "object" ? d.source.id : d.source;
    const srcType = nodeById.get(srcId)?.type;
    return (TYPE_COLORS[srcType] || FALLBACK).link;
  };

  /** ── 링크 레이어 ── */
  const linkGroup = g.append("g");

  /* 글로우 후광 (블러 레이어) */
  const linkGlow = linkGroup.selectAll("line.lg")
    .data(links).join("line").attr("class", "lg")
    .attr("stroke", linkColor)
    .attr("stroke-opacity", 0.22)
    .attr("stroke-width", d => Math.min(8, (d.weight || 1) * 2.5))
    .attr("filter", "url(#linkGlow)");

  /* 코어 라인 */
  const link = linkGroup.selectAll("line.lc")
    .data(links).join("line").attr("class", "lc")
    .attr("stroke", linkColor)
    .attr("stroke-opacity", 0.45)
    .attr("stroke-width", d => Math.min(2.5, d.weight || 1));

  /** ── 노드 레이어 ── */
  const nodeGroup = g.append("g");

  /* 외곽 헤일로 링 — brightness 반영 opacity, 반경 ±10% 랜덤 */
  const halo = nodeGroup.selectAll("circle.hl")
    .data(data.nodes).join("circle").attr("class", "hl")
    .attr("r", d => {
      const seed   = (d.id || "").split("").reduce((a, c) => a + c.charCodeAt(0), 0);
      const jitter = 0.9 + (Math.sin(seed * 53.7 + 9.1) * 0.5 + 0.5) * 0.2; // 0.90 ~ 1.10
      return (4 + (d.importance || 0.5) * 10) * 1.7 * jitter;
    })
    .attr("fill", "none")
    .attr("stroke", d => (TYPE_COLORS[d.type] || FALLBACK).base)
    .attr("stroke-width", 1.2)
    .attr("stroke-opacity", d => Math.min(0.92, 0.28 * nodeBrightness(d)))
    .attr("filter", "url(#nodeGlow)")
    .style("pointer-events", "none");

  /* 노드 본체 — 방사형 그라데이션 + CSS brightness */
  const node = nodeGroup.selectAll("circle.nd")
    .data(data.nodes).join("circle").attr("class", "nd")
    .attr("r", d => 4 + (d.importance || 0.5) * 10)
    .attr("fill", d => `url(#grad-${d.type in TYPE_COLORS ? d.type : "relation"})`)
    .attr("stroke", d => (TYPE_COLORS[d.type] || FALLBACK).light)
    .attr("stroke-width", 1)
    .attr("stroke-opacity", 0.75)
    .style("filter", d => `brightness(${nodeBrightness(d)})`)
    .style("cursor", "grab")
    .call(d3.drag()
      .on("start", (e, d) => {
        if (!e.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
        /** G1c: 드래그 시 blur 필터 비활성화 */
        node.attr("filter", null);
        halo.attr("filter", null).attr("stroke-opacity", 0);
        linkGlow.attr("stroke-opacity", 0);
        labels.attr("display", "none");
        /** G3c: 드래그 시 위성 rAF 정지 */
        if (_moonRafId !== null) { cancelAnimationFrame(_moonRafId); _moonRafId = null; }
      })
      .on("drag",  (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on("end",   (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
    );

  /** ── 툴팁 (renderGraph 스코프 외부 → getElementById로 참조) ── */
  const tooltip = document.getElementById("graph-tooltip");

  /** ── 툴팁 헬퍼 (DOM API — XSS 안전) ── */
  const TYPE_LABEL = {
    fact: "사실", decision: "의사결정", error: "오류",
    procedure: "절차", preference: "선호", relation: "관계", episode: "에피소드",
  };
  const relTime = (iso) => {
    if (!iso) return null;
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1)  return "방금";
    if (m < 60) return `${m}분 전`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}시간 전`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}일 전`;
    return `${Math.floor(d / 30)}개월 전`;
  };
  const bar = (v) => {
    const n = Math.round(Math.min(Math.max(v, 0), 1) * 10);
    return "█".repeat(n) + "░".repeat(10 - n);
  };
  const connCount = (nid) => adjMap.get(nid)?.size || 0;

  const mk = (tag, css = {}, txt = null) => {
    const el = document.createElement(tag);
    Object.assign(el.style, css);
    if (txt !== null) el.textContent = txt;
    return el;
  };

  /** 색상 모드 적용: type(그라데이션) ↔ agent(agent_id 해시 색) */
  applyColorModeFn = () => {
    if (colorMode === "agent") {
      node
        .attr("fill", d => agentColor(d.agent_id))
        .attr("stroke", d => agentColor(d.agent_id));
      halo.attr("stroke", d => agentColor(d.agent_id));
    } else {
      node
        .attr("fill", d => `url(#grad-${d.type in TYPE_COLORS ? d.type : "relation"})`)
        .attr("stroke", d => (TYPE_COLORS[d.type] || FALLBACK).light);
      halo.attr("stroke", d => (TYPE_COLORS[d.type] || FALLBACK).base);
    }

    /** 범례 갱신: agent 모드면 노드에 존재하는 agent_id 상위 8개 */
    const legendEl = document.getElementById("graph-legend");
    if (legendEl) {
      legendEl.textContent = "";
      const entries = colorMode === "agent"
        ? [...new Set(data.nodes.map(n => n.agent_id ?? "default"))].slice(0, 8).map(a => [a, agentColor(a)])
        : Object.entries({
            fact: "#5b8ef0", decision: "#8b5cf6", error: "#ef4444",
            procedure: "#22c55e", preference: "#f59e0b", relation: "#6b7280",
            episode: "#ec4899"
          });
      for (const [t, c] of entries) {
        const chip = document.createElement("span");
        chip.className = "flex items-center gap-1 text-xs text-slate-400";
        const dot = document.createElement("span");
        dot.className = "inline-block w-2.5 h-2.5 rounded-full";
        dot.style.backgroundColor = c;
        chip.appendChild(dot);
        chip.appendChild(document.createTextNode(String(t)));
        legendEl.appendChild(chip);
      }
    }
  };
  applyColorModeFn();

  const showTooltipFor = (d, event) => {
    if (!tooltip) return;
    while (tooltip.firstChild) tooltip.removeChild(tooltip.firstChild);

    const tc  = TYPE_COLORS[d.type] || FALLBACK;
    const imp = (d.importance || 0).toFixed(2);
    const act = d.ema_activation != null ? d.ema_activation.toFixed(2) : null;

    /* 타입 배지 */
    tooltip.appendChild(mk("span", {
      display: "inline-block", background: `${tc.base}22`,
      border: `1px solid ${tc.base}88`, borderRadius: "4px",
      padding: "1px 7px", fontSize: "11px", color: tc.light, letterSpacing: ".05em",
    }, (TYPE_LABEL[d.type] || d.type).toUpperCase()));

    /* 토픽 */
    if (d.topic) tooltip.appendChild(
      mk("div", { color: "#7090b0", fontSize: "11px", marginTop: "3px" }, d.topic)
    );

    /* 기여 에이전트 */
    if (d.agent_id) tooltip.appendChild(
      mk("div", { color: agentColor(d.agent_id), fontSize: "10px", marginTop: "2px" }, `agent: ${d.agent_id}`)
    );

    /* 내용 */
    const rawText = d.content || d.label;
    const shown   = rawText.slice(0, 300) + (rawText.length > 300 ? "…" : "");
    tooltip.appendChild(mk("div", {
      margin: "6px 0 4px", color: "#e0eaf8", fontSize: "12px", lineHeight: "1.5",
    }, shown));

    /* 통계 그리드 */
    const grid = mk("div", {
      borderTop: "1px solid rgba(120,160,220,0.15)", margin: "6px 0 0", paddingTop: "6px",
      display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 12px", fontSize: "11px",
    });
    const row = (label, val, mono = false) => {
      grid.appendChild(mk("span", { color: "#8090b0" }, label));
      grid.appendChild(mk("span", { color: "#b0c0d8", fontFamily: mono ? "monospace" : "" }, val));
    };
    row("중요도", `${bar(parseFloat(imp))} ${imp}`, true);
    row("활성화", act ? `${bar(parseFloat(act))} ${act}` : "—", true);
    row("연결",   `${connCount(d.id)}개`);
    row("조회",   `${d.access_count ?? 0}회`);
    const ct = relTime(d.created_at);
    if (ct) row("생성", ct);
    const at = relTime(d.accessed_at);
    if (at) row("최근 조회", at);
    if (d.session_id) row("세션", d.session_id.slice(0, 16) + "…");
    tooltip.appendChild(grid);

    /* 에피소드 context_summary */
    if (d.context_summary) {
      const cs = d.context_summary.slice(0, 120) + (d.context_summary.length > 120 ? "…" : "");
      tooltip.appendChild(mk("div", {
        fontSize: "11px", color: "#6878a0", marginTop: "6px", fontStyle: "italic",
      }, cs));
    }

    tooltip.style.display = "block";
    const pad = 16, tw = 296;
    const th  = tooltip.offsetHeight || 180;
    let   tx  = event.clientX + 14;
    let   ty  = event.clientY - 10;
    if (tx + tw > window.innerWidth  - pad) tx = event.clientX - tw - 14;
    if (ty + th > window.innerHeight - pad) ty = event.clientY - th + 10;
    tooltip.style.left = `${tx}px`;
    tooltip.style.top  = `${ty}px`;
  };

  /** ── Hover: 10% 강화 글로우 + 툴팁 ── */
  node
    .on("mouseover", function (e, d) {
      const br = Math.min(nodeBrightness(d) * 1.1, 2.2);
      d3.select(this).style("filter", `brightness(${br})`).attr("stroke-opacity", 1);
      halo.filter(h => h.id === d.id)
        .attr("stroke-opacity", Math.min(0.95, 0.28 * br * 1.5))
        .attr("filter", "url(#nodeGlowHover)");
      const connIdx = adjMap.get(d.id);
      if (connIdx) {
        connIdx.forEach(i => {
          link.filter((_, j) => j === i).attr("stroke-opacity", 0.90).attr("filter", "url(#linkGlowHover)");
          linkGlow.filter((_, j) => j === i).attr("stroke-opacity", 0.50);
        });
      }
      showTooltipFor(d, e);
    })
    .on("mousemove", (e, d) => showTooltipFor(d, e))
    .on("mouseout", function (e, d) {
      const br = nodeBrightness(d);
      d3.select(this).style("filter", `brightness(${br})`).attr("stroke-opacity", 0.75);
      halo.filter(h => h.id === d.id)
        .attr("stroke-opacity", Math.min(0.92, 0.28 * br))
        .attr("filter", "url(#nodeGlow)");
      link.attr("stroke-opacity", 0.45).attr("filter", null);
      linkGlow.attr("stroke-opacity", 0.22);
      tooltip.style.display = "none";
    });

  /** ── 레이블 ── */
  const labels = g.append("g")
    .selectAll("text")
    .data(data.nodes).join("text")
    .text(d => d.label.slice(0, 20))
    .attr("font-size", "10px")
    .attr("fill", "#cbd5e1")
    .attr("dx", 12).attr("dy", 4)
    .style("pointer-events", "none");

  /** G1a: 시뮬레이션 중 blur 필터 비활성화 — GPU 재계산 방지 */
  node.attr("filter", null);
  halo.attr("filter", null).attr("stroke-opacity", 0);
  linkGlow.attr("stroke-opacity", 0);
  labels.attr("display", "none");

  /** ── Tick ── */
  sim.on("tick", () => {
    linkGlow
      .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    link
      .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    node.attr("cx",  d => d.x).attr("cy",  d => d.y);
    halo.attr("cx",  d => d.x).attr("cy",  d => d.y);
    labels.attr("x", d => d.x).attr("y",   d => d.y);
    /* G4a: 고리 위치 — tick에서는 cx/cy만 (rotate는 sim.on("end")에서 1회) */
    planetData.filter(p => p._ringEl).forEach(p => {
      p._ringEl.attr("cx", p.node.x ?? 0).attr("cy", p.node.y ?? 0);
    });
  });

  /** ── 위성 자전 애니메이션 (rAF) ── */
  const _rafStart = performance.now();
  const _animateMoons = (now) => {
    const t = (now - _rafStart) / 1000; // 초
    moonEntries.forEach(({ el, planet, moon }) => {
      const nx    = planet.node.x ?? 0;
      const ny    = planet.node.y ?? 0;
      const angle = moon.phase + (t / moon.period) * Math.PI * 2;
      el.attr("cx", nx + moon.orbitR * Math.cos(angle))
        .attr("cy", ny + moon.orbitR * Math.sin(angle) * moon.yScale);
    });
    _moonRafId = requestAnimationFrame(_animateMoons);
  };
  /** G3a: 시뮬레이션 중 위성 rAF 시작 금지 — sim.on("end")에서 시작 */

  /** 초기 줌: simulation 안정 후 전체 노드가 보이도록 fit */
  sim.on("end", () => {
    /** G1b: 필터 복원 */
    node.style("filter", d => `brightness(${nodeBrightness(d)})`);
    halo.attr("filter", "url(#nodeGlow)")
        .attr("stroke-opacity", d => Math.min(0.92, 0.28 * nodeBrightness(d)));
    linkGlow.attr("stroke-opacity", 0.22);
    labels.attr("display", null);

    /** G4a: ring rotate 1회 적용 */
    planetData.filter(p => p._ringEl).forEach(p => {
      p._ringEl.attr("transform", `rotate(${p.ringRot},${p.node.x ?? 0},${p.node.y ?? 0})`);
    });

    const bounds = g.node().getBBox();
    if (bounds.width === 0 || bounds.height === 0) return;
    const pad    = 40;
    const scale  = Math.min(
      width  / (bounds.width  + pad * 2),
      height / (bounds.height + pad * 2),
      1.5
    );
    const tx = width  / 2 - (bounds.x + bounds.width  / 2) * scale;
    const ty = height / 2 - (bounds.y + bounds.height / 2) * scale;
    svg.transition().duration(500)
      .call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));

    /** G3b: 시뮬레이션 완료 후 위성 애니메이션 시작 */
    if (moonEntries.length > 0 && _moonRafId === null) {
      _moonRafId = requestAnimationFrame(_animateMoons);
    }
  });

  const statsEl = document.getElementById("graph-stats");
  if (statsEl) {
    statsEl.textContent = `${data.nodes.length} nodes, ${links.length} edges`;
  }

  /** G3d: 탭 숨김 시 위성 rAF 정지 / 복귀 시 재개 */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && _moonRafId !== null) {
      cancelAnimationFrame(_moonRafId);
      _moonRafId = null;
    } else if (!document.hidden && moonEntries.length > 0 && _moonRafId === null) {
      _moonRafId = requestAnimationFrame(_animateMoons);
    }
  });
}

export { renderGraph, loadGraph };
