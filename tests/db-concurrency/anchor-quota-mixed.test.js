/**
 * 앵커 상한 잠금과 다른 쓰기 경로를 섞은 동시 실행 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-04
 *
 * 한 키에 앵커 항목이 든 일괄 저장, 앵커 단건 기록(자체 트랜잭션, 호출자 트랜잭션), 일반 단건 기록,
 * 일반 일괄 저장, 앵커 amend를 24건 동시에 여러 번 실행해 교착(40P01)이 0건이고 살아 있는 앵커가
 * 상한을 넘지 않는지 본다. 같은 키가 같은 본문을 동시에 쓰는 쌍(앵커와 일반 단건, 앵커와 앵커, 일괄 저장의
 * 앵커 항목과 일반 단건, 앵커 amend와 그 본문의 단건)도 40쌍씩 실행해 교착이 0건인지 본다.
 * fragments.key_id 외래키가 있는 경우(새 설치)와 없는 경우를 모두 실행한다.
 * 실행마다 전용 데이터베이스를 만들어 쓰고 끝나면 지운다.
 */
import crypto                  from "node:crypto";
import { describe, it, after } from "node:test";
import assert                  from "node:assert/strict";

const {
  prepareLaneDatabase, dropLaneDatabase, directQuery, readDeadlockCount, deadlockDelta
} = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool, getPrimaryPool }   = await import("../../lib/tools/db.js");
const { createApiKey, getAnchorState }   = await import("../../lib/admin/ApiKeyStore.js");
const { WriteGate, WRITE_ENTRIES }       = await import("../../lib/memory/write/WriteGate.js");
const { FragmentWriter }                 = await import("../../lib/memory/write/FragmentWriter.js");
const { FragmentFactory }                = await import("../../lib/memory/write/FragmentFactory.js");
const { BatchRememberProcessor }         = await import("../../lib/memory/write/BatchRememberProcessor.js");

after(async () => {
  await shutdownPool();
  await dropLaneDatabase();
});

const LIMIT   = 6;
const TRIALS  = 3;
const factory = new FragmentFactory();
const writer  = new FragmentWriter();
const gate    = new WriteGate({ getAnchorState, auditAnchor: () => {}, anchorPermissionMode: () => "warn", anchorLimit: () => LIMIT });

const PAIRS   = 40;

const text = (label) => `${label} 동시 혼합 쓰기 ${crypto.randomUUID()} 를 기록한다`;

/** remember 진입점으로 관문을 거친 생성 후보. content를 주지 않으면 새 본문을 쓴다. */
async function gatedDraft(keyId, isAnchor, content = text("단건")) {
  const { draft } = await gate.check({
    entry : WRITE_ENTRIES.REMEMBER,
    op    : "create",
    ctx   : { keyId, agentId: "default" },
    fields: { content, topic: "anchor-mix", type: "fact", isAnchor },
    build : (input) => {
      const f = factory.create(input, { contentPrepared: true });
      f.agent_id = "default";
      f.key_id   = keyId;
      return f;
    }
  });
  return draft;
}

