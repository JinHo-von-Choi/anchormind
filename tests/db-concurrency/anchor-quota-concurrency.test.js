/**
 * 키별 앵커 상한 동시 쓰기 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 상한 3, 기존 앵커 2인 키에 앵커 지정을 동시에 여러 건 보내도 살아 있는 앵커가 3을 넘지 않는지
 * 단건 기록(자체 트랜잭션, 호출자 트랜잭션), amend, 일괄 저장에서 확인한다. warn은 넘는 요청을
 * 일반 파편으로 저장하고 enforce는 거부한다. 실행마다 전용 데이터베이스를 만들어 쓰고 끝나면 지운다.
 */
import crypto                  from "node:crypto";
import { describe, it, after } from "node:test";
import assert                  from "node:assert/strict";

const { prepareLaneDatabase, dropLaneDatabase, directQuery } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool, getPrimaryPool }        = await import("../../lib/tools/db.js");
const { createApiKey, getAnchorState }        = await import("../../lib/admin/ApiKeyStore.js");
const { WriteGate, WRITE_ENTRIES }            = await import("../../lib/memory/write/WriteGate.js");
const { FragmentWriter }                      = await import("../../lib/memory/write/FragmentWriter.js");
const { FragmentFactory }                     = await import("../../lib/memory/write/FragmentFactory.js");
const { BatchRememberProcessor }              = await import("../../lib/memory/write/BatchRememberProcessor.js");

after(async () => {
  await shutdownPool();
  await dropLaneDatabase();
});

const LIMIT   = 3;
const factory = new FragmentFactory();
const writer  = new FragmentWriter();

/** anchor 권한 키를 만들고 기존 앵커 existing건을 넣는다. */
async function anchorKey(existing) {
  const key = await createApiKey({ name: `lane-quota-${crypto.randomUUID().slice(0, 8)}`, permissions: ["read", "write", "anchor"] });
  const ids = Array.from({ length: existing }, () => crypto.randomUUID());
  await directQuery(
    `INSERT INTO agent_memory.fragments (id, content, type, topic, importance, ttl_tier, agent_id, keywords, content_hash, key_id, is_anchor)
     SELECT id, 'seed anchor ' || id, 'fact', 'anchor-quota', 0.9, 'permanent', 'default', '{}', md5(id), $2, TRUE
       FROM unnest($1::text[]) AS id`,
    [ids, key.id]
  );
  return key.id;
}

function gateOf(mode) {
  return new WriteGate({ getAnchorState, auditAnchor: () => {}, anchorPermissionMode: () => mode, anchorLimit: () => LIMIT });
}

async function liveAnchors(keyId) {
  return (await getAnchorState(keyId)).anchorCount;
}

/** remember 진입점으로 관문을 거친 앵커 생성 후보 */
async function gatedAnchorDraft(gate, keyId) {
  const { draft } = await gate.check({
    entry : WRITE_ENTRIES.REMEMBER,
    op    : "create",
    ctx   : { keyId, agentId: "default" },
    fields: { content: `동시 앵커 요청 ${crypto.randomUUID()} 를 기록한다`, topic: "anchor-quota", type: "fact", isAnchor: true },
    build : (input) => {
      const f = factory.create(input, { contentPrepared: true });
      f.agent_id = "default";
      f.key_id   = keyId;
      return f;
    }
  });
  return draft;
}

