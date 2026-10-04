import {
  buildGalaxyLayout,
  galaxyLod,
  selectGalaxyEdges,
  stableUnit
} from "./galaxy-model.js";

const AGENT_PALETTE = ["#d7b56d", "#79a9dc", "#7cbd91", "#d98272", "#a391ca", "#70bab5", "#cdb681", "#c27f9f"];
const DISTANT_INK = "#9db0c8";
const DISTANT_CORE = "#e4d6ae";

function agentColor(agentId) {
  return AGENT_PALETTE[Math.floor(stableUnit(agentId ?? "default", "agent") * AGENT_PALETTE.length) % AGENT_PALETTE.length];
}

function hexAlpha(hex, alpha) {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function screenPoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}

function tooltipContent(tooltip, node, degree) {
  tooltip.textContent = "";
  const add = (tag, text, style = {}) => {
    const el = document.createElement(tag);
    el.textContent = text;
    Object.assign(el.style, style);
    tooltip.appendChild(el);
  };
  add("div", `${node._celestial.kind.toUpperCase()} · ${(node.type || "relation").toUpperCase()}`, {
    color: node._celestial.palette[2], fontSize: "10px", letterSpacing: ".09em", fontWeight: "700"
  });
  if (node.topic) add("div", node.topic, { color: "#7893aa", fontSize: "11px", marginTop: "2px" });
  add("div", node.content || node.label || "", { color: "#e2ebf4", marginTop: "7px", lineHeight: "1.5" });
  add("div", `중요도 ${Number(node.importance || 0).toFixed(2)}  ·  연결 ${degree}개`, {
    color: "#91a2b8", marginTop: "8px", paddingTop: "6px", borderTop: "1px solid rgba(130,170,210,.16)"
  });
}

