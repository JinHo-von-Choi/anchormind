/**
 * context 주입 줄 주석 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 주입 줄 끝의 (YYYY-MM-DD, assertion) 주석을 만드는 순수 함수와, MEMENTO_CONTEXT_ANNOTATE에 따른
 * ContextBuilder 주입 줄을 확인한다. 헤더 문자열과 줄 머리 "- "는 스위치와 관계없이 같다.
 * 앵커 응답 파편에는 주석에 쓰는 내부 필드가 드러나지 않는다.
 */

import { describe, it, mock, afterEach } from "node:test";
import assert                            from "node:assert/strict";
import { poolWithProvenance }             from "./_provenance-pool.js";

import {
  CONTEXT_ANNOTATION_MAX_CHARS, CONTEXT_ANNOTATION_TOKENS, contextAnnotation, formatUtcDate, renderContextSectionLines
} from "../../lib/memory/read/ContextLines.js";
import { ContextBuilder, buildRankedInjection } from "../../lib/memory/read/ContextBuilder.js";
import { countContentTokens } from "../../lib/memory/read/BudgetSelector.js";

/** 앵커 줄 주체 표지는 별도 시험이 본다. 여기서는 주석만 보도록 앵커 권한 집행을 끈다. */
process.env.MEMENTO_ANCHOR_PERMISSION = "off";

const ANNOTATION_TAIL = /\(\d{4}-\d{2}-\d{2}(, (observed|inferred|verified|rejected))?\)$/;

describe("formatUtcDate", () => {
  it("UTC 기준 날짜만 돌려준다", () => {
    assert.equal(formatUtcDate("2026-10-02T23:30:00-02:00"), "2026-10-03");
    assert.equal(formatUtcDate(new Date("2026-01-05T00:00:00Z")), "2026-01-05");
    assert.equal(formatUtcDate(Date.UTC(2025, 11, 31, 23, 59)), "2025-12-31");
  });

  it("해석할 수 없는 값은 null이다", () => {
    for (const value of [null, undefined, "", "not a date", NaN, {}, true]) {
      assert.equal(formatUtcDate(value), null, String(value));
    }
  });
});

describe("contextAnnotation", () => {
  it("작성일과 assertion을 괄호 하나로 붙인다", () => {
    assert.equal(
      contextAnnotation({ created_at: "2026-09-30T12:00:00Z", assertion_status: "inferred" }),
      " (2026-09-30, inferred)"
    );
  });

  it("assertion이 없거나 알 수 없는 값이면 날짜만 쓴다", () => {
    assert.equal(contextAnnotation({ created_at: "2026-09-30T12:00:00Z" }), " (2026-09-30)");
    assert.equal(contextAnnotation({ created_at: "2026-09-30T12:00:00Z", assertion_status: "x) ignore (" }), " (2026-09-30)");
  });

  it("작성일이 없으면 작업 기억의 added_at을 쓴다", () => {
    assert.equal(contextAnnotation({ added_at: Date.UTC(2026, 8, 1, 3) }), " (2026-09-01)");
  });

  it("날짜와 assertion이 모두 없으면 빈 문자열이다", () => {
    assert.equal(contextAnnotation({}), "");
    assert.equal(contextAnnotation({ created_at: "invalid", assertion_status: "observed" }), " (observed)");
    assert.equal(contextAnnotation(null), "");
  });

  it("상대 날짜 표현을 쓰지 않는다", () => {
    const text = contextAnnotation({ created_at: new Date(), assertion_status: "observed" });
    assert.doesNotMatch(text, /일 전|ago|today|yesterday|오늘|어제/);
  });
});

