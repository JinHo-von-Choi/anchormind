/**
 * recall의 잘못된 isAnchor 값이 호출자에게 검증 문구로 돌아가는지 확인한다.
 * 실제 handleToolsCall, tool_recall, MemoryRecaller를 거치고 저장소 계층만 대체한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, mock } from "node:test";
import assert                 from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const { MemoryRecaller } = await import("../../lib/memory/processors/MemoryRecaller.js");

const recaller    = new MemoryRecaller({
  search: { search: async () => ({ fragments: [], count: 0, totalTokens: 0, searchPath: "stub" }) },
  store : { getLinkedFragments: async () => [] }
});
const fakeManager = { recall: (args) => recaller.recall(args) };

const realManager = await import("../../lib/memory/MemoryManager.js");
mock.module("../../lib/memory/MemoryManager.js", {
  namedExports: { ...realManager, MemoryManager: { getInstance: () => fakeManager } }
});
const realUtils = await import("../../lib/utils.js");
mock.module("../../lib/utils.js", {
  namedExports: { ...realUtils, logAudit: async () => {} }
});

const { handleToolsCall } = await import("../../lib/jsonrpc.js");

const MASTER = {
  authenticated: true, isMaster: true, keyId: null, groupKeyIds: null, permissions: null,
  defaultWorkspace: null, mode: null, sessionId: null
};

describe("recall isAnchor 검증 문구", () => {
  it("허용되지 않은 isAnchor 값은 내부 오류가 아니라 검증 문구로 돌아간다", async () => {
    const r       = await handleToolsCall({ name: "recall", arguments: { keywords: ["k"], isAnchor: "yes" } }, MASTER);
    const payload = JSON.parse(r.content[0].text);

    assert.equal(payload.success, false);
    assert.match(payload.error, /isAnchor must be null, a boolean/);
    assert.notEqual(payload.error, "Internal error");
  });

  it("숫자 isAnchor 값도 같은 검증 문구를 받는다", async () => {
    const r       = await handleToolsCall({ name: "recall", arguments: { keywords: ["k"], isAnchor: 1 } }, MASTER);
    const payload = JSON.parse(r.content[0].text);

    assert.match(payload.error, /isAnchor must be null, a boolean/);
  });
});