/** Canvas 한 장에서 수천 노드를 그리는 은하 LOD 렌더러. */
export function renderGalaxyCanvas(canvas, data, { colorMode = "type" } = {}) {
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!ctx) throw new Error("Canvas 2D context is unavailable");

  const nodes = data.nodes;
  const systems = buildGalaxyLayout(nodes);
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const nodeIds = new Set(nodeById.keys());
  const edgeLimit = Math.min(60000, Math.max(3000, nodes.length * 8));
  const edges = selectGalaxyEdges(data.edges, nodeIds, edgeLimit).map(edge => ({
    ...edge,
    source: nodeById.get(edge.from_id),
    target: nodeById.get(edge.to_id)
  }));
  const adjacency = new Map(nodes.map(node => [node.id, new Set()]));
  const incidentEdges = new Map(nodes.map(node => [node.id, []]));
  edges.forEach((edge, index) => {
    adjacency.get(edge.from_id)?.add(edge.to_id);
    adjacency.get(edge.to_id)?.add(edge.from_id);
    incidentEdges.get(edge.from_id)?.push(index);
    incidentEdges.get(edge.to_id)?.push(index);
  });

  const systemEdges = new Map();
  for (const edge of edges) {
    const a = edge.source?._system;
    const b = edge.target?._system;
    if (!a || !b || a === b) continue;
    const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    systemEdges.set(key, (systemEdges.get(key) || 0) + 1);
  }
  const systemByKey = new Map(systems.map(system => [system.key, system]));
  const starfield = Array.from({ length: 420 }, (_, index) => ({
    x: stableUnit(index, "star-x"),
    y: stableUnit(index, "star-y"),
    r: 0.2 + stableUnit(index, "star-r") * 1.15,
    a: 0.12 + stableUnit(index, "star-a") * 0.56,
    depth: 0.25 + stableUnit(index, "star-depth") * 0.75
  }));

  const tooltip = document.getElementById("graph-tooltip");
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  let mode = colorMode;
  let width = 800;
  let height = 600;
  let dpr = 1;
  let transform = d3.zoomIdentity;
  let hovered = null;
  let selected = null;
  let dragged = null;
  let dragPointerId = null;
  let visibleFrameNodes = [];
  let rafId = null;
  let loopId = null;
  let destroyed = false;
  let fitted = false;
  let lastFrame = 0;
  let lastLod = "systems";

  const nodeColor = node => mode === "agent" ? agentColor(node.agent_id) : node._celestial.palette[0];

  function scheduleDraw() {
    if (rafId !== null || destroyed) return;
    rafId = requestAnimationFrame(time => {
      rafId = null;
      draw(time);
    });
  }

  function fitGraph() {
    if (!systems.length || !width || !height) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const system of systems) {
      minX = Math.min(minX, system.x - system.radius);
      minY = Math.min(minY, system.y - system.radius);
      maxX = Math.max(maxX, system.x + system.radius);
      maxY = Math.max(maxY, system.y + system.radius);
    }
    const graphWidth = Math.max(100, maxX - minX + 180);
    const graphHeight = Math.max(100, maxY - minY + 180);
    const scale = Math.max(0.035, Math.min(1.15, width / graphWidth, height / graphHeight));
    transform = d3.zoomIdentity
      .translate(width / 2 - ((minX + maxX) / 2) * scale, height / 2 - ((minY + maxY) / 2) * scale)
      .scale(scale);
    fitted = true;
    d3.select(canvas).call(zoom.transform, transform);
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, Math.floor(rect.width || 800));
    height = Math.max(1, Math.floor(rect.height || 600));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    if (!fitted) fitGraph();
    scheduleDraw();
  }

  function drawBackground(time) {
    const base = ctx.createRadialGradient(width * 0.46, height * 0.4, 0, width * 0.5, height * 0.48, Math.max(width, height) * 0.78);
    base.addColorStop(0, "#111827");
    base.addColorStop(0.42, "#070c16");
    base.addColorStop(1, "#02040a");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(width * 0.48, height * 0.52);
    ctx.rotate(-0.28);
    const band = ctx.createLinearGradient(0, -height * 0.34, 0, height * 0.34);
    band.addColorStop(0, "rgba(40,57,79,0)");
    band.addColorStop(0.38, "rgba(68,82,103,.025)");
    band.addColorStop(0.5, "rgba(171,181,194,.065)");
    band.addColorStop(0.62, "rgba(62,79,104,.025)");
    band.addColorStop(1, "rgba(30,44,65,0)");
    ctx.fillStyle = band;
    ctx.fillRect(-width, -height, width * 2, height * 2);
    ctx.restore();

    for (let index = 0; index < starfield.length; index++) {
      const star = starfield[index];
      const pulse = reducedMotion ? 1 : 0.9 + Math.sin(time * 0.00055 * star.depth + index) * 0.1;
      const parallaxX = transform.x * 0.006 * star.depth;
      const parallaxY = transform.y * 0.006 * star.depth;
      const x = (star.x * width + parallaxX) % width;
      const y = (star.y * height + parallaxY) % height;
      ctx.globalAlpha = star.a * pulse;
      ctx.fillStyle = index % 29 === 0 ? "#d6e5f5" : "#aeb8c5";
      ctx.beginPath();
      ctx.arc(x < 0 ? x + width : x, y < 0 ? y + height : y, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function isSystemVisible(system, margin = 80) {
    const sx = system.x * transform.k + transform.x;
    const sy = system.y * transform.k + transform.y;
    const radius = system.radius * transform.k;
    return sx + radius >= -margin && sy + radius >= -margin && sx - radius <= width + margin && sy - radius <= height + margin;
  }

  function positionNode(node, time) {
    if (!node._orbit || node._manual || reducedMotion) return { x: node.x, y: node.y };
    const system = systemByKey.get(node._system);
    if (!system) return { x: node.x, y: node.y };
    const orbit = node._orbit;
    const speed = 0.000012 / Math.sqrt(orbit.ring);
    const angle = orbit.angle + orbit.direction * time * speed;
    const ox = Math.cos(angle) * orbit.radius;
    const oy = Math.sin(angle) * orbit.radius * orbit.eccentricity;
    return {
      x: system.x + ox * Math.cos(orbit.rotation) - oy * Math.sin(orbit.rotation),
      y: system.y + ox * Math.sin(orbit.rotation) + oy * Math.cos(orbit.rotation)
    };
  }

  function prepareVisibleNodes(visibleSystems, time) {
    const visible = [];
    for (const system of visibleSystems) {
      for (const node of system.members) {
        const pos = positionNode(node, time);
        node._drawX = pos.x;
        node._drawY = pos.y;
        const sx = pos.x * transform.k + transform.x;
        const sy = pos.y * transform.k + transform.y;
        if (sx >= -60 && sy >= -60 && sx <= width + 60 && sy <= height + 60) visible.push(node);
      }
    }
    return visible;
  }

  function drawNebula(system, strong = false) {
    const radius = system.radius * (strong ? 1.08 : 0.86);
    const glow = ctx.createRadialGradient(system.x, system.y, 0, system.x, system.y, radius);
    glow.addColorStop(0, strong ? "rgba(110,137,169,.11)" : "rgba(89,112,143,.055)");
    glow.addColorStop(0.48, "rgba(56,72,98,.028)");
    glow.addColorStop(1, "rgba(19,28,44,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.ellipse(system.x, system.y, radius, radius * 0.58, -0.25, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawSystemView(visibleSystems, time) {
    ctx.lineCap = "round";
    ctx.lineWidth = 0.75 / transform.k;
    for (const [key, count] of systemEdges) {
      const [a, b] = key.split("\u0000");
      const from = systemByKey.get(a);
      const to = systemByKey.get(b);
      if (!from || !to || (!isSystemVisible(from) && !isSystemVisible(to))) continue;
      ctx.strokeStyle = `rgba(95,115,140,${Math.min(0.2, 0.025 + Math.log2(count + 1) * 0.025)})`;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }

    visibleSystems.forEach((system, index) => {
      drawNebula(system, index < 5);
      const importance = Number(system.members[0]?.importance || 0.5);
      const radius = (4.5 + Math.log2(system.members.length + 1) * 1.45) / transform.k;
      const pulse = reducedMotion ? 1 : 0.94 + Math.sin(time * 0.001 + stableUnit(system.key, "pulse") * 8) * 0.06;
      ctx.save();
      ctx.translate(system.x, system.y);
      ctx.rotate(time * 0.000015 * (index % 2 ? -1 : 1));
      ctx.strokeStyle = `rgba(137,157,181,${0.16 + Math.min(0.18, system.members.length / 180)})`;
      ctx.lineWidth = 0.7 / transform.k;
      ctx.beginPath();
      ctx.ellipse(0, 0, radius * 3.7, radius * 1.12, -0.22, 0, Math.PI * 1.72);
      ctx.stroke();
      ctx.restore();

      ctx.shadowColor = "rgba(150,180,214,.72)";
      ctx.shadowBlur = 12 / transform.k;
      const core = ctx.createRadialGradient(system.x - radius * 0.24, system.y - radius * 0.24, 0, system.x, system.y, radius * pulse);
      core.addColorStop(0, importance > 0.75 ? "#fff1c6" : "#e4e9ed");
      core.addColorStop(0.35, importance > 0.75 ? DISTANT_CORE : "#b8c3cf");
      core.addColorStop(1, DISTANT_INK);
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(system.x, system.y, radius * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      if (index < 24 || system.members.length >= 20) {
        ctx.fillStyle = index < 6 ? "rgba(220,226,232,.9)" : "rgba(160,174,192,.72)";
        ctx.font = `${(index < 6 ? 11.5 : 10.5) / transform.k}px ui-monospace, monospace`;
        ctx.fillText(`${system.key}  ${system.members.length}`, system.x + 13 / transform.k, system.y + 4 / transform.k);
      }
    });
  }

  function drawOrbitPaths(visibleSystems) {
    ctx.save();
    for (const system of visibleSystems) {
      if (transform.k < 0.38) continue;
      ctx.strokeStyle = "rgba(142,160,184,.09)";
      ctx.lineWidth = 0.7 / transform.k;
      for (const orbit of system.orbits) {
        ctx.save();
        ctx.translate(system.x, system.y);
        ctx.rotate(orbit.rotation);
        ctx.beginPath();
        ctx.ellipse(0, 0, orbit.radius, orbit.radius * orbit.eccentricity, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      if (transform.k > 0.55) {
        ctx.fillStyle = "rgba(174,188,205,.48)";
        ctx.font = `${9.5 / transform.k}px ui-monospace, monospace`;
        ctx.fillText(system.key.toUpperCase(), system.x + 14 / transform.k, system.y - 15 / transform.k);
      }
    }
    ctx.restore();
  }

  function drawSimpleNode(node, emphasized) {
    const style = node._celestial;
    const color = nodeColor(node);
    const r = Math.max(1.6 / transform.k, style.radius * (emphasized ? 1.18 : 1));
    ctx.shadowColor = hexAlpha(color, style.anchor ? 0.7 : emphasized ? 0.55 : 0.2);
    ctx.shadowBlur = (style.anchor ? 12 : emphasized ? 8 : 3) / transform.k;
    const body = ctx.createRadialGradient(node._drawX - r * 0.3, node._drawY - r * 0.35, 0, node._drawX, node._drawY, r);
    body.addColorStop(0, style.palette[2]);
    body.addColorStop(0.38, color);
    body.addColorStop(1, style.palette[1]);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(node._drawX, node._drawY, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function drawRing(style, r, front) {
    ctx.save();
    ctx.rotate(-0.32 + style.variant * 0.16);
    ctx.strokeStyle = hexAlpha(style.palette[2], front ? 0.62 : 0.24);
    ctx.lineWidth = Math.max(0.65, r * 0.1);
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.85, r * 0.43, 0, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawDetailedNode(node, time, emphasized) {
    const style = node._celestial;
    const color = nodeColor(node);
    const r = style.radius * (emphasized ? 1.14 : 1);
    ctx.save();
    ctx.translate(node._drawX, node._drawY);

    if (style.kind === "star" || style.kind === "pulsar") {
      const pulse = reducedMotion ? 1 : 1 + Math.sin(time * 0.0022 + stableUnit(node.id, "pulse") * 8) * 0.07;
      ctx.save();
      ctx.rotate(reducedMotion ? 0 : time * 0.00009 * (style.kind === "pulsar" ? 1 : 0.35));
      ctx.strokeStyle = hexAlpha(style.palette[2], style.kind === "pulsar" ? 0.3 : 0.17);
      ctx.lineWidth = 0.65;
      const rays = style.kind === "pulsar" ? 4 : 10;
      for (let index = 0; index < rays; index++) {
        const angle = (index / rays) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * r * 1.18, Math.sin(angle) * r * 1.18);
        ctx.lineTo(Math.cos(angle) * r * (style.kind === "pulsar" ? 3.1 : 1.85), Math.sin(angle) * r * (style.kind === "pulsar" ? 3.1 : 1.85));
        ctx.stroke();
      }
      ctx.restore();
      ctx.shadowColor = color;
      ctx.shadowBlur = 18;
      const star = ctx.createRadialGradient(-r * 0.28, -r * 0.32, 0, 0, 0, r * pulse);
      star.addColorStop(0, "#fffbe9");
      star.addColorStop(0.26, style.palette[2]);
      star.addColorStop(0.68, color);
      star.addColorStop(1, style.palette[1]);
      ctx.fillStyle = star;
      ctx.beginPath();
      ctx.arc(0, 0, r * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    } else {
      if (style.hasRing) drawRing(style, r, false);
      ctx.shadowColor = hexAlpha(color, 0.42);
      ctx.shadowBlur = emphasized ? 15 : 8;
      const atmosphere = ctx.createRadialGradient(0, 0, r * 0.72, 0, 0, r * 1.28);
      atmosphere.addColorStop(0, hexAlpha(color, 0));
      atmosphere.addColorStop(0.78, hexAlpha(color, 0.11));
      atmosphere.addColorStop(1, hexAlpha(style.palette[2], 0));
      ctx.fillStyle = atmosphere;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.28, 0, Math.PI * 2);
      ctx.fill();

      const body = ctx.createRadialGradient(-r * 0.36, -r * 0.42, r * 0.04, 0, 0, r);
      body.addColorStop(0, style.palette[2]);
      body.addColorStop(0.42, color);
      body.addColorStop(1, style.palette[1]);
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.clip();
      if (style.kind === "gas" || style.kind === "orbital") {
        ctx.strokeStyle = hexAlpha(style.palette[2], 0.32);
        ctx.lineWidth = Math.max(0.65, r * 0.1);
        for (let index = -2; index <= 2; index++) {
          ctx.beginPath();
          ctx.moveTo(-r, index * r * 0.28);
          ctx.bezierCurveTo(-r * 0.2, index * r * 0.38, r * 0.25, index * r * 0.18, r, index * r * 0.29);
          ctx.stroke();
        }
        if (style.kind === "gas") {
          ctx.fillStyle = hexAlpha(style.palette[1], 0.34);
          ctx.beginPath();
          ctx.ellipse(r * 0.28, r * 0.14, r * 0.22, r * 0.11, -0.15, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (style.kind === "rocky" || style.kind === "dwarf") {
        ctx.fillStyle = hexAlpha(style.palette[1], 0.35);
        for (let index = 0; index < 4; index++) {
          const angle = stableUnit(node.id, `crater-${index}`) * Math.PI * 2;
          const cr = r * (0.07 + stableUnit(node.id, `crater-r-${index}`) * 0.11);
          ctx.beginPath();
          ctx.arc(Math.cos(angle) * r * 0.56, Math.sin(angle) * r * 0.56, cr, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (style.kind === "ice") {
        ctx.strokeStyle = "rgba(232,249,255,.48)";
        ctx.lineWidth = 0.55;
        ctx.beginPath();
        ctx.moveTo(-r * 0.7, -r * 0.12);
        ctx.lineTo(-r * 0.15, r * 0.12);
        ctx.lineTo(r * 0.16, -r * 0.3);
        ctx.lineTo(r * 0.66, r * 0.18);
        ctx.stroke();
      } else if (style.kind === "garden") {
        ctx.fillStyle = "rgba(43,104,75,.34)";
        ctx.beginPath();
        ctx.ellipse(-r * 0.18, r * 0.12, r * 0.65, r * 0.28, -0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(182,238,209,.35)";
        ctx.lineWidth = Math.max(0.6, r * 0.08);
        ctx.beginPath();
        ctx.arc(-r * 0.12, r * 0.1, r * 0.72, Math.PI * 1.07, Math.PI * 1.72);
        ctx.stroke();
      }
      const shade = ctx.createRadialGradient(r * 0.72, r * 0.62, r * 0.05, r * 0.42, r * 0.34, r * 1.38);
      shade.addColorStop(0, "rgba(0,0,0,.78)");
      shade.addColorStop(0.5, "rgba(0,0,0,.16)");
      shade.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = shade;
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.restore();

      ctx.strokeStyle = hexAlpha(style.palette[2], 0.45);
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.arc(0, 0, r - 0.35, Math.PI * 0.7, Math.PI * 1.75);
      ctx.stroke();
      if (style.hasRing) drawRing(style, r, true);

      for (let index = 0; index < style.moonCount; index++) {
        const orbit = r * (1.75 + index * 0.42);
        const angle = stableUnit(node.id, `moon-${index}`) * Math.PI * 2 + (reducedMotion ? 0 : time * 0.00022 * (index + 1));
        if (emphasized) {
          ctx.strokeStyle = "rgba(175,190,207,.18)";
          ctx.lineWidth = 0.45;
          ctx.beginPath();
          ctx.ellipse(0, 0, orbit, orbit * 0.55, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = style.palette[2];
        ctx.globalAlpha = 0.72;
        ctx.beginPath();
        ctx.arc(Math.cos(angle) * orbit, Math.sin(angle) * orbit * 0.55, Math.max(0.72, r * 0.095), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    if (emphasized) {
      ctx.strokeStyle = "rgba(238,244,250,.82)";
      ctx.lineWidth = 1 / transform.k;
      ctx.beginPath();
      ctx.arc(0, 0, r + 4 / transform.k, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawEdges(visibleNodes, lod) {
    const visibleIds = new Set(visibleNodes.map(node => node.id));
    const drawn = new Set();
    const focusId = hovered?.id || selected?.id;
    for (const node of visibleNodes) {
      for (const index of incidentEdges.get(node.id) || []) {
        if (drawn.has(index)) continue;
        drawn.add(index);
        const edge = edges[index];
        if (!edge.source || !edge.target || !visibleIds.has(edge.source.id) || !visibleIds.has(edge.target.id)) continue;
        const active = focusId && (edge.source.id === focusId || edge.target.id === focusId);
        if (focusId && !active && lod === "detail") continue;
        ctx.strokeStyle = active ? "rgba(182,211,236,.72)" : "rgba(91,111,137,.2)";
        ctx.lineWidth = (active ? 1.45 : Math.min(0.9, Number(edge.weight) || 0.55)) / transform.k;
        ctx.beginPath();
        ctx.moveTo(edge.source._drawX, edge.source._drawY);
        ctx.lineTo(edge.target._drawX, edge.target._drawY);
        ctx.stroke();
      }
    }
  }

  function drawNavigationHint(text) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "center";
    const textWidth = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(4,8,15,.66)";
    ctx.fillRect(width / 2 - textWidth / 2 - 12, height - 35, textWidth + 24, 22);
    ctx.fillStyle = "rgba(164,180,199,.62)";
    ctx.fillText(text, width / 2, height - 20);
    ctx.textAlign = "start";
  }

  function draw(time = performance.now()) {
    if (destroyed) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawBackground(time);

    lastLod = galaxyLod(transform.k, nodes.length);
    const visibleSystems = systems.filter(system => isSystemVisible(system));
    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);
    if (lastLod === "systems") {
      drawSystemView(visibleSystems, time);
      ctx.restore();
      visibleFrameNodes = [];
      drawNavigationHint("SCROLL TO DESCEND  ·  DOUBLE-CLICK A SYSTEM");
      return;
    }

    visibleSystems.forEach(system => drawNebula(system));
    drawOrbitPaths(visibleSystems);
    visibleFrameNodes = prepareVisibleNodes(visibleSystems, time);
    drawEdges(visibleFrameNodes, lastLod);

    const focusId = hovered?.id || selected?.id;
    const neighbors = focusId ? adjacency.get(focusId) : null;
    let labelCount = 0;
    const maxLabels = lastLod === "detail" ? 180 : 28;
    for (const node of visibleFrameNodes) {
      const emphasized = node === hovered || node === selected;
      if (lastLod === "detail" || emphasized) drawDetailedNode(node, time, emphasized);
      else drawSimpleNode(node, emphasized || neighbors?.has(node.id));
      const shouldLabel = emphasized || (lastLod === "detail" && (node._celestial.anchor || Number(node.importance) >= 0.84));
      if (shouldLabel && labelCount < maxLabels) {
        ctx.fillStyle = emphasized ? "#f3f6f8" : "rgba(190,203,218,.78)";
        ctx.font = `${Math.max(8.5, 9.5 / transform.k)}px ui-monospace, monospace`;
        ctx.fillText(String(node.label || node.topic || "").slice(0, 24), node._drawX + node._celestial.radius + 5 / transform.k, node._drawY + 3 / transform.k);
        labelCount++;
      }
    }
    ctx.restore();
    drawNavigationHint(lastLod === "detail" ? "DRAG A PLANET TO REPOSITION  ·  DRAG SPACE TO PAN" : "SCROLL FOR SURFACE DETAIL");
  }

  function findSystem(event) {
    const [sx, sy] = screenPoint(event, canvas);
    let nearest = null;
    let nearestDistance = Infinity;
    for (const system of systems) {
      const x = system.x * transform.k + transform.x;
      const y = system.y * transform.k + transform.y;
      const distance = Math.hypot(x - sx, y - sy);
      const hitRadius = Math.max(24, system.radius * transform.k);
      if (distance <= hitRadius && distance < nearestDistance) {
        nearest = system;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  function zoomTo(x, y, scale) {
    const next = d3.zoomIdentity.translate(width / 2 - x * scale, height / 2 - y * scale).scale(scale);
    const selection = d3.select(canvas);
    if (reducedMotion) selection.call(zoom.transform, next);
    else selection.transition().duration(650).ease(d3.easeCubicOut).call(zoom.transform, next);
  }

  function findNode(event) {
    if (lastLod === "systems") return null;
    const [sx, sy] = screenPoint(event, canvas);
    let nearest = null;
    let nearestDistance = Infinity;
    for (const node of visibleFrameNodes) {
      const nx = node._drawX * transform.k + transform.x;
      const ny = node._drawY * transform.k + transform.y;
      const distance = Math.hypot(nx - sx, ny - sy);
      const hitRadius = Math.max(8, node._celestial.radius * transform.k + 5);
      if (distance <= hitRadius && distance < nearestDistance) {
        nearest = node;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  function showTooltip(node, event) {
    if (!tooltip || !node) return;
    tooltipContent(tooltip, node, adjacency.get(node.id)?.size || 0);
    tooltip.style.display = "block";
    const x = Math.min(window.innerWidth - 310, event.clientX + 16);
    const y = Math.min(window.innerHeight - tooltip.offsetHeight - 16, event.clientY + 12);
    tooltip.style.left = `${Math.max(12, x)}px`;
    tooltip.style.top = `${Math.max(12, y)}px`;
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    const node = findNode(event);
    if (!node) return;
    dragged = node;
    selected = node;
    dragPointerId = event.pointerId;
    canvas.setPointerCapture?.(event.pointerId);
    canvas.style.cursor = "grabbing";
    event.preventDefault();
    scheduleDraw();
  }

  function onPointerMove(event) {
    if (dragged) {
      const [sx, sy] = screenPoint(event, canvas);
      const [x, y] = transform.invert([sx, sy]);
      dragged.x = x;
      dragged.y = y;
      dragged._drawX = x;
      dragged._drawY = y;
      dragged._manual = true;
      showTooltip(dragged, event);
      scheduleDraw();
      return;
    }
    const next = findNode(event);
    if (next !== hovered) {
      hovered = next;
      scheduleDraw();
    }
    canvas.style.cursor = next ? "grab" : "move";
    if (!next) {
      if (tooltip) tooltip.style.display = "none";
      return;
    }
    showTooltip(next, event);
  }

  function onPointerUp(event) {
    if (dragPointerId !== null) canvas.releasePointerCapture?.(dragPointerId);
    dragged = null;
    dragPointerId = null;
    canvas.style.cursor = hovered ? "grab" : "move";
    if (event) scheduleDraw();
  }

  function onLeave() {
    if (!dragged) hovered = null;
    if (tooltip && !dragged) tooltip.style.display = "none";
    scheduleDraw();
  }

  function onClick(event) {
    if (!dragged) selected = findNode(event);
    scheduleDraw();
  }

  function onDoubleClick(event) {
    event.preventDefault();
    if (lastLod === "systems") {
      const system = findSystem(event);
      if (system) zoomTo(system.x, system.y, nodes.length > 6000 ? 0.72 : 0.82);
      return;
    }
    const node = findNode(event);
    if (node) zoomTo(node._drawX, node._drawY, Math.max(1.5, Math.min(3, transform.k * 1.8)));
  }

  const zoom = d3.zoom()
    .scaleExtent([0.035, 8])
    .filter(event => (!event.ctrlKey || event.type === "wheel") && !event.button && !dragged
      && !(event.type === "mousedown" && findNode(event)))
    .on("zoom.galaxy", event => {
      transform = event.transform;
      scheduleDraw();
    });
  d3.select(canvas).call(zoom).on("dblclick.zoom", null);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("click", onClick);
  canvas.addEventListener("dblclick", onDoubleClick);

  const observer = window.ResizeObserver ? new window.ResizeObserver(resize) : null;
  observer?.observe(canvas);
  window.addEventListener("resize", resize);
  resize();

  if (!reducedMotion) {
    const loop = time => {
      if (destroyed || !canvas.isConnected) return;
      const fps = lastLod === "systems" ? 18 : nodes.length > 5000 ? 12 : lastLod === "detail" ? 24 : 18;
      if (!document.hidden && time - lastFrame >= 1000 / fps) {
        lastFrame = time;
        draw(time);
      }
      loopId = requestAnimationFrame(loop);
    };
    loopId = requestAnimationFrame(loop);
  }

  return Object.freeze({
    renderedEdges: edges.length,
    totalEdges: data.edges.length,
    setColorMode(nextMode) {
      mode = nextMode === "agent" ? "agent" : "type";
      scheduleDraw();
    },
    destroy() {
      destroyed = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (loopId !== null) cancelAnimationFrame(loopId);
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      d3.select(canvas).on(".zoom", null);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("dblclick", onDoubleClick);
      if (tooltip) tooltip.style.display = "none";
    }
  });
}
