import {
  buildGalaxyLayout,
  galaxyLod,
  selectGalaxyEdges,
  stableUnit
} from "./galaxy-model.js";

const AGENT_PALETTE = ["#e4b85f", "#6aa9ff", "#78d88f", "#ff826e", "#aa8cff", "#55d5cc", "#ffd28a", "#df70ad"];

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
  if (node.topic) add("div", node.topic, { color: "#7893ba", fontSize: "11px", marginTop: "2px" });
  add("div", node.content || node.label || "", { color: "#e2ebf8", marginTop: "7px", lineHeight: "1.5" });
  add("div", `중요도 ${Number(node.importance || 0).toFixed(2)}  ·  연결 ${degree}개`, {
    color: "#91a2bc", marginTop: "8px", paddingTop: "6px", borderTop: "1px solid rgba(130,170,230,.16)"
  });
}

/** Canvas 한 장에서 수천 노드를 그리는 은하 LOD 렌더러. */
export function renderGalaxyCanvas(canvas, data, { colorMode = "type" } = {}) {
  const ctx       = canvas.getContext("2d", { alpha: false, desynchronized: true });
  const nodes     = data.nodes;
  const systems   = buildGalaxyLayout(nodes);
  const nodeById  = new Map(nodes.map(node => [node.id, node]));
  const nodeIds   = new Set(nodeById.keys());
  const edgeLimit = Math.min(60000, Math.max(3000, nodes.length * 8));
  const edges     = selectGalaxyEdges(data.edges, nodeIds, edgeLimit).map(edge => ({
    ...edge,
    source: nodeById.get(edge.from_id),
    target: nodeById.get(edge.to_id)
  }));
  const adjacency = new Map(nodes.map(node => [node.id, new Set()]));
  for (const edge of edges) {
    adjacency.get(edge.from_id)?.add(edge.to_id);
    adjacency.get(edge.to_id)?.add(edge.from_id);
  }

  const systemEdges = new Map();
  for (const edge of edges) {
    const a = edge.source?._system;
    const b = edge.target?._system;
    if (!a || !b || a === b) continue;
    const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    systemEdges.set(key, (systemEdges.get(key) || 0) + 1);
  }
  const systemByKey = new Map(systems.map(system => [system.key, system]));

  const stars = Array.from({ length: 260 }, (_, index) => ({
    x: stableUnit(index, "star-x"),
    y: stableUnit(index, "star-y"),
    r: 0.25 + stableUnit(index, "star-r") * 1.35,
    a: 0.18 + stableUnit(index, "star-a") * 0.62
  }));

  const tooltip = document.getElementById("graph-tooltip");
  let mode       = colorMode;
  let width      = 800;
  let height     = 600;
  let dpr        = 1;
  let transform  = d3.zoomIdentity;
  let quadtree   = d3.quadtree(nodes, node => node.x, node => node.y);
  let hovered    = null;
  let selected   = null;
  let rafId      = null;
  let loopId     = null;
  let destroyed  = false;
  let fitted     = false;

  const nodeColor = node => mode === "agent" ? agentColor(node.agent_id) : node._celestial.palette[0];

  function scheduleDraw() {
    if (rafId !== null || destroyed) return;
    rafId = requestAnimationFrame(time => {
      rafId = null;
      draw(time);
    });
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width  = Math.max(1, Math.floor(rect.width || 800));
    height = Math.max(1, Math.floor(rect.height || 600));
    dpr    = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width  = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    if (!fitted) fitGraph();
    scheduleDraw();
  }

  function fitGraph() {
    if (!nodes.length || !width || !height) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of nodes) {
      minX = Math.min(minX, node.x); minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x); maxY = Math.max(maxY, node.y);
    }
    const graphWidth  = Math.max(100, maxX - minX + 160);
    const graphHeight = Math.max(100, maxY - minY + 160);
    const scale = Math.max(0.06, Math.min(1.25, width / graphWidth, height / graphHeight));
    const tx = width / 2 - ((minX + maxX) / 2) * scale;
    const ty = height / 2 - ((minY + maxY) / 2) * scale;
    transform = d3.zoomIdentity.translate(tx, ty).scale(scale);
    fitted = true;
    d3.select(canvas).call(zoom.transform, transform);
  }

  function drawBackground(time) {
    const gradient = ctx.createRadialGradient(width * 0.48, height * 0.42, 10, width * 0.48, height * 0.42, Math.max(width, height));
    gradient.addColorStop(0, "#111a34");
    gradient.addColorStop(0.42, "#080d1d");
    gradient.addColorStop(1, "#03050d");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    for (let i = 0; i < stars.length; i++) {
      const star = stars[i];
      const pulse = nodes.length <= 2000 ? 0.78 + Math.sin(time * 0.0012 + i) * 0.22 : 1;
      ctx.globalAlpha = star.a * pulse;
      ctx.fillStyle = i % 17 === 0 ? "#9fc8ff" : "#ffffff";
      ctx.beginPath();
      ctx.arc(star.x * width, star.y * height, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function visible(node, margin = 30) {
    const sx = node.x * transform.k + transform.x;
    const sy = node.y * transform.k + transform.y;
    return sx >= -margin && sy >= -margin && sx <= width + margin && sy <= height + margin;
  }

  function drawNebula(system) {
    const radius = system.radius;
    const hue = Math.floor(stableUnit(system.key, "hue") * 70 + 205);
    const gradient = ctx.createRadialGradient(system.x, system.y, 0, system.x, system.y, radius);
    gradient.addColorStop(0, `hsla(${hue},70%,56%,0.13)`);
    gradient.addColorStop(0.52, `hsla(${hue + 24},62%,42%,0.055)`);
    gradient.addColorStop(1, `hsla(${hue + 38},55%,25%,0)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.ellipse(system.x, system.y, radius, radius * 0.66, stableUnit(system.key, "tilt") * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawSystemView() {
    ctx.lineWidth = 0.8 / transform.k;
    for (const [key, count] of systemEdges) {
      const [a, b] = key.split("\u0000");
      const from = systemByKey.get(a);
      const to   = systemByKey.get(b);
      if (!from || !to) continue;
      ctx.strokeStyle = `rgba(91,142,211,${Math.min(0.32, 0.04 + count * 0.015)})`;
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
    }
    for (const system of systems) {
      const radius = 4 + Math.log2(system.members.length + 1) * 2.2;
      const color = system.members[0]?._celestial.palette[0] || "#88aacc";
      ctx.shadowColor = color; ctx.shadowBlur = 14 / transform.k;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(system.x, system.y, radius / transform.k, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      if (transform.k > 0.12 || system.members.length >= 10) {
        ctx.fillStyle = "#b8c7df";
        ctx.font = `${11 / transform.k}px monospace`;
        ctx.fillText(`${system.key} · ${system.members.length}`, system.x + 10 / transform.k, system.y + 4 / transform.k);
      }
    }
  }

  function drawSimpleNode(node, emphasized) {
    const style = node._celestial;
    const color = nodeColor(node);
    const r = Math.max(1.4 / transform.k, style.radius * (emphasized ? 1.22 : 1));
    if (style.anchor || emphasized) {
      ctx.shadowColor = color;
      ctx.shadowBlur = (style.anchor ? 13 : 8) / transform.k;
    }
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
  }

  function drawDetailedNode(node, time, emphasized) {
    const style = node._celestial;
    const color = nodeColor(node);
    const r = style.radius * (emphasized ? 1.16 : 1);
    ctx.save();
    ctx.translate(node.x, node.y);

    if (style.kind === "star" || style.kind === "pulsar") {
      const pulse = 1 + Math.sin(time * 0.003 + stableUnit(node.id, "pulse") * 8) * 0.08;
      ctx.strokeStyle = hexAlpha(color, style.kind === "pulsar" ? 0.38 : 0.2);
      ctx.lineWidth = 0.8;
      const rays = style.kind === "pulsar" ? 4 : 8;
      for (let i = 0; i < rays; i++) {
        const a = (i / rays) * Math.PI * 2;
        ctx.beginPath(); ctx.moveTo(Math.cos(a) * r * 1.2, Math.sin(a) * r * 1.2);
        ctx.lineTo(Math.cos(a) * r * (style.kind === "pulsar" ? 2.6 : 1.75), Math.sin(a) * r * (style.kind === "pulsar" ? 2.6 : 1.75)); ctx.stroke();
      }
      ctx.shadowColor = color; ctx.shadowBlur = 16;
      const glow = ctx.createRadialGradient(-r * 0.3, -r * 0.35, 0, 0, 0, r * pulse);
      glow.addColorStop(0, "#fff8dc"); glow.addColorStop(0.35, style.palette[2]); glow.addColorStop(1, style.palette[1]);
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(0, 0, r * pulse, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    } else {
      if (style.hasRing) {
        ctx.save(); ctx.rotate((stableUnit(node.id, "ring-angle") - 0.5) * 0.9);
        ctx.strokeStyle = hexAlpha(style.palette[2], 0.52); ctx.lineWidth = 1.1;
        ctx.beginPath(); ctx.ellipse(0, 0, r * 1.75, r * 0.42, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      }
      const body = ctx.createRadialGradient(-r * 0.32, -r * 0.38, r * 0.06, 0, 0, r);
      body.addColorStop(0, style.palette[2]); body.addColorStop(0.5, color); body.addColorStop(1, style.palette[1]);
      ctx.fillStyle = body; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();

      ctx.save(); ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.clip();
      if (style.kind === "gas" || style.kind === "orbital") {
        ctx.strokeStyle = hexAlpha(style.palette[2], 0.35); ctx.lineWidth = Math.max(0.7, r * 0.12);
        for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(-r, i * r * 0.36); ctx.lineTo(r, i * r * 0.28); ctx.stroke(); }
      } else if (style.kind === "rocky" || style.kind === "dwarf") {
        ctx.fillStyle = hexAlpha(style.palette[1], 0.38);
        for (let i = 0; i < 3; i++) {
          const a = stableUnit(node.id, `crater-${i}`) * Math.PI * 2;
          const cr = r * (0.1 + stableUnit(node.id, `crater-r-${i}`) * 0.11);
          ctx.beginPath(); ctx.arc(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5, cr, 0, Math.PI * 2); ctx.fill();
        }
      } else if (style.kind === "ice") {
        ctx.strokeStyle = "rgba(230,250,255,.52)"; ctx.lineWidth = 0.65;
        ctx.beginPath(); ctx.moveTo(-r * 0.6, -r * 0.1); ctx.lineTo(0, r * 0.2); ctx.lineTo(r * 0.55, -r * 0.35); ctx.stroke();
      } else if (style.kind === "garden") {
        ctx.strokeStyle = "rgba(130,255,190,.48)"; ctx.lineWidth = Math.max(0.7, r * 0.13);
        ctx.beginPath(); ctx.arc(-r * 0.18, r * 0.2, r * 0.72, Math.PI * 1.1, Math.PI * 1.75); ctx.stroke();
      }
      ctx.restore();

      for (let i = 0; i < style.moonCount; i++) {
        const orbit = r * (1.55 + i * 0.38);
        const angle = stableUnit(node.id, `moon-${i}`) * Math.PI * 2 + time * 0.00015 * (i + 1);
        ctx.fillStyle = style.palette[2]; ctx.globalAlpha = 0.75;
        ctx.beginPath(); ctx.arc(Math.cos(angle) * orbit, Math.sin(angle) * orbit * 0.55, Math.max(0.8, r * 0.1), 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    if (emphasized) {
      ctx.strokeStyle = "rgba(255,255,255,.88)"; ctx.lineWidth = 1.2 / transform.k;
      ctx.beginPath(); ctx.arc(0, 0, r + 4 / transform.k, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  function draw(time = performance.now()) {
    if (destroyed) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawBackground(time);
    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    const lod = galaxyLod(transform.k, nodes.length);
    systems.slice(0, 48).forEach(drawNebula);
    if (lod === "systems") {
      drawSystemView();
      ctx.restore();
      return;
    }

    const focusId = hovered?.id || selected?.id;
    const neighbors = focusId ? adjacency.get(focusId) : null;
    ctx.lineCap = "round";
    for (const edge of edges) {
      if (!edge.source || !edge.target || (!visible(edge.source, 80) && !visible(edge.target, 80))) continue;
      const active = focusId && (edge.source.id === focusId || edge.target.id === focusId);
      if (focusId && !active && lod === "detail") continue;
      ctx.strokeStyle = active ? "rgba(151,202,255,.8)" : "rgba(67,91,133,.28)";
      ctx.lineWidth = (active ? 1.7 : Math.min(1.1, Number(edge.weight) || 0.7)) / transform.k;
      ctx.beginPath(); ctx.moveTo(edge.source.x, edge.source.y); ctx.lineTo(edge.target.x, edge.target.y); ctx.stroke();
    }

    let labelCount = 0;
    const maxLabels = lod === "detail" ? 240 : 36;
    for (const node of nodes) {
      if (!visible(node)) continue;
      const emphasized = node === hovered || node === selected;
      if (lod === "detail" || emphasized) drawDetailedNode(node, time, emphasized);
      else drawSimpleNode(node, emphasized || neighbors?.has(node.id));
      if ((emphasized || (lod === "detail" && (node._celestial.anchor || Number(node.importance) >= 0.78))) && labelCount < maxLabels) {
        ctx.fillStyle = emphasized ? "#ffffff" : "#b8c7df";
        ctx.font = `${Math.max(9, 10 / transform.k)}px monospace`;
        ctx.fillText(String(node.label || node.topic || "").slice(0, 24), node.x + node._celestial.radius + 5 / transform.k, node.y + 3 / transform.k);
        labelCount++;
      }
    }
    ctx.restore();
  }

  function findNode(event) {
    if (galaxyLod(transform.k, nodes.length) === "systems") return null;
    const [sx, sy] = screenPoint(event, canvas);
    const [x, y]   = transform.invert([sx, sy]);
    const candidate = quadtree.find(x, y, 24 / transform.k);
    if (!candidate) return null;
    const radius = candidate._celestial.radius + 8 / transform.k;
    return Math.hypot(candidate.x - x, candidate.y - y) <= radius ? candidate : null;
  }

  function onMove(event) {
    const next = findNode(event);
    if (next !== hovered) { hovered = next; scheduleDraw(); }
    canvas.style.cursor = next ? "pointer" : "grab";
    if (!tooltip) return;
    if (!next) { tooltip.style.display = "none"; return; }
    tooltipContent(tooltip, next, adjacency.get(next.id)?.size || 0);
    tooltip.style.display = "block";
    const x = Math.min(window.innerWidth - 310, event.clientX + 16);
    const y = Math.min(window.innerHeight - tooltip.offsetHeight - 16, event.clientY + 12);
    tooltip.style.left = `${Math.max(12, x)}px`;
    tooltip.style.top  = `${Math.max(12, y)}px`;
  }

  function onLeave() {
    hovered = null;
    if (tooltip) tooltip.style.display = "none";
    scheduleDraw();
  }

  function onClick(event) {
    selected = findNode(event);
    scheduleDraw();
  }

  const zoom = d3.zoom()
    .scaleExtent([0.05, 8])
    .on("zoom.galaxy", event => { transform = event.transform; scheduleDraw(); });
  d3.select(canvas).call(zoom).on("dblclick.zoom", null);
  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mouseleave", onLeave);
  canvas.addEventListener("click", onClick);

  const observer = window.ResizeObserver ? new window.ResizeObserver(resize) : null;
  observer?.observe(canvas);
  window.addEventListener("resize", resize);
  resize();

  if (nodes.length <= 2000) {
    let last = 0;
    const loop = time => {
      if (destroyed || !canvas.isConnected) return;
      if (time - last >= 66) { last = time; draw(time); }
      loopId = requestAnimationFrame(loop);
    };
    loopId = requestAnimationFrame(loop);
  }

  return Object.freeze({
    renderedEdges: edges.length,
    totalEdges: data.edges.length,
    setColorMode(nextMode) { mode = nextMode === "agent" ? "agent" : "type"; scheduleDraw(); },
    destroy() {
      destroyed = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (loopId !== null) cancelAnimationFrame(loopId);
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      d3.select(canvas).on(".zoom", null);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("click", onClick);
      if (tooltip) tooltip.style.display = "none";
      quadtree = null;
    }
  });
}
