/**
 * 파편 출처와 신뢰 등급 검사(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * migration-057의 열과 NOT VALID 제약, 쓰기 경로(단건과 일괄)의 출처 열 기록, 스위치를 끈 기록,
 * context 주입 제외(앵커 SQL 술어와 core 등급 조회), 출처 열 조회를 실제 PostgreSQL에서 확인한다.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert                                     from "node:assert/strict";
import pg                                         from "pg";

process.env.EMBEDDING_BASE_URL = "http://127.0.0.1:9";

const { prepareLaneDatabase, dropLaneDatabase, directClientConfig } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool, getPrimaryPool } = await import("../../lib/tools/db.js");
const { FragmentWriter }               = await import("../../lib/memory/write/FragmentWriter.js");
const { FragmentFactory }              = await import("../../lib/memory/write/FragmentFactory.js");
const { WriteGate, WRITE_ENTRIES }     = await import("../../lib/memory/write/WriteGate.js");
const { BatchRememberProcessor }       = await import("../../lib/memory/write/BatchRememberProcessor.js");
const { ContextBuilder }               = await import("../../lib/memory/read/ContextBuilder.js");
const { loadFragmentProvenance }       = await import("../../lib/memory/read/ProvenanceLoader.js");

const TAG     = `prv${Date.now().toString(36)}`;
const writer  = new FragmentWriter();
const factory = new FragmentFactory();

let client;

/** 관문을 거쳐 한 건을 기록하고 저장된 출처 열을 읽는다. */
async function rememberOne(suffix, { origin, trustCap = 2, clientName = "lane-client" } = {}) {
  const { draft } = await new WriteGate({ policyGatingEnabled: false }).check({
    entry : WRITE_ENTRIES.REMEMBER,
    op    : "create",
    fields: {
      content: `출처 검사 본문 ${TAG} ${suffix} 충분히 길게 적는다`, topic: `prv-${TAG}`, type: "fact",
      ...(origin ? { origin } : {})
    },
    ctx   : { keyId: null, agentId: "default", provenance: { clientName, trustCap } },
    build : (input) => {
      const f = factory.create(input, { contentPrepared: true });
      f.agent_id  = "default";
      f.key_id    = null;
      f.workspace = null;
      return f;
    }
  });
  const id = await writer.insert(draft);
  return (await client.query(
    "SELECT origin, observed_client, trust_tier FROM agent_memory.fragments WHERE id = $1", [id]
  )).rows[0];
}

/** 직접 넣는 시험 파편 */
async function insertRow(id, { anchor = false, trustTier = null, origin = null, type = "fact" } = {}) {
  await client.query(
    `INSERT INTO agent_memory.fragments
       (id, content, topic, keywords, type, importance, content_hash, is_anchor, agent_id, valid_from,
        created_at, origin, trust_tier)
     VALUES ($1, $2, $3, ARRAY['prv']::text[], $4, 0.9, md5($1), $5, 'default', NOW(), NOW(), $6, $7)`,
    [id, `${id} body`, `prv-${TAG}`, type, anchor, origin, trustTier]
  );
}

before(async () => {
  client = new pg.Client(directClientConfig());
  await client.connect();
});

