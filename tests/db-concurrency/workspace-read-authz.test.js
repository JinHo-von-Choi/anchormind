/**
 * 읽기 경로 workspace 허가 실서버 검사(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 키 둘(allowed_workspaces가 WS_A인 키, 범위가 없는 키)과 workspace 둘(WS_A, WS_B), 전역 파편을 실제
 * PostgreSQL에 두고 tools/call(recall, context)과 resources/read를 부른다.
 *   warn   : 범위 제한 키의 WS_B 요청이 그대로 처리되어 WS_B 파편이 나오고 would_deny가 늘어난다.
 *   enforce: 같은 요청은 -32001로 끝나고 응답에 행이 없으며 denied가 늘어난다. WS_A 요청은 WS_A와 전역
 *            파편만 나오고, 범위가 없는 키의 WS_B 요청은 그대로 나온다.
 */
import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import pg                              from "pg";

process.env.MEMENTO_ACCESS_KEY   = "lane-readauthz-master-0123456789abcdef0123";
process.env.EMBEDDING_BASE_URL   = "http://127.0.0.1:9";
process.env.EMBEDDING_ENABLED    = "false";
process.env.MEMENTO_TOOL_ARGS_VALIDATION = "off";

const { prepareLaneDatabase, dropLaneDatabase, directClientConfig } = await import("./_harness.js");

await prepareLaneDatabase();

const { shutdownPool }                         = await import("../../lib/tools/db.js");
const { handleToolsCall, handleResourcesRead } = await import("../../lib/jsonrpc.js");
const { workspaceReadAuthzTotal }              = await import("../../lib/memory/read/read-authz-metrics.js");
const { WorkspaceReadDeniedError }             = await import("../../lib/memory/read/workspace-read-policy.js");

const TAG         = `rda${Date.now().toString(36)}`;
const KEY_LIMITED = `${TAG}-limited`;
const KEY_OPEN    = `${TAG}-open`;
const WS_A        = `${TAG}-ws-a`;
const WS_B        = `${TAG}-ws-b`;
const IDS         = {
  limA: `${TAG}-lim-a`, limB: `${TAG}-lim-b`, limG: `${TAG}-lim-g`, openB: `${TAG}-open-b`
};

let client;

async function insertKey(id, allowed) {
  await client.query(
    `INSERT INTO agent_memory.api_keys
       (id, name, key_hash, key_prefix, permissions, status, daily_limit, created_at, symbolic_hard_gate, allowed_workspaces)
     VALUES ($1, $1, md5($1), 'mmcp_x', ARRAY['read','write']::text[], 'active', 1000, NOW(), false, $2)`,
    [id, allowed]
  );
}

async function insertFragment(id, keyId, workspace) {
  await client.query(
    `INSERT INTO agent_memory.fragments
       (id, content, topic, keywords, type, importance, content_hash, key_id, workspace, agent_id, embedding, valid_from, created_at)
     VALUES ($1, $2, $3, ARRAY[$3]::text[], 'fact', 0.9, md5($1), $4, $5, 'default', NULL, NOW(), NOW())`,
    [id, `허가 검사 본문 ${id} 충분히 길게 적는다`, TAG, keyId, workspace]
  );
}

function session(keyId) {
  return {
    authenticated: true, keyId, groupKeyIds: [keyId], permissions: ["read", "write"],
    defaultWorkspace: null, mode: null, sessionId: `${TAG}-${keyId}`, isMaster: false
  };
}

async function count(surface, outcome) {
  const { values } = await workspaceReadAuthzTotal.get();
  return values.filter(v => v.labels.surface === surface && v.labels.outcome === outcome)
    .reduce((n, v) => n + v.value, 0);
}

/** recall 응답 본문의 시험 파편 id */
async function recallIds(keyId, workspace) {
  const result = await handleToolsCall(
    { name: "recall", arguments: { keywords: [TAG], workspace, tokenBudget: 4000, excludeSeen: false } },
    session(keyId)
  );
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.success, true, JSON.stringify(payload).slice(0, 300));
  return payload.fragments.map(f => f.id).filter(id => id.startsWith(TAG)).sort();
}

before(async () => {
  client = new pg.Client(directClientConfig());
  await client.connect();
  await insertKey(KEY_LIMITED, [WS_A]);
  await insertKey(KEY_OPEN, null);
  await insertFragment(IDS.limA, KEY_LIMITED, WS_A);
  await insertFragment(IDS.limB, KEY_LIMITED, WS_B);
  await insertFragment(IDS.limG, KEY_LIMITED, null);
  await insertFragment(IDS.openB, KEY_OPEN, WS_B);
});

after(async () => {
  delete process.env.MEMENTO_WORKSPACE_READ_AUTHZ;
  try {
    await client.end();
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

describe("warn", () => {
  before(() => { process.env.MEMENTO_WORKSPACE_READ_AUTHZ = "warn"; });

  it("범위 제한 키의 WS_B recall은 그대로 처리되고 would_deny가 늘어난다", async () => {
    const before = await count("recall", "would_deny");
    assert.deepEqual(await recallIds(KEY_LIMITED, WS_B), [IDS.limB, IDS.limG].sort());
    assert.equal(await count("recall", "would_deny"), before + 1);
  });

  it("범위 제한 키의 WS_B resources/read도 그대로 처리된다", async () => {
    const before = await count("resources/read", "would_deny");
    const res = await handleResourcesRead({ uri: "memory://topics", workspace: WS_B }, session(KEY_LIMITED));
    assert.ok(JSON.parse(res.contents[0].text).includes(TAG));
    assert.equal(await count("resources/read", "would_deny"), before + 1);
  });
});

describe("enforce", () => {
  before(() => { process.env.MEMENTO_WORKSPACE_READ_AUTHZ = "enforce"; });

  it("범위 제한 키의 WS_B 요청은 -32001로 끝나고 행을 돌려주지 않는다", async () => {
    const before = await count("recall", "denied");
    let result;
    await assert.rejects(
      (async () => {
        result = await handleToolsCall(
          { name: "recall", arguments: { keywords: [TAG], workspace: WS_B } }, session(KEY_LIMITED));
      })(),
      (err) => err instanceof WorkspaceReadDeniedError && err.code === -32001
    );
    assert.equal(result, undefined);
    assert.equal(await count("recall", "denied"), before + 1);

    await assert.rejects(
      handleToolsCall({ name: "context", arguments: { workspace: WS_B } }, session(KEY_LIMITED)),
      (err) => err instanceof WorkspaceReadDeniedError
    );
    await assert.rejects(
      handleResourcesRead({ uri: "memory://topics", workspace: WS_B }, session(KEY_LIMITED)),
      (err) => err instanceof WorkspaceReadDeniedError
    );
  });

  it("범위 제한 키의 WS_A recall은 WS_A와 전역 파편만 돌려준다", async () => {
    assert.deepEqual(await recallIds(KEY_LIMITED, WS_A), [IDS.limA, IDS.limG].sort());
  });

  it("범위가 없는 키의 WS_B recall은 그대로 처리된다", async () => {
    assert.deepEqual(await recallIds(KEY_OPEN, WS_B), [IDS.openB]);
  });
});
