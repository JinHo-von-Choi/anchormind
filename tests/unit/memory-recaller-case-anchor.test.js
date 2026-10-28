/** MemoryRecaller가 caseMode 확장기에 isAnchor 3상태를 손실 없이 전달하는지 검증한다. */
import { after, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";
import { recallerWithSearchStub } from "./_search-candidates-stub.js";

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

const capturedOptions   = [];
const capturedFragments = [];

mock.module("../../lib/memory/read/CaseRecall.js", {
  exports: {
    CaseRecall: class {
      async buildCaseTriples(fragments, options) {
        capturedOptions.push(options);
        capturedFragments.push(fragments);
        return [];
      }
    }
  }
});

const { MemoryRecaller: BaseRecaller } = await import("../../lib/memory/processors/MemoryRecaller.js");
const MemoryRecaller = recallerWithSearchStub(BaseRecaller);

beforeEach(() => {
  capturedOptions.length   = 0;
  capturedFragments.length = 0;
});

describe("MemoryRecaller caseMode 검색 범위 전달", () => {
  async function recall(isAnchor, requestContext = {}) {
    const search = {
      search: async () => ({
        fragments: [{
          id        : "synthetic-fragment",
          content   : "synthetic content",
          type      : "fact",
          case_id   : "synthetic-case",
          is_anchor : isAnchor === true,
          importance: 0.8
        }],
        totalTokens: 4,
        searchPath : "L2",
        count      : 1
      })
    };
    const recaller = new MemoryRecaller({ search, store: {} });
    const params = { caseMode: true, includeLinks: false, ...requestContext };
    if (isAnchor !== undefined) params.isAnchor = isAnchor;
    await recaller.recall(params);
    return capturedOptions.at(-1);
  }

  it("true를 전달한다", async () => {
    assert.equal((await recall(true)).isAnchor, true);
  });

  it("false를 전달한다", async () => {
    assert.equal((await recall(false)).isAnchor, false);
  });

  it("미지정은 isAnchor 옵션을 생성하지 않는다", async () => {
    assert.equal(Object.hasOwn(await recall(undefined), "isAnchor"), false);
  });

  it("null도 미지정으로 정규화해 isAnchor 옵션을 생성하지 않는다", async () => {
    assert.equal(Object.hasOwn(await recall(null), "isAnchor"), false);
  });

  it("case 대표 파편과 이벤트 확장에 현재 키 그룹 전체를 전달한다", async () => {
    const options = await recall(undefined, {
      _keyId      : "synthetic-key-a",
      _groupKeyIds: ["synthetic-key-a", "synthetic-key-b"]
    });

    assert.deepEqual(options.groupKeyIds, ["synthetic-key-a", "synthetic-key-b"]);
    assert.equal(options.keyId, "synthetic-key-a");
  });
});

describe("MemoryRecaller caseMode 사례 원천", () => {
  it("응답 한 쪽(pageSize, tokenBudget)이 아니라 조건에 맞는 검색 결과 전체로 사례를 센다", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      id: `f${String(i).padStart(2, "0")}`, content: `body ${i}`, type: "fact",
      case_id: `case-${i % 6}`, estimated_tokens: 100, rerankerScore: 1 - i / 100,
      created_at: "2026-01-01T00:00:00.000Z"
    }));
    const search = {
      search: async () => ({ fragments: rows.map(r => ({ ...r })), totalTokens: 0, searchPath: "fixture", count: rows.length })
    };
    const recaller = new MemoryRecaller({ search, store: {}, index: { getSeenIds: async () => new Set() } });
    await recaller.recall({ caseMode: true, includeLinks: false, excludeSeen: false, pageSize: 2, tokenBudget: 200, maxCases: 10 });

    const source = capturedFragments.at(-1);
    assert.equal(source.length, 12, "앞 쪽 2건이 아니라 12건 전체");
    assert.equal(new Set(source.map(f => f.case_id)).size, 6);
  });
});