after(async () => {
  try {
    await client.end();
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

afterEach(() => { delete process.env.MEMENTO_PROVENANCE; });

describe("migration-057", () => {
  it("다섯 열이 기본값 없는 nullable 열로 있다", async () => {
    const { rows } = await client.query(
      `SELECT column_name, is_nullable, column_default, data_type
         FROM information_schema.columns
        WHERE table_schema = 'agent_memory' AND table_name = 'fragments'
          AND column_name IN ('origin', 'observed_client', 'trust_tier', 'review_state', 'review_reason')
        ORDER BY column_name`
    );
    assert.deepEqual(rows.map(r => r.column_name), ["observed_client", "origin", "review_reason", "review_state", "trust_tier"]);
    for (const r of rows) {
      assert.equal(r.is_nullable, "YES", r.column_name);
      assert.equal(r.column_default, null, r.column_name);
    }
    assert.equal(rows.find(r => r.column_name === "trust_tier").data_type, "smallint");
  });

  it("두 CHECK 제약은 NOT VALID로 붙어 새 행에 적용된다", async () => {
    const { rows } = await client.query(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = 'agent_memory.fragments'::regclass
          AND conname IN ('fragments_origin_check', 'fragments_trust_tier_check')
        ORDER BY conname`
    );
    assert.deepEqual(rows, [
      { conname: "fragments_origin_check", convalidated: false },
      { conname: "fragments_trust_tier_check", convalidated: false }
    ]);
    await assert.rejects(() => insertRow(`${TAG}-bad-origin`, { origin: "system" }), (err) => err.code === "23514");
    await assert.rejects(() => insertRow(`${TAG}-bad-tier`, { trustTier: 4 }), (err) => err.code === "23514");
  });
});

describe("쓰기 경로", () => {
  it("단건 기록은 주장 출처, 관측 클라이언트, 상한을 건 등급을 저장한다", async () => {
    assert.deepEqual(await rememberOne("a", { origin: "user_stated", trustCap: 3 }),
      { origin: "user_stated", observed_client: "lane-client/remember", trust_tier: 3 });
    assert.deepEqual(await rememberOne("b", { origin: "user_stated", trustCap: 2 }),
      { origin: "user_stated", observed_client: "lane-client/remember", trust_tier: 2 });
    assert.deepEqual(await rememberOne("c", { origin: "external_content", trustCap: 3 }),
      { origin: "external_content", observed_client: "lane-client/remember", trust_tier: 1 });
  });

  it("MEMENTO_PROVENANCE=off이면 세 열이 NULL이다", async () => {
    process.env.MEMENTO_PROVENANCE = "off";
    assert.deepEqual(await rememberOne("off", { origin: "user_stated", trustCap: 3 }),
      { origin: null, observed_client: null, trust_tier: null });
  });

  it("일괄 기록은 항목마다 출처 열을 저장한다", async () => {
    const processor = new BatchRememberProcessor({ store: {}, index: { index: async () => {} }, factory });
    const result    = await processor.process({
      fragments: [
        { content: `일괄 출처 검사 ${TAG} 첫째 항목을 충분히 길게 적는다`, topic: `prv-${TAG}`, type: "fact", origin: "tool_output" },
        { content: `일괄 출처 검사 ${TAG} 둘째 항목을 충분히 길게 적는다`, topic: `prv-${TAG}`, type: "fact" }
      ],
      agentId    : "default",
      _isMaster  : true,
      _clientName: "lane-batch"
    });
    const ids  = result.results.map(r => r.id);
    const rows = (await client.query(
      "SELECT id, origin, observed_client, trust_tier FROM agent_memory.fragments WHERE id = ANY($1::text[])", [ids]
    )).rows;
    const byId = new Map(rows.map(r => [r.id, r]));
    assert.deepEqual({ ...byId.get(ids[0]), id: undefined },
      { id: undefined, origin: "tool_output", observed_client: "lane-batch/batch_remember", trust_tier: 2 });
    assert.deepEqual({ ...byId.get(ids[1]), id: undefined },
      { id: undefined, origin: null, observed_client: "lane-batch/batch_remember", trust_tier: 2 });
  });
});

describe("context 주입 제외", () => {
  before(async () => {
    await insertRow(`${TAG}-anchor-null`, { anchor: true });
    await insertRow(`${TAG}-anchor-low`, { anchor: true, trustTier: 1, origin: "external_content" });
    await insertRow(`${TAG}-anchor-high`, { anchor: true, trustTier: 3, origin: "user_stated" });
    await insertRow(`${TAG}-core-low`, { trustTier: 0 });
    await insertRow(`${TAG}-core-ok`, { trustTier: 2, origin: "tool_output" });
  });

  function builder() {
    const recall = async (params) => {
      if (params.topic === "session_reflect") return { fragments: [] };
      const ids = [`${TAG}-core-low`, `${TAG}-core-ok`];
      return { fragments: ids.map(id => ({
        id, type: params.type, content: `${id} body`, importance: 0.5, agent_id: "default", key_id: null,
        workspace: null, created_at: new Date().toISOString(), assertion_status: "observed"
      })) };
    };
    return new ContextBuilder({
      recall,
      store  : { searchBySource: async () => [] },
      index  : { getWorkingMemory: async () => [], setSeenIds: async () => {} },
      getPool: getPrimaryPool
    });
  }

  it("등급 1 이하 앵커와 core 파편은 주입되지 않고 NULL은 주입된다", async () => {
    const { injectionText } = await builder().build({ types: ["fact"], _isMaster: true });
    assert.ok(injectionText.includes(`${TAG}-anchor-null body`), injectionText);
    assert.ok(injectionText.includes(`${TAG}-anchor-high body`), injectionText);
    assert.ok(!injectionText.includes(`${TAG}-anchor-low body`), injectionText);
    assert.ok(injectionText.includes(`${TAG}-core-ok body`), injectionText);
    assert.ok(!injectionText.includes(`${TAG}-core-low body`), injectionText);
    assert.match(injectionText, new RegExp(`${TAG}-anchor-high body \\(\\d{4}-\\d{2}-\\d{2}, observed, user_stated\\)`));
  });

  it("꺼지면 등급과 관계없이 모두 주입된다", async () => {
    process.env.MEMENTO_PROVENANCE = "off";
    const { injectionText } = await builder().build({ types: ["fact"], _isMaster: true });
    for (const suffix of ["anchor-null", "anchor-low", "anchor-high", "core-low", "core-ok"]) {
      assert.ok(injectionText.includes(`${TAG}-${suffix} body`), suffix);
    }
    assert.doesNotMatch(injectionText, /user_stated|external_content/);
  });

  it("출처 열 조회는 범위 안의 id만 돌려준다", async () => {
    const map = await loadFragmentProvenance(
      [`${TAG}-core-ok`, `${TAG}-anchor-null`, "missing-id"],
      { agentId: "default", keyId: null, groupKeyIds: null, workspace: null },
      getPrimaryPool
    );
    assert.deepEqual(map.get(`${TAG}-core-ok`), { source: null, origin: "tool_output", trustTier: 2 });
    assert.deepEqual(map.get(`${TAG}-anchor-null`), { source: null, origin: null, trustTier: null });
    assert.equal(map.has("missing-id"), false);

    await client.query(
      `INSERT INTO agent_memory.fragments (id, content, topic, keywords, type, importance, content_hash, agent_id, valid_from, trust_tier)
       VALUES ($1, 'agent a body', $2, ARRAY['prv']::text[], 'fact', 0.5, md5($1), 'prv-agent-a', NOW(), 1)`,
      [`${TAG}-agent-a`, `prv-${TAG}`]
    );
    const ownAgent   = await loadFragmentProvenance([`${TAG}-agent-a`], { agentId: "prv-agent-a", keyId: null }, getPrimaryPool);
    const otherAgent = await loadFragmentProvenance([`${TAG}-agent-a`], { agentId: "prv-agent-b", keyId: null }, getPrimaryPool);
    assert.equal(ownAgent.get(`${TAG}-agent-a`).trustTier, 1);
    assert.equal(otherAgent.size, 0);
  });
});
