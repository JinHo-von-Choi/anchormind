import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildGalaxyLayout,
  celestialStyle,
  galaxyLod,
  selectGalaxyEdges,
  stableUnit
} from "../../assets/admin/modules/galaxy-model.js";

describe("은하 그래프 모델", () => {
  it("같은 id의 외형과 난수는 항상 같다", () => {
    const node = { id: "frag-1", type: "decision", importance: 0.8 };
    assert.equal(stableUnit("frag-1", "ring"), stableUnit("frag-1", "ring"));
    assert.deepEqual(celestialStyle(node), celestialStyle(node));
  });

  it("앵커는 항성이고 타입별 천체가 서로 다르다", () => {
    assert.equal(celestialStyle({ id: "a", type: "fact", is_anchor: true }).kind, "star");
    assert.equal(celestialStyle({ id: "b", type: "decision" }).kind, "gas");
    assert.equal(celestialStyle({ id: "c", type: "error" }).kind, "pulsar");
    assert.equal(celestialStyle({ id: "d", type: "episode" }).kind, "ice");
  });

  it("topic별 태양계를 만들고 모든 좌표를 유한하게 배치한다", () => {
    const nodes = [
      { id: "a", topic: "alpha", importance: 0.2 },
      { id: "b", topic: "alpha", importance: 0.9, is_anchor: true },
      { id: "c", topic: "beta", importance: 0.5 }
    ];
    const systems = buildGalaxyLayout(nodes);
    assert.equal(systems.length, 2);
    assert.equal(nodes.find(node => node.id === "b")._system, "alpha");
    assert.equal(nodes.find(node => node.id === "b")._celestial.kind, "star");
    assert.equal(nodes.find(node => node.id === "c")._celestial.kind, "star");
    for (const node of nodes) {
      assert.ok(Number.isFinite(node.x));
      assert.ok(Number.isFinite(node.y));
      assert.ok(node._celestial);
    }
  });

  it("태양계 경계와 행성 궤도가 겹쳐 뭉치지 않는다", () => {
    const nodes = Array.from({ length: 240 }, (_, index) => ({
      id: `node-${index}`,
      topic: `topic-${index % 12}`,
      type: "fact",
      importance: (index % 10) / 10
    }));
    const systems = buildGalaxyLayout(nodes);

    for (let left = 0; left < systems.length; left++) {
      for (let right = left + 1; right < systems.length; right++) {
        const a = systems[left];
        const b = systems[right];
        assert.ok(
          Math.hypot(a.x - b.x, a.y - b.y) >= a.radius + b.radius,
          `${a.key}와 ${b.key} 경계가 겹친다`
        );
      }
    }
    for (const system of systems) {
      assert.ok(system.orbits.length >= 2);
      assert.equal(system.members[0]._celestial.kind, "star");
      assert.ok(system.members.slice(1).every(node => node._orbit?.radius > 0));
    }
  });

  it("내부 링크만 남기고 중요 링크 우선으로 예산을 적용한다", () => {
    const edges = [
      { from_id: "a", to_id: "b", weight: 0.2 },
      { from_id: "a", to_id: "c", weight: 0.9 },
      { from_id: "a", to_id: "outside", weight: 1 }
    ];
    assert.deepEqual(selectGalaxyEdges(edges, new Set(["a", "b", "c"]), 1), [edges[1]]);
  });

  it("멀리서는 태양계, 가까이서는 상세 표현을 고른다", () => {
    assert.equal(galaxyLod(0.2, 1000), "systems");
    assert.equal(galaxyLod(0.5, 1000), "planets");
    assert.equal(galaxyLod(1, 1000), "detail");
    assert.equal(galaxyLod(1, 5000), "planets");
    assert.equal(galaxyLod(2, 5000), "detail");
  });
});