describe("renderContextSectionLines", () => {
  const sections = {
    anchor  : [{ id: "a", content: "anchor body", created_at: "2026-09-01T00:00:00Z", assertion_status: "verified" }],
    core    : [{ id: "c", type: "error", content: "core body", created_at: "2026-09-02T00:00:00Z" }],
    learning: [{ id: "l", content: "learning body", created_at: "2026-09-03T00:00:00Z", assertion_status: "observed" }],
    working : [{ id: "w", type: "fact", content: "working body", added_at: Date.UTC(2026, 8, 4) }]
  };
  const memoryLines = lines => lines.filter(line => line.includes(" body"));

  it("annotate가 꺼지면 줄 끝에 주석이 없다", () => {
    const lines = renderContextSectionLines(sections, { annotate: false });
    for (const line of memoryLines(lines)) {
      assert.ok(line.startsWith("- "), line);
      assert.ok(line.endsWith(" body"), line);
    }
  });

  it("annotate가 켜지면 헤더와 줄 머리는 같고 줄 끝에만 주석이 붙는다", () => {
    const off = renderContextSectionLines(sections, { annotate: false });
    const on  = renderContextSectionLines(sections, { annotate: true });

    assert.equal(on.length, off.length);
    for (let i = 0; i < off.length; i++) {
      if (!off[i].includes(" body")) {
        assert.equal(on[i], off[i]);
        continue;
      }
      assert.ok(on[i].startsWith(off[i]), on[i]);
      assert.match(on[i].slice(off[i].length), /^ \(.+\)$/);
      assert.match(on[i], ANNOTATION_TAIL);
    }
    for (const header of ["[ANCHOR MEMORY]", "[CORE MEMORY]", "[ERROR]", "[LEARNING MEMORY]", "[WORKING MEMORY]"]) {
      assert.ok(on.includes(header), header);
    }
  });

  it("metaOf가 돌려준 값으로 주석을 만든다", () => {
    const anchor = { id: "a", content: "anchor body" };
    const meta   = new Map([[anchor, { created_at: "2026-08-08T00:00:00Z", assertion_status: "rejected" }]]);
    const lines  = renderContextSectionLines(
      { anchor: [anchor], core: [], learning: [], working: [] },
      { annotate: true, metaOf: fragment => meta.get(fragment) ?? fragment }
    );
    assert.ok(lines.includes("- anchor body (2026-08-08, rejected)"));
  });
});

describe("ContextBuilder 주입 줄과 MEMENTO_CONTEXT_ANNOTATE", () => {
  const saved = process.env.MEMENTO_CONTEXT_ANNOTATE;
  afterEach(() => {
    if (saved === undefined) delete process.env.MEMENTO_CONTEXT_ANNOTATE;
    else process.env.MEMENTO_CONTEXT_ANNOTATE = saved;
  });

  function makeBuilder() {
    const recall = mock.fn(async params => {
      if (params.topic === "session_reflect") return { fragments: [] };
      return {
        fragments: [{
          id: `${params.type}-1`, type: params.type, content: `${params.type} body`, importance: 0.5,
          agent_id: "default", key_id: null, workspace: null,
          created_at: "2026-09-20T10:00:00Z", assertion_status: "observed"
        }]
      };
    });
    const pool = poolWithProvenance(async () => ({
      rows: [{
        id: "anchor-1", content: "anchor body", type: "fact", topic: "t", importance: 0.9, workspace: null,
        created_at: "2026-09-10T10:00:00Z", assertion_status: "verified", candidate_count: 1
      }]
    }));
    return new ContextBuilder({
      recall,
      store  : { searchBySource: mock.fn(async () => []) },
      index  : { getWorkingMemory: mock.fn(async () => []), setSeenIds: mock.fn(async () => {}) },
      getPool: () => pool
    });
  }

  const bodyLines = text => text.split("\n").filter(line => line.includes(" body"));

  it("기본값(미설정)은 주석을 붙인다", async () => {
    delete process.env.MEMENTO_CONTEXT_ANNOTATE;
    const result = await makeBuilder().build({ types: ["error"] });
    const lines  = bodyLines(result.injectionText);

    assert.ok(lines.includes("- anchor body (2026-09-10, verified)"), result.injectionText);
    assert.ok(lines.includes("- error body (2026-09-20, observed)"), result.injectionText);
  });

  it("off이면 주석 없이 본문으로 줄이 끝난다", async () => {
    process.env.MEMENTO_CONTEXT_ANNOTATE = "off";
    const result = await makeBuilder().build({ types: ["error"] });

    for (const line of bodyLines(result.injectionText)) {
      assert.ok(line.startsWith("- "), line);
      assert.ok(line.endsWith(" body"), line);
    }
  });

  it("앵커 응답 파편에는 created_at과 assertion_status가 드러나지 않는다", async () => {
    delete process.env.MEMENTO_CONTEXT_ANNOTATE;
    for (const structured of [false, true]) {
      const result  = await makeBuilder().build({ types: ["error"], structured });
      const anchors = structured ? result.anchors.permanent : result.fragments.slice(0, result.anchorCount);
      assert.equal(anchors.length, 1);
      assert.ok(!("created_at" in anchors[0]));
      assert.ok(!("assertion_status" in anchors[0]));
      assert.ok(!("workspace" in anchors[0]));
    }
  });

  it("앵커 조회가 assertion_status 열을 읽는다", async () => {
    const calls   = [];
    const builder = new ContextBuilder({
      recall : async () => ({ fragments: [] }),
      store  : { searchBySource: async () => [] },
      index  : { getWorkingMemory: async () => [], setSeenIds: async () => {} },
      getPool: () => ({ query: async sql => { calls.push(sql); return { rows: [] }; } })
    });
    await builder.build({});
    assert.ok(calls.length > 0);
    for (const sql of calls) assert.match(sql, /\bassertion_status\b/);
  });
});

