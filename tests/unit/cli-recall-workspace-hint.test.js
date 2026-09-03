import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

import { attachEmptyRecallHint, resolveEmptyRecallHint } from "../../lib/cli/recall.js";

describe("CLI recall 빈 결과 workspace 힌트", () => {
  it("원격 서버의 구체적인 힌트를 우선 사용", () => {
    const hint = resolveEmptyRecallHint({
      _meta: { hints: [{ suggestion: "서버가 제공한 재검색 안내" }] }
    });
    assert.equal(hint, "서버가 제공한 재검색 안내");
  });

  it("로컬 global-only 조회는 --workspace 재검색을 안내", () => {
    const hint = resolveEmptyRecallHint({}, {});
    assert.match(hint, /전역\(workspace 없음\)/);
    assert.match(hint, /--workspace <name>/);
  });

  it("명시 workspace 또는 전체 조회에는 추정 힌트를 만들지 않음", () => {
    assert.equal(resolveEmptyRecallHint({}, { workspace: "ws-a" }), null);
    assert.equal(resolveEmptyRecallHint({}, { allWorkspaces: true }), null);
  });

  it("로컬 JSON 빈 결과에도 서버와 같은 _meta.hints 형태를 보충", () => {
    const result = attachEmptyRecallHint({ fragments: [], count: 0 }, {});
    assert.equal(result._meta.hints[0].signal, "no_results");
    assert.match(result._meta.hints[0].suggestion, /--workspace <name>/);
  });

  it("기존 서버 힌트는 변경하지 않음", () => {
    const result = {
      fragments: [],
      _meta: { hints: [{ signal: "topic_mismatch", suggestion: "기존 안내" }] }
    };
    assert.strictEqual(attachEmptyRecallHint(result, {}), result);
  });
});
