/**
 * 앵커 주입 개수 설정(maxAnchorFragments / MEMENTO_CONTEXT_ANCHOR_LIMIT) 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-07-14
 *
 * env 클램프 규칙과 #loadAnchorMemory LIMIT 바인딩,
 * structured rankedInjection의 앵커 상단 고정을 검증한다.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ContextBuilder } from "../../lib/memory/read/ContextBuilder.js";
import { MEMORY_CONFIG } from "../../config/memory.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 서브프로세스에서 env를 설정한 뒤 config를 새로 로드하여
 * maxAnchorFragments 값을 반환한다 (모듈 캐시 격리).
 */
function loadAnchorLimit(envValue) {
  const env = { ...process.env };
  delete env.MEMENTO_CONTEXT_ANCHOR_LIMIT;
  if (envValue !== undefined) env.MEMENTO_CONTEXT_ANCHOR_LIMIT = envValue;
  const out = execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import { MEMORY_CONFIG } from "${path.join(ROOT, "config", "memory.js")}";` +
    "console.log(MEMORY_CONFIG.contextInjection.maxAnchorFragments);"
  ], { env, encoding: "utf8" });
  return Number(out.trim());
}

describe("MEMENTO_CONTEXT_ANCHOR_LIMIT env 클램프", () => {
  it("미설정 시 기본값 10", () => {
    assert.equal(loadAnchorLimit(undefined), 10);
  });

  it("=25 시 25", () => {
    assert.equal(loadAnchorLimit("25"), 25);
  });

  it("=0 시 하한 1로 클램프", () => {
    assert.equal(loadAnchorLimit("0"), 1);
  });

  it("=999 시 상한 30으로 클램프", () => {
    assert.equal(loadAnchorLimit("999"), 30);
  });

  it("비숫자 시 파싱 실패 기본값 10", () => {
    assert.equal(loadAnchorLimit("abc"), 10);
  });
});

/* ── #loadAnchorMemory LIMIT 바인딩 + structured 앵커 고정 ── */
describe("ContextBuilder 앵커 주입", () => {
  function makeBuilder(poolQuery) {
    const recallMock = mock.fn(async (params) => {
      if (params.topic === "session_reflect") return { fragments: [] };
      return { fragments: [{ id: `${params.type}-1`, type: params.type, content: `${params.type} c`, importance: 0.5 }] };
    });
    const indexMock = {
      getWorkingMemory: mock.fn(async () => []),
      setSeenIds      : mock.fn(async () => {}),
    };
    const storeMock = { searchBySource: mock.fn(async () => []) };
    return new ContextBuilder({
      recall : recallMock,
      store  : storeMock,
      index  : indexMock,
      getPool: () => ({ query: poolQuery }),
    });
  }

  it("앵커 SELECT의 LIMIT이 설정값으로 바인딩된다", async () => {
    let captured = null;
    const builder = makeBuilder(async (sql, params) => {
      captured = { sql, params };
      return { rows: [] };
    });

    await builder.build({});

    assert.ok(captured, "anchor 쿼리가 실행되어야 한다");
    assert.match(captured.sql, /LIMIT \$\d+/);
    assert.equal(
      captured.params[captured.params.length - 1],
      MEMORY_CONFIG.contextInjection.maxAnchorFragments
    );
  });

  it("structured=true에서 앵커 파편(원래 type 유지)이 rankedInjection 상단에 고정된다", async () => {
    const anchorRows = [
      { id: "anc-1", type: "preference", topic: "t", content: "anchor pref", importance: 1.0 },
      { id: "anc-2", type: "decision",   topic: "t", content: "anchor deci", importance: 0.9 },
    ];
    const builder = makeBuilder(async () => ({ rows: anchorRows }));

    const result = await builder.build({ structured: true });

    assert.equal(result.structured, true);
    assert.equal(result.anchorCount, 2);
    const items = result.rankedInjection.items;
    assert.equal(items[0].id, "anc-1");
    assert.equal(items[0].anchor, true);
    assert.equal(items[1].id, "anc-2");
    assert.equal(items[1].anchor, true);
    /** 앵커가 아닌 파편이 anchor=true로 표시되지 않아야 한다 */
    for (const item of items.slice(2)) {
      assert.equal(item.anchor, false);
    }
  });
});
