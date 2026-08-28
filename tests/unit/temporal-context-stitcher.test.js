/**
 * TemporalContextStitcher 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";

import {
  deltaMinutes,
  stitchFragment,
  estimateStitchTokens,
  applyStitchBudget,
  renderStitch,
} from "../../lib/memory/read/TemporalContextStitcher.js";

const BASE = "2026-08-25T14:02:00.000Z";

/** 기준 시각에서 분 단위로 이동한 ISO 문자열을 만든다. */
const at = (minutes) => new Date(new Date(BASE).getTime() + minutes * 60000).toISOString();

const target = { id: "f-main", content: "max_connections를 500으로 상향", created_at: BASE };

describe("deltaMinutes", () => {
  test("이른 시각은 음수, 늦은 시각은 양수", () => {
    assert.equal(deltaMinutes(BASE, at(-5)), -5);
    assert.equal(deltaMinutes(BASE, at(10)), 10);
  });

  test("파싱 불가 입력은 null", () => {
    assert.equal(deltaMinutes(BASE, "not-a-date"), null);
  });
});

describe("stitchFragment", () => {
  const nearby = [
    { id: "f-pre",  content: "Nginx 502 발생",       type: "error",     created_at: at(-4) },
    { id: "f-post", content: "pg_reload_conf 적용",  type: "procedure", created_at: at(8) },
    { id: "f-far",  content: "무관한 먼 파편",        type: "fact",      created_at: at(120) },
  ];
  const linked = [
    { id: "f-cause", relation_type: "caused_by",  content: "DB 연결 부족" },
    { id: "f-fix",   relation_type: "resolved_by", content: "커넥션 상한 상향" },
    { id: "f-rel",   relation_type: "related",     content: "관련 파편" },
  ];

  test("전후 맥락과 인과 링크를 함께 묶는다", () => {
    const s = stitchFragment(target, { nearby, linked });
    assert.equal(s.pre.length, 1);
    assert.equal(s.pre[0].id, "f-pre");
    assert.equal(s.post.length, 1);
    assert.equal(s.post[0].id, "f-post");
    assert.equal(s.causal.length, 2, "related는 인과로 세지 않는다");
  });

  test("시간창을 벗어난 파편은 제외한다", () => {
    const s = stitchFragment(target, { nearby, linked: [] });
    assert.ok(!s.post.some(p => p.id === "f-far"));
  });

  test("인과 링크에 이미 나온 파편은 전후 맥락에서 중복 노출하지 않는다", () => {
    const s = stitchFragment(target, {
      nearby: [{ id: "f-cause", content: "DB 연결 부족", created_at: at(-3) }],
      linked,
    });
    assert.equal(s.pre.length, 0);
    assert.ok(s.causal.some(c => c.id === "f-cause"));
  });

  test("조합할 내용이 없으면 null", () => {
    assert.equal(stitchFragment(target, { nearby: [], linked: [] }), null);
    assert.equal(stitchFragment(null, { nearby, linked }), null);
    assert.equal(stitchFragment({ id: "x" }, { nearby, linked }), null);
  });

  test("전후 각 최대 건수를 지킨다", () => {
    const many = [-1, -2, -3, 1, 2, 3].map((m, i) => ({
      id: `n-${i}`, content: `내용 ${i}`, created_at: at(m),
    }));
    const s = stitchFragment(target, { nearby: many, linked: [] }, { maxSide: 2 });
    assert.equal(s.pre.length, 2);
    assert.equal(s.post.length, 2);
  });

  test("전 구간은 기준 시각에 가까운 순으로 정렬한다", () => {
    const many = [
      { id: "n-far",  content: "먼 것",   created_at: at(-20) },
      { id: "n-near", content: "가까운 것", created_at: at(-2) },
    ];
    const s = stitchFragment(target, { nearby: many, linked: [] });
    assert.equal(s.pre[0].id, "n-near");
  });
});

describe("applyStitchBudget", () => {
  const build = (n, len) => Array.from({ length: n }, (_, i) => ({
    fragmentId: `f-${i}`,
    stitch    : {
      target: { id: `f-${i}`, created_at: BASE },
      pre   : [{ id: `p-${i}`, content: "가".repeat(len), created_at: at(-1), delta_min: -1 }],
      post  : [{ id: `q-${i}`, content: "나".repeat(len), created_at: at(1),  delta_min: 1 }],
      causal: [],
    },
  }));

  test("예산 안이면 그대로 통과시킨다", () => {
    const items = build(2, 20);
    assert.equal(applyStitchBudget(items, 10000).length, 2);
  });

  test("예산을 넘으면 건수를 줄인다", () => {
    const items = build(5, 4000);
    const kept  = applyStitchBudget(items, 1000);
    assert.ok(kept.length < items.length);
  });

  test("예산이 0이면 아무것도 남기지 않는다", () => {
    assert.deepEqual(applyStitchBudget(build(3, 100), 0), []);
  });

  test("토큰 추정은 본문 길이에 비례한다", () => {
    const small = estimateStitchTokens(build(1, 10)[0].stitch);
    const large = estimateStitchTokens(build(1, 100)[0].stitch);
    assert.ok(large > small);
  });
});

describe("renderStitch", () => {
  test("기준 파편과 전후·인과를 트리 문자열로 만든다", () => {
    const s = stitchFragment(target, {
      nearby: [{ id: "f-pre", content: "Nginx 502 발생", created_at: at(-4) }],
      linked: [{ id: "f-cause", relation_type: "caused_by", content: "DB 연결 부족" }],
    });
    const lines = renderStitch(s, target.content);
    assert.ok(lines[0].includes("Main Target"));
    assert.ok(lines.some(l => l.includes("Pre-Context")));
    assert.ok(lines.some(l => l.includes("Causal Link [caused_by]")));
  });

  test("null 입력은 빈 배열", () => {
    assert.deepEqual(renderStitch(null), []);
  });
});