describe("키별 앵커 상한 동시 쓰기", () => {
  it("warn: 동시 단건 기록 6건에서 상한까지만 앵커이고 나머지는 경고와 함께 일반 파편이다", async () => {
    const keyId  = await anchorKey(2);
    const gate   = gateOf("warn");
    const drafts = await Promise.all(Array.from({ length: 6 }, () => gatedAnchorDraft(gate, keyId)));
    await Promise.all(drafts.map(d => writer.insertDetailed(d)));

    assert.equal(await liveAnchors(keyId), LIMIT);
    const limited = drafts.filter(d => (d.validation_warnings ?? []).some(v => v.rule === "anchorLimitExceeded"));
    assert.equal(limited.length, 5);
    assert.ok(limited.every(d => d.is_anchor === false));
  });

  it("enforce: 동시 단건 기록 6건에서 한 건만 앵커로 저장되고 나머지는 거부된다", async () => {
    const keyId   = await anchorKey(2);
    const gate    = gateOf("enforce");
    const drafts  = await Promise.all(Array.from({ length: 6 }, () => gatedAnchorDraft(gate, keyId)));
    const settled = await Promise.allSettled(drafts.map(d => writer.insertDetailed(d)));

    assert.equal(settled.filter(s => s.status === "fulfilled").length, 1);
    assert.ok(settled.filter(s => s.status === "rejected").every(s => s.reason.name === "SymbolicPolicyViolationError"));
    assert.equal(await liveAnchors(keyId), LIMIT);
    const { rows } = await directQuery("SELECT count(*)::int AS n FROM agent_memory.fragments WHERE key_id = $1", [keyId]);
    assert.equal(rows[0].n, LIMIT);
  });

  it("호출자 트랜잭션(atomic remember 경로)에서도 상한을 지킨다", async () => {
    const keyId  = await anchorKey(2);
    const gate   = gateOf("warn");
    const drafts = await Promise.all(Array.from({ length: 4 }, () => gatedAnchorDraft(gate, keyId)));
    await Promise.all(drafts.map(async (d) => {
      const client = await getPrimaryPool().connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT fragment_limit FROM agent_memory.api_keys WHERE id = $1 FOR UPDATE", [keyId]);
        await writer.insertDetailed(d, { client });
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    }));
    assert.equal(await liveAnchors(keyId), LIMIT);
  });

  it("amend: 동시에 네 파편을 앵커로 바꿔도 상한까지만 바뀐다", async () => {
    const keyId = await anchorKey(2);
    const gate  = gateOf("warn");
    const ids   = Array.from({ length: 4 }, () => crypto.randomUUID());
    await directQuery(
      `INSERT INTO agent_memory.fragments (id, content, type, topic, importance, ttl_tier, agent_id, keywords, content_hash, key_id, is_anchor)
       SELECT id, 'plain ' || id, 'fact', 'anchor-quota', 0.5, 'warm', 'default', '{}', md5(id), $2, FALSE
         FROM unnest($1::text[]) AS id`,
      [ids, keyId]
    );
    const { rows } = await directQuery("SELECT * FROM agent_memory.fragments WHERE id = ANY($1::text[])", [ids]);
    await Promise.all(rows.map(async (existing) => {
      const { fields } = await gate.check({
        entry: WRITE_ENTRIES.AMEND, op: "update", ctx: { keyId, agentId: "default" },
        fields: { is_anchor: true }, base: existing
      });
      return writer.update(existing.id, fields, "default", keyId, existing);
    }));
    assert.equal(await liveAnchors(keyId), LIMIT);
  });

  it("일괄 저장: 동시 배치 두 개의 앵커 항목 여섯 건에서 상한까지만 앵커다", async () => {
    const keyId = await anchorKey(1);
    const proc  = new BatchRememberProcessor({ store: {}, index: { index: async () => {} }, factory, writeGate: () => gateOf("warn") });
    proc.setPool(getPrimaryPool());
    const batch = () => ({
      _keyId   : keyId,
      fragments: Array.from({ length: 3 }, () => ({
        content: `동시 일괄 앵커 항목 ${crypto.randomUUID()} 를 기록한다`, topic: "anchor-quota", type: "fact", isAnchor: true
      }))
    });
    const outs = await Promise.all([proc.process(batch()), proc.process(batch())]);
    assert.equal(await liveAnchors(keyId), LIMIT);
    const warned = outs.flatMap(o => o.results).filter(r => (r.validation_warnings ?? []).includes("anchorLimitExceeded"));
    assert.equal(warned.length, 4);
  });
});