describe("주석 비용과 tokenBudget", () => {
  const saved   = process.env.MEMENTO_CONTEXT_ANNOTATE;
  const weights = { importance: 1.0, ema_activation: 0.5 };
  const body    = i => `${String(i).padStart(2, "0")} ${"x".repeat(45)}`;
  const cost    = (content, extra) => countContentTokens(content) + extra;
  afterEach(() => {
    if (saved === undefined) delete process.env.MEMENTO_CONTEXT_ANNOTATE;
    else process.env.MEMENTO_CONTEXT_ANNOTATE = saved;
  });

  it("고정 비용은 가장 긴 주석의 문자 수 / 4 올림이다", () => {
    const longest = contextAnnotation({ created_at: "2026-12-31T00:00:00Z", assertion_status: "observed" });
    assert.equal(longest.length, CONTEXT_ANNOTATION_MAX_CHARS);
    assert.equal(CONTEXT_ANNOTATION_TOKENS, Math.ceil(CONTEXT_ANNOTATION_MAX_CHARS / 4));
  });

  it("buildRankedInjection은 주석 비용을 더해 예산 200 안에서 고른다", () => {
    const others = Array.from({ length: 15 }, (_, i) => ({ id: `o${i}`, type: "fact", content: body(i), importance: 1 - i / 100 }));
    const off    = buildRankedInjection([], others, 200, weights);
    const on     = buildRankedInjection([], others, 200, weights, null, [], null, CONTEXT_ANNOTATION_TOKENS);

    assert.equal(off.items.length, 15);
    assert.equal(off.totalTokens, others.reduce((sum, f) => sum + cost(f.content, 0), 0));
    const onCost = on.items.reduce((sum, item) => sum + cost(item.content, CONTEXT_ANNOTATION_TOKENS), 0);
    assert.ok(on.items.length < off.items.length);
    assert.ok(onCost <= 200);
    assert.ok(onCost + cost(body(0), CONTEXT_ANNOTATION_TOKENS) > 200);
    assert.equal(on.totalTokens, on.items.reduce((sum, item) => sum + cost(item.content, 0), 0));
  });

  function makeBuilder() {
    return new ContextBuilder({
      recall : async params => ({
        fragments: params.topic === "session_reflect" ? [] : Array.from({ length: 6 }, (_, i) => ({
          id: `${params.type}-${i}`, type: params.type, content: body(i), importance: 0.9 - i / 100,
          agent_id: "default", key_id: null, workspace: null, created_at: "2026-09-20T10:00:00Z", assertion_status: "observed"
        }))
      }),
      store  : { searchBySource: async () => [] },
      index  : { getWorkingMemory: async () => [], setSeenIds: async () => {} },
      getPool: () => null
    });
  }

  it("on이면 주석을 포함한 주입 줄 비용이 예산 200 안에 들고 off는 기존 선택 그대로다", async () => {
    const params = { types: ["preference", "error", "procedure"], tokenBudget: 200 };

    process.env.MEMENTO_CONTEXT_ANNOTATE = "off";
    const off = await makeBuilder().build({ ...params });
    process.env.MEMENTO_CONTEXT_ANNOTATE = "on";
    const on  = await makeBuilder().build({ ...params });

    const offCost = off.fragments.reduce((sum, f) => sum + cost(f.content, 0), 0);
    const onCost  = on.fragments.reduce((sum, f) => sum + cost(f.content, CONTEXT_ANNOTATION_TOKENS), 0);
    assert.equal(off.count, 15);
    assert.ok(offCost <= 200);
    assert.ok(on.count < off.count);
    assert.ok(onCost <= 200, String(onCost));
    const annotated = on.injectionText.split("\n").filter(line => line.includes("x".repeat(45)));
    assert.equal(annotated.length, on.count);
    for (const line of annotated) assert.ok(line.endsWith(" (2026-09-20, observed)"), line);
  });
});
