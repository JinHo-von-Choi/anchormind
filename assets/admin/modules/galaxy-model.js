/** 대규모 지식 그래프용 결정적 은하 레이아웃과 시각 모델. DOM 의존이 없는 순수 모듈이다. */

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

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

  const spacing = Math.max(190, 120 + Math.sqrt(nodes.length) * 4);
  for (let systemIndex = 0; systemIndex < systems.length; systemIndex++) {
    const system = systems[systemIndex];
    const spiral = Math.sqrt(systemIndex) * spacing;
    system.x = Math.cos(systemIndex * GOLDEN_ANGLE) * spiral;
    system.y = Math.sin(systemIndex * GOLDEN_ANGLE) * spiral;
    system.radius = 60 + Math.sqrt(system.members.length) * 28;

    system.members.sort((a, b) => {
      const anchorDiff = Number(Boolean(b.is_anchor)) - Number(Boolean(a.is_anchor));
      return anchorDiff || Number(b.importance || 0) - Number(a.importance || 0) || String(a.id).localeCompare(String(b.id));
    });

    system.members.forEach((node, index) => {
      node._systemStar = index === 0;
      if (index === 0) {
        node.x = system.x;
        node.y = system.y;
      } else {
        const orbit = 34 + Math.sqrt(index) * 22;
        const angle = index * GOLDEN_ANGLE + stableUnit(node.id, "orbit") * Math.PI * 2;
        const eccentricity = 0.72 + stableUnit(node.id, "eccentricity") * 0.25;
        node.x = system.x + Math.cos(angle) * orbit;
        node.y = system.y + Math.sin(angle) * orbit * eccentricity;
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
