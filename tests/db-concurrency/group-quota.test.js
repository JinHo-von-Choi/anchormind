/**
 * 키 그룹 파편 상한 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * 그룹 상한은 멤버 키 전체의 살아 있는 파편 수다. 같은 그룹의 두 멤버가 동시에 저장해도 상한을 넘지 않는지,
 * 넘는 저장은 scope=group인 fragment_limit_exceeded로 거부되는지, 일괄 저장은 남은 수만큼만 넣는지,
 * 키 상한이 더 빡빡하면 키 상한이 먼저 걸리는지 본다. 실행마다 전용 데이터베이스를 만들어 쓰고 끝나면 지운다.
 */
import crypto                  from "node:crypto";
import { describe, it, after } from "node:test";
import assert                  from "node:assert/strict";

const { prepareLaneDatabase, dropLaneDatabase, directQuery } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool, getPrimaryPool } = await import("../../lib/tools/db.js");
const { createApiKey, createKeyGroup, updateGroupFragmentLimit, updateFragmentLimit } = await import("../../lib/admin/ApiKeyStore.js");
const { addGroupMember }               = await import("../../lib/admin/group-access.js");
const { lockQuota, quotaExceededError } = await import("../../lib/memory/read/quotaQueries.js");
const { QuotaChecker, clearUsageCache } = await import("../../lib/memory/QuotaChecker.js");
const { BatchRememberProcessor }       = await import("../../lib/memory/write/BatchRememberProcessor.js");
const { FragmentFactory }              = await import("../../lib/memory/write/FragmentFactory.js");

after(async () => {
  await shutdownPool();
  await dropLaneDatabase();
});

const tag = () => crypto.randomUUID().slice(0, 8);

async function seed(keyId, count) {
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  await directQuery(
    `INSERT INTO agent_memory.fragments (id, content, type, topic, importance, ttl_tier, agent_id, keywords, content_hash, key_id)
     SELECT id, 'group quota seed ' || id, 'fact', 'group-quota', 0.5, 'warm', 'default', '{}', md5(id), $2
       FROM unnest($1::text[]) AS id`,
    [ids, keyId]
  );
}

async function liveCount(keyIds) {
  const { rows } = await directQuery(
    "SELECT count(*)::int AS n FROM agent_memory.fragments WHERE valid_to IS NULL AND key_id = ANY($1::text[])", [keyIds]
  );
  return rows[0].n;
}

/** 그룹과 멤버 키 둘을 만든다. */
async function groupWithMembers(limit) {
  const a = (await createApiKey({ name: `gq-a-${tag()}`, permissions: ["read", "write"] })).id;
  const b = (await createApiKey({ name: `gq-b-${tag()}`, permissions: ["read", "write"] })).id;
  const g = await createKeyGroup({ name: `gq-${tag()}` });
  await addGroupMember(a, g.id);
  await addGroupMember(b, g.id);
  if (limit !== undefined) await updateGroupFragmentLimit(g.id, limit);
  return { a, b, groupId: g.id };
}

/** 저장 경로와 같이 잠금 판정 뒤 한 건을 넣는다. 거부되면 오류를 던진다. */
async function guardedInsert(keyId) {
  const client = await getPrimaryPool().connect();
  try {
    await client.query("BEGIN");
    const quota = await lockQuota(client, keyId);
    if (quota && quota.remaining <= 0) throw quotaExceededError(quota);
    const id = crypto.randomUUID();
    await client.query(
      `INSERT INTO agent_memory.fragments (id, content, type, topic, importance, ttl_tier, agent_id, keywords, content_hash, key_id)
       VALUES ($1, 'group quota write ' || $1, 'fact', 'group-quota', 0.5, 'warm', 'default', '{}', md5($1), $2)`,
      [id, keyId]
    );
    await client.query("COMMIT");
    return id;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

describe("키 그룹 파편 상한", () => {
  it("두 멤버가 동시에 저장해도 그룹 전체가 상한을 넘지 않고, 넘는 저장은 그룹 상한으로 거부된다", async () => {
    const { a, b, groupId } = await groupWithMembers();
    await seed(a, 2);
    await seed(b, 1);
    await updateGroupFragmentLimit(groupId, 6);

    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => guardedInsert(i % 2 ? a : b)));
    const ok      = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter((r) => r.status === "rejected").map((r) => r.reason);
    assert.equal(ok, 3);
    assert.equal(await liveCount([a, b]), 6);
    assert.equal(refused.length, 5);
    for (const err of refused) {
      assert.equal(err.code, "fragment_limit_exceeded");
      assert.equal(err.scope, "group");
      assert.equal(err.groupId, String(groupId));
    }
  });

  it("상한은 멤버 키 파편 수보다 낮게 정할 수 없고, 상한이 없으면 검사기가 그룹을 보지 않는다", async () => {
    const { a, groupId } = await groupWithMembers();
    await seed(a, 3);
    const below = await updateGroupFragmentLimit(groupId, 2);
    assert.equal(below.belowUsage, true);
    assert.equal(below.used, 3);

    clearUsageCache();
    const usage = await new QuotaChecker().getUsage(a);
    assert.equal(usage.limit, null);
  });

  it("키 상한이 그룹 상한보다 먼저 차면 키 상한으로 거부한다", async () => {
    const { a } = await groupWithMembers(100);
    await updateFragmentLimit(a, 1);
    await guardedInsert(a);
    await assert.rejects(() => guardedInsert(a), (err) => err.scope === "key" && err.limit === 1);
    clearUsageCache();
    const usage = await new QuotaChecker().getUsage(a);
    assert.equal(usage.scope, "key");
    assert.equal(usage.remaining, 0);
  });

  it("검사기가 넉넉한 남은 수를 캐시해 두어도 다른 멤버가 그룹 상한을 채우면 다음 검사가 거부한다", async () => {
    const { a, b, groupId } = await groupWithMembers();
    await updateGroupFragmentLimit(groupId, 40);
    clearUsageCache();
    const checker = new QuotaChecker();
    assert.equal((await checker.getUsage(b)).groupLimited, true);
    await checker.check(b);
    await seed(a, 40);
    await assert.rejects(() => checker.check(b), (err) => err.code === "fragment_limit_exceeded" && err.scope === "group");
  });

  it("일괄 저장은 그룹에 남은 수만큼만 넣는다", async () => {
    const { a, b, groupId } = await groupWithMembers();
    await seed(b, 4);
    await updateGroupFragmentLimit(groupId, 6);
    const processor = new BatchRememberProcessor({ store: {}, index: { index: async () => {} }, factory: new FragmentFactory() });
    processor.setPool(getPrimaryPool());
    const result    = await processor.process({
      fragments: Array.from({ length: 4 }, (_, i) => ({ content: `일괄 저장 그룹 상한 시험 항목 ${i} ${tag()}`, topic: "group-quota", type: "fact" })),
      _keyId   : a
    });
    assert.equal(result.inserted, 2);
    assert.equal(result.results.filter((r) => r.error === "fragment_limit_exceeded").length, 2);
    assert.equal(await liveCount([a, b]), 6);
  });
});