/** atomic remember 경로와 같은 호출자 트랜잭션(api_keys 행 잠금 뒤 기록) */
async function atomicInsert(keyId, draft) {
  const client = await getPrimaryPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT fragment_limit FROM agent_memory.api_keys WHERE id = $1 FOR UPDATE", [keyId]);
    await writer.insertDetailed(draft, { client });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function batchOf(keyId, anchorItems, plainItems) {
  const item = (isAnchor) => ({ content: text("일괄"), topic: "anchor-mix", type: "fact", isAnchor });
  return {
    _keyId   : keyId,
    fragments: [...Array.from({ length: anchorItems }, () => item(true)), ...Array.from({ length: plainItems }, () => item(false))]
  };
}

async function amendToAnchor(keyId, existing) {
  const { fields } = await gate.check({
    entry: WRITE_ENTRIES.AMEND, op: "update", ctx: { keyId, agentId: "default" },
    fields: { is_anchor: true }, base: existing
  });
  return writer.update(existing.id, fields, "default", keyId, existing);
}

/** 앵커 2건과 일반 파편 3건을 가진 anchor 권한 키 */
async function seededKey() {
  const key   = await createApiKey({ name: `lane-mix-${crypto.randomUUID().slice(0, 8)}`, permissions: ["read", "write", "anchor"] });
  const seed  = async (isAnchor, n) => {
    const ids = Array.from({ length: n }, () => crypto.randomUUID());
    await directQuery(
      `INSERT INTO agent_memory.fragments (id, content, type, topic, importance, ttl_tier, agent_id, keywords, content_hash, key_id, is_anchor)
       SELECT id, 'seed ' || id, 'fact', 'anchor-mix', 0.6, 'warm', 'default', '{}', md5(id), $2, $3
         FROM unnest($1::text[]) AS id`,
      [ids, key.id, isAnchor]
    );
    return ids;
  };
  await seed(true, 2);
  const plainIds = await seed(false, 3);
  const { rows } = await directQuery("SELECT * FROM agent_memory.fragments WHERE id = ANY($1::text[])", [plainIds]);
  return { keyId: key.id, plainRows: rows };
}

/** 24건의 혼합 쓰기를 동시에 실행하고 실패 목록을 돌려준다. */
async function mixedRound() {
  const { keyId, plainRows } = await seededKey();
  const proc = new BatchRememberProcessor({ store: {}, index: { index: async () => {} }, factory, writeGate: () => gate });
  proc.setPool(getPrimaryPool());

  const ops = [
    ...Array.from({ length: 4 }, () => () => proc.process(batchOf(keyId, 2, 1))),
    ...Array.from({ length: 5 }, () => async () => writer.insertDetailed(await gatedDraft(keyId, true))),
    ...Array.from({ length: 3 }, () => async () => atomicInsert(keyId, await gatedDraft(keyId, true))),
    ...Array.from({ length: 6 }, () => async () => writer.insertDetailed(await gatedDraft(keyId, false))),
    ...Array.from({ length: 3 }, () => () => proc.process(batchOf(keyId, 0, 2))),
    ...plainRows.map(row => () => amendToAnchor(keyId, row))
  ];
  assert.equal(ops.length, 24);

  const settled = await Promise.allSettled(ops.map(op => op()));
  const failed  = settled.filter(s => s.status === "rejected").map(s => s.reason);
  return { keyId, failed };
}

/** 같은 본문을 쓰는 두 동작을 PAIRS번 동시에 실행하고 실패와 교착 증가분을 돌려준다. */
async function samePairs(makePair) {
  const before = await readDeadlockCount();
  const failed = [];
  for (let i = 0; i < PAIRS; i++) {
    const { keyId, plainRows } = await seededKey();
    const settled = await Promise.allSettled(makePair(keyId, plainRows).map(op => op()));
    for (const s of settled) if (s.status === "rejected") failed.push(`${s.reason.code ?? ""} ${s.reason.message}`);
  }
  return { failed, deadlocks: await deadlockDelta(before) };
}

const proc = () => {
  const p = new BatchRememberProcessor({ store: {}, index: { index: async () => {} }, factory, writeGate: () => gate });
  p.setPool(getPrimaryPool());
  return p;
};

/** 같은 본문 쌍의 조합. 각 항목은 (keyId, plainRows) => [동작, 동작]이다. */
const SAME_CONTENT_PAIRS = {
  "앵커 단건과 일반 단건": (keyId) => {
    const content = text("같은 본문");
    return [
      async () => writer.insertDetailed(await gatedDraft(keyId, true, content)),
      async () => writer.insertDetailed(await gatedDraft(keyId, false, content))
    ];
  },
  "앵커 단건과 앵커 단건": (keyId) => {
    const content = text("같은 본문");
    return [
      async () => writer.insertDetailed(await gatedDraft(keyId, true, content)),
      async () => writer.insertDetailed(await gatedDraft(keyId, true, content))
    ];
  },
  "일괄 저장 앵커 항목과 일반 단건": (keyId) => {
    const content = text("같은 본문");
    return [
      () => proc().process({ _keyId: keyId, fragments: [{ content, topic: "anchor-mix", type: "fact", isAnchor: true }] }),
      async () => writer.insertDetailed(await gatedDraft(keyId, false, content))
    ];
  },
  "앵커 amend와 그 본문의 일반 단건": (keyId, plainRows) => [
    () => amendToAnchor(keyId, plainRows[0]),
    async () => writer.insertDetailed(await gatedDraft(keyId, false, plainRows[0].content))
  ]
};

async function runSameContentPairs() {
  for (const [name, makePair] of Object.entries(SAME_CONTENT_PAIRS)) {
    const { failed, deadlocks } = await samePairs(makePair);
    assert.deepEqual(failed, [], name);
    assert.equal(deadlocks, 0, name);
  }
}

async function runTrials() {
  const before = await readDeadlockCount();
  for (let trial = 0; trial < TRIALS; trial++) {
    const { keyId, failed } = await mixedRound();
    assert.deepEqual(failed.map(e => `${e.code ?? ""} ${e.message}`), [], `trial ${trial}`);
    assert.ok((await getAnchorState(keyId)).anchorCount <= LIMIT, `trial ${trial} 상한 초과`);
  }
  assert.equal(await deadlockDelta(before), 0);
}

describe("앵커 상한 잠금 혼합 동시 쓰기", () => {
  it("fragments.key_id 외래키가 있는 설치에서 교착 없이 상한을 지킨다", async () => {
    const { rows } = await directQuery(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE contype = 'f' AND conrelid = 'agent_memory.fragments'::regclass AND confrelid = 'agent_memory.api_keys'::regclass`
    );
    assert.ok(rows[0].n > 0, "새 설치에는 fragments.key_id 외래키가 있다");
    await runTrials();
  });

  it("외래키가 있는 설치에서 같은 본문 동시 쓰기 쌍이 교착하지 않는다", async () => {
    await runSameContentPairs();
  });

  it("fragments.key_id 외래키가 없는 설치에서도 교착 없이 상한을 지킨다", async () => {
    const { rows } = await directQuery(
      `SELECT conname FROM pg_constraint
        WHERE contype = 'f' AND conrelid = 'agent_memory.fragments'::regclass AND confrelid = 'agent_memory.api_keys'::regclass`
    );
    for (const { conname } of rows) {
      await directQuery(`ALTER TABLE agent_memory.fragments DROP CONSTRAINT "${conname}"`);
    }
    await runTrials();
  });

  it("외래키가 없는 설치에서 같은 본문 동시 쓰기 쌍이 교착하지 않는다", async () => {
    await runSameContentPairs();
  });
});
