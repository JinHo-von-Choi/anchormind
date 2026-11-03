/**
 * 키·workspace별 보존 정책 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * workspace 정책이 키 전체 정책보다 우선하는지, 앵커와 정책 없는 키의 파편은 남는지, 지운 파편의 링크가
 * 함께 정리되는지 본다. 실행마다 전용 데이터베이스를 만들어 쓰고 끝나면 지운다.
 */
import crypto                  from "node:crypto";
import { describe, it, after } from "node:test";
import assert                  from "node:assert/strict";

const { prepareLaneDatabase, dropLaneDatabase, directQuery } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool }                      = await import("../../lib/tools/db.js");
const { createApiKey }                      = await import("../../lib/admin/ApiKeyStore.js");
const { setRetentionPolicy, listRetentionPolicies } = await import("../../lib/admin/RetentionPolicyStore.js");
const { deleteRetentionExpired }            = await import("../../lib/memory/consolidate/RetentionGC.js");

after(async () => {
  await shutdownPool();
  await dropLaneDatabase();
});

/** created_at을 days일 전으로 둔 파편 하나를 넣고 id를 돌려준다. */
async function aged(keyId, workspace, days, { anchor = false } = {}) {
  const id = crypto.randomUUID();
  await directQuery(
    `INSERT INTO agent_memory.fragments
       (id, content, type, topic, importance, ttl_tier, agent_id, keywords, content_hash, key_id, workspace, is_anchor, created_at)
     VALUES ($1, 'retention ' || $1, 'fact', 'retention', 0.5, 'permanent', 'default', '{}', md5($1), $2, $3, $4,
             NOW() - make_interval(days => $5))`,
    [id, keyId, workspace, anchor, days]
  );
  return id;
}

async function alive(ids) {
  const { rows } = await directQuery("SELECT id FROM agent_memory.fragments WHERE id = ANY($1::text[])", [ids]);
  return new Set(rows.map((r) => r.id));
}

describe("키·workspace별 보존 정책", () => {
  it("workspace 정책이 키 전체 정책보다 우선하고, 앵커와 정책 없는 키의 파편은 남는다", async () => {
    const key   = (await createApiKey({ name: `ret-${crypto.randomUUID().slice(0, 8)}` })).id;
    const other = (await createApiKey({ name: `ret-other-${crypto.randomUUID().slice(0, 8)}` })).id;
    await setRetentionPolicy(key, { workspace: null, maxAgeDays: 30 });
    await setRetentionPolicy(key, { workspace: "short", maxAgeDays: 10 });

    const ids = {
      shortOld   : await aged(key, "short", 15),
      shortNew   : await aged(key, "short", 5),
      otherWsOld : await aged(key, "long", 40),
      otherWsMid : await aged(key, "long", 15),
      globalOld  : await aged(key, null, 40),
      anchorOld  : await aged(key, "short", 100, { anchor: true }),
      noPolicy   : await aged(other, "short", 100)
    };
    await directQuery(
      "INSERT INTO agent_memory.fragment_links (from_id, to_id, relation_type, weight) VALUES ($1, $2, 'related', 1)",
      [ids.shortOld, ids.shortNew]
    );

    const deleted = await deleteRetentionExpired();
    assert.equal(deleted, 3);
    const left = await alive(Object.values(ids));
    assert.deepEqual(
      Object.entries(ids).filter(([, id]) => left.has(id)).map(([name]) => name).sort(),
      ["anchorOld", "noPolicy", "otherWsMid", "shortNew"]
    );
    const { rows } = await directQuery("SELECT count(*)::int AS n FROM agent_memory.fragment_links WHERE from_id = $1", [ids.shortOld]);
    assert.equal(rows[0].n, 0);
  });

  it("정책은 같은 범위에 하나이고, 일수를 null로 주면 지운다", async () => {
    const key = (await createApiKey({ name: `ret-set-${crypto.randomUUID().slice(0, 8)}` })).id;
    assert.equal((await setRetentionPolicy(key, { workspace: "w", maxAgeDays: 7 })).previous, null);
    assert.equal((await setRetentionPolicy(key, { workspace: "w", maxAgeDays: 9 })).previous, 7);
    await setRetentionPolicy(key, { workspace: null, maxAgeDays: 90 });
    assert.deepEqual((await listRetentionPolicies(key)).map((p) => [p.workspace, p.max_age_days]), [[null, 90], ["w", 9]]);
    await setRetentionPolicy(key, { workspace: "w", maxAgeDays: null });
    assert.deepEqual((await listRetentionPolicies(key)).map((p) => [p.workspace, p.max_age_days]), [[null, 90]]);
  });
});
