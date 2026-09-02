import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseStrictBooleanFlag, assertNoNormalizationFailures, normalizeApprovedFragments
} from "../../lib/cli/anchor-scope.js";

describe("anchor-scope CLI safety", () => {
  it("bare boolean flag만 허용한다", () => {
    assert.equal(parseStrictBooleanFlag({}, "execute"), false);
    assert.equal(parseStrictBooleanFlag({ execute: true }, "execute"), true);
    assert.equal(parseStrictBooleanFlag({ execute: false }, "execute"), false);
  });

  it("문자열 boolean과 중복 배열을 거부한다", () => {
    for (const value of ["false", "true", [true, true], ["false", true]]) {
      assert.throws(
        () => parseStrictBooleanFlag({ execute: value }, "execute"),
        /must be supplied once/
      );
    }
  });

  it("부분 실패를 성공 종료로 처리하지 않는다", () => {
    assert.doesNotThrow(() => assertNoNormalizationFailures([{ updated: true }]));
    assert.throws(
      () => assertNoNormalizationFailures([{ updated: true, cacheConsistent: false }]),
      /failed for 1 item/
    );
    assert.throws(
      () => assertNoNormalizationFailures([{ updated: true }, { updated: false }]),
      /failed for 1 item/
    );
  });

  it("global/named workspace 혼합 승인은 전체 사전검증 후 순서대로 실행한다", async () => {
    const calls = [];
    const manager = {
      validateFragmentAgentNormalization: async (id, agentId, opts) => {
        calls.push(["validate", id, agentId, opts]);
        return { valid: true };
      },
      normalizeFragmentAgentToDefault: async (id, agentId, opts) => {
        calls.push(["normalize", id, agentId, opts]);
        return { updated: true };
      }
    };
    const approved = [
      { id: "global-a", agentId: "agent-a", workspace: null },
      { id: "workspace-b", agentId: "agent-b", workspace: "project-b" }
    ];

    const results = await normalizeApprovedFragments(manager, approved, { anchorsOnly: false });

    assert.deepEqual(calls.map(call => `${call[0]}:${call[1]}`), [
      "validate:global-a", "validate:workspace-b",
      "normalize:global-a", "normalize:workspace-b"
    ]);
    assert.deepEqual(calls[0][3], {
      anchorsOnly: false, workspace: null, allWorkspaces: false
    });
    assert.deepEqual(calls[1][3], {
      anchorsOnly: false, workspace: "project-b", allWorkspaces: false
    });
    assert.deepEqual(results.map(result => result.id), ["global-a", "workspace-b"]);
  });

  it("후행 workspace 승인 사전검증 실패 시 어떤 항목도 변경하지 않는다", async () => {
    const normalized = [];
    const manager = {
      validateFragmentAgentNormalization: async (id) => id === "workspace-b"
        ? { valid: false, error: "scope changed" }
        : { valid: true },
      normalizeFragmentAgentToDefault: async (id) => {
        normalized.push(id);
        return { updated: true };
      }
    };

    await assert.rejects(
      normalizeApprovedFragments(manager, [
        { id: "global-a", agentId: "agent-a", workspace: null },
        { id: "workspace-b", agentId: "agent-b", workspace: "project-b" }
      ]),
      /preflight failed for workspace-b/
    );
    assert.deepEqual(normalized, []);
  });
});
