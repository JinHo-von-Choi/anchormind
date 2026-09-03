/** MemoryRecaller가 caseMode 확장기에 isAnchor 3상태를 손실 없이 전달하는지 검증한다. */
import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const capturedOptions = [];

mock.module("../../lib/memory/read/CaseRecall.js", {
  exports: {
    CaseRecall: class {
      async buildCaseTriples(_fragments, options) {
        capturedOptions.push(options);
        return [];
      }
    }
  }
});

const { MemoryRecaller } = await import("../../lib/memory/processors/MemoryRecaller.js");

beforeEach(() => {
  capturedOptions.length = 0;
});

describe("MemoryRecaller caseMode isAnchor 전달", () => {
  async function recall(isAnchor) {
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
    const params = { caseMode: true, includeLinks: false };
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
});
