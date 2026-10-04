/** 대규모 지식 그래프용 결정적 은하 레이아웃과 시각 모델. DOM 의존이 없는 순수 모듈이다. */

const TYPE_PALETTES = Object.freeze({
  fact:       ["#78b7ff", "#2b62aa", "#b9dcff"],
  decision:   ["#bd9cff", "#6540b8", "#eadcff"],
  error:      ["#ff796f", "#9d241f", "#ffd0b8"],
  procedure:  ["#68d99a", "#23734c", "#c2f5d2"],
  preference: ["#ffc75c", "#b66d13", "#fff0a8"],
  relation:   ["#85a8c7", "#405d77", "#d2e6f5"],
  episode:    ["#f184c1", "#913d77", "#ffd0eb"]
});

const KIND_BY_TYPE = Object.freeze({
  fact: "rocky",
  decision: "gas",
  error: "pulsar",
  procedure: "orbital",
  preference: "garden",
  relation: "dwarf",
  episode: "ice"
});

function orbitSlot(index) {
  let remaining = index - 1;
  let ring = 1;
  let capacity = 10;
  while (remaining >= capacity) {
    remaining -= capacity;
    ring++;
    capacity = 6 + ring * 4;
  }
  return { ring, slot: remaining, capacity };
}

function systemRadius(memberCount) {
  if (memberCount <= 1) return 96;
  const { ring } = orbitSlot(memberCount - 1);
  return 112 + ring * 48;
}

/** 큰 태양계부터 동심원 띠에 배치해 계 경계가 겹치지 않게 한다. */
function placeSystems(systems) {
  if (systems.length === 0) return;
  const gap = 110;
  systems[0].x = 0;
  systems[0].y = 0;

  let ringRadius = systems[0].radius + (systems[1]?.radius || 0) + gap;
  let ringMax = systems[1]?.radius || 0;
  let cursor = 0;
  const phase = -Math.PI * 0.42;

  for (let index = 1; index < systems.length; index++) {
    const system = systems[index];
    let arc = 2 * Math.asin(Math.min(0.92, (system.radius + gap / 2) / Math.max(ringRadius, 1)));
    if (cursor > 0 && cursor + arc > Math.PI * 2) {
      ringRadius += ringMax + system.radius + gap;
      ringMax = system.radius;
      cursor = 0;
      arc = 2 * Math.asin(Math.min(0.92, (system.radius + gap / 2) / ringRadius));
    }
    const angle = phase + cursor + arc / 2;
    system.x = Math.cos(angle) * ringRadius;
    system.y = Math.sin(angle) * ringRadius;
    cursor += arc;
    ringMax = Math.max(ringMax, system.radius);
  }
}

/** FNV-1a 기반 0~1 결정값. */
export function stableUnit(value, salt = "") {
  const text = `${value ?? ""}:${salt}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

/** 노드 데이터에서 재조회해도 변하지 않는 천체 외형을 만든다. */
export function celestialStyle(node) {
  const importance = Number.isFinite(Number(node.importance)) ? Math.max(0, Math.min(1, Number(node.importance))) : 0.5;
  const anchor     = node.is_anchor === true || node.anchor === true || node.pinned === true || node._systemStar === true;
  const kind       = anchor ? "star" : (KIND_BY_TYPE[node.type] || "dwarf");
  const palette    = TYPE_PALETTES[node.type] || TYPE_PALETTES.relation;
  const variant    = Math.floor(stableUnit(node.id, "variant") * 4);
  const radius     = (anchor ? 8 : 3.5) + importance * (anchor ? 9 : 7) + stableUnit(node.id, "radius") * 1.8;
  const ringBias   = kind === "gas" ? 0.85 : kind === "orbital" ? 0.62 : 0.18;
  const hasRing    = !anchor && stableUnit(node.id, "ring") < ringBias;
  const moonLimit  = kind === "gas" ? 3 : kind === "garden" || kind === "rocky" ? 2 : 1;
  const moonCount  = anchor ? 0 : Math.floor(stableUnit(node.id, "moons") * (moonLimit + 1));

  return Object.freeze({ anchor, kind, palette, variant, radius, hasRing, moonCount });
}

/**
 * topic을 태양계로 삼아 노드를 O(N)으로 배치한다. 각 계의 앵커 또는 최고 중요도 노드가 항성 중심이다.
 */
export function buildGalaxyLayout(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    const key = String(node.topic || node.type || "unclassified");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }

  const systems = [...groups.entries()]
    .map(([key, members]) => ({ key, members }))
    .sort((a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key));

  for (const system of systems) {
    system.radius = systemRadius(system.members.length);
    system.members.sort((a, b) => {
      const anchorDiff = Number(Boolean(b.is_anchor)) - Number(Boolean(a.is_anchor));
      return anchorDiff || Number(b.importance || 0) - Number(a.importance || 0) || String(a.id).localeCompare(String(b.id));
    });

  }
  placeSystems(systems);

  for (const system of systems) {
    const systemPhase = stableUnit(system.key, "system-phase") * Math.PI * 2;
    system.orbits = [];
    system.members.forEach((node, index) => {
      node._systemStar = index === 0;
      if (index === 0) {
        node.x = system.x;
        node.y = system.y;
        node._orbit = null;
      } else {
        const { ring, slot, capacity } = orbitSlot(index);
        const radius = 66 + ring * 46 + (stableUnit(node.id, "orbit-radius") - 0.5) * 8;
        const angle = systemPhase + (slot / capacity) * Math.PI * 2 + (stableUnit(node.id, "orbit-angle") - 0.5) * 0.12;
        const eccentricity = 0.64 + stableUnit(system.key, `eccentricity-${ring}`) * 0.18;
        const rotation = (stableUnit(system.key, `rotation-${ring}`) - 0.5) * 0.5;
        const direction = stableUnit(node.id, "orbit-direction") < 0.18 ? -1 : 1;
        node._orbit = { radius, angle, eccentricity, rotation, ring, direction };
        const ox = Math.cos(angle) * radius;
        const oy = Math.sin(angle) * radius * eccentricity;
        node.x = system.x + ox * Math.cos(rotation) - oy * Math.sin(rotation);
        node.y = system.y + ox * Math.sin(rotation) + oy * Math.cos(rotation);
        if (!system.orbits.some(orbit => orbit.ring === ring)) {
          system.orbits.push({ ring, radius: 66 + ring * 46, eccentricity, rotation });
        }
      }
      node._system = system.key;
      node._celestial = celestialStyle(node);
    });
  }

  return systems;
}

/** 선택 노드 양쪽이 화면 집합에 있는 링크만 남기고 과밀 그래프의 링크 예산을 제한한다. */
export function selectGalaxyEdges(edges, nodeIds, maxEdges) {
  const internal = edges.filter(edge => nodeIds.has(edge.from_id) && nodeIds.has(edge.to_id));
  if (internal.length <= maxEdges) return internal;
  return internal
    .map((edge, index) => ({ edge, index, weight: Number(edge.weight) || 0 }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .slice(0, maxEdges)
    .map(item => item.edge);
}

/** 줌과 규모에 따른 표현 단계. */
export function galaxyLod(scale, nodeCount) {
  if (scale < 0.28 || (nodeCount > 6000 && scale < 0.55)) return "systems";
  const detailThreshold = nodeCount > 6000 ? 2.4 : nodeCount > 2500 ? 1.35 : 0.72;
  if (scale < detailThreshold) return "planets";
  return "detail";
}

export const GALAXY_TYPE_PALETTES = TYPE_PALETTES;
