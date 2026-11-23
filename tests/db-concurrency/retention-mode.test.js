/**
 * 보존 모드(RetentionGuard) 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-11-23
 *
 * 자동 정리가 꺼진 범위에서 만료 삭제와 permanent 강등이 파편을 건드리지 않는지, 같은 키의 다른 workspace는
 * 그대로 정리되는지, 재개 대기 중에는 꺼진 것으로 다루는지, 보존 기간이 workspace 행과 키 전체 행 사이에서
 * 어떻게 정해지는지, 낮은 importance로 같은 본문을 다시 저장해도 기존 permanent 등급이 그대로인지, part_of 묶음 보호를
 * 켜면 원본이 닫힌 분할 조각이 형제가 남아 있는 동안 만료 삭제와 permanent 강등을 피하는지 본다.
 * 실행마다 전용 데이터베이스를 만들어 쓰고 끝나면 지운다.
 */
import crypto                                  from "node:crypto";
import { describe, it, before, after, beforeEach } from "node:test";
import assert                                  from "node:assert/strict";

process.env.EMBEDDING_BASE_URL = "http://127.0.0.1:9";

const { prepareLaneDatabase, dropLaneDatabase, directQuery, SCHEMA } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool }       = await import("../../lib/tools/db.js");
const { createApiKey }       = await import("../../lib/admin/ApiKeyStore.js");
const { setRetentionPolicy, setRetentionScope, listRetentionPolicies, normalizeScopeInput } =
  await import("../../lib/admin/RetentionPolicyStore.js");
const { FragmentGC }         = await import("../../lib/memory/consolidate/FragmentGC.js");
const { deleteRetentionExpired } = await import("../../lib/memory/consolidate/RetentionGC.js");
const { lifecycleGuardSql, invalidateRetentionCache } = await import("../../lib/memory/consolidate/RetentionGuard.js");
const { MemoryManager }      = await import("../../lib/memory/MemoryManager.js");

const RUN = `rm-${crypto.randomBytes(4).toString("hex")}`;
const ENV = ["MEMENTO_RETENTION_MODE", "MEMENTO_RETENTION_AUTO_AFTER", "MEMENTO_RETENTION_PROTECT_PART_OF"];

let key;

before(async () => {
  key = (await createApiKey({ name: `${RUN}-key` })).id;
});

after(async () => {
  try {
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

beforeEach(async () => {
  for (const k of ENV) delete process.env[k];
  await directQuery(`DELETE FROM ${SCHEMA}.fragments`);
  await directQuery(`DELETE FROM ${SCHEMA}.key_retention_policies`);
  invalidateRetentionCache();
});

/** 만료 삭제 후보 조건을 모두 만족하는 파편(30일 전 생성, 무접근, utility 0.01) */
async function expirable(workspace, { tier = "warm", importance = 0.5 } = {}) {
  const id = `${RUN}-${crypto.randomUUID()}`;
  await directQuery(
    `INSERT INTO ${SCHEMA}.fragments
            (id, content, type, topic, importance, ttl_tier, is_anchor, agent_id, keywords, content_hash,
             utility_score, created_at, accessed_at, key_id, workspace)
     VALUES ($1, 'rm ' || $1, 'fact', 'rm', $2, $3, FALSE, 'default', '{}', md5($1), 0.01,
             NOW() - INTERVAL '200 days', NULL, $4, $5)`,
    [id, importance, tier, key, workspace]);
  return id;
}

async function rowOf(id) {
  const { rows } = await directQuery(`SELECT id, ttl_tier, valid_to FROM ${SCHEMA}.fragments WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

const scope = (body) => setRetentionScope(key, normalizeScopeInput(body)).then((r) => { invalidateRetentionCache(); return r; });

describe("보존 모드", () => {
  it("정책 행도 전역 설정도 없으면 대상 질의에 조건을 붙이지 않는다", async () => {
    assert.equal(await lifecycleGuardSql("f"), "");
  });

  it("전역 manual이면 만료 삭제와 permanent 강등이 파편을 건드리지 않고, auto로 되돌리면 지운다", async () => {
    process.env.MEMENTO_RETENTION_MODE = "manual";
    const warm = await expirable("ws-a");
    const perm = await expirable("ws-a", { tier: "permanent", importance: 0.2 });
    const gc   = new FragmentGC();
    assert.equal(await gc.deleteExpired(), 0);
    await gc.transitionTTL();
    assert.ok(await rowOf(warm));
    assert.equal((await rowOf(perm)).ttl_tier, "permanent");

    process.env.MEMENTO_RETENTION_MODE = "auto";
    await gc.transitionTTL();
    assert.equal((await rowOf(perm)).ttl_tier, "cold");
    assert.ok(await gc.deleteExpired() >= 1);
    assert.equal(await rowOf(warm), null);
  });

  it("잘못된 전역 값은 manual로 읽는다", async () => {
    process.env.MEMENTO_RETENTION_MODE = "manaul";
    const id = await expirable("ws-a");
    assert.equal(await new FragmentGC().deleteExpired(), 0);
    assert.ok(await rowOf(id));
  });

  it("workspace 하나만 끄면 그 workspace는 남고 같은 키의 다른 workspace는 정리된다", async () => {
    await scope({ workspace: "keep", autoLifecycle: false });
    const kept = await expirable("keep");
    const gone = await expirable("other");
    await new FragmentGC().deleteExpired();
    assert.ok(await rowOf(kept));
    assert.equal(await rowOf(gone), null);
  });

  it("다시 켜면 재개 시각 전에는 꺼진 것으로 다루고, 0일이면 바로 정리한다", async () => {
    await scope({ workspace: null, autoLifecycle: false });
    const r = await scope({ workspace: null, autoLifecycle: true, resumeAfterDays: 7 });
    assert.ok(r.after.auto_resume_at);
    const id = await expirable("ws-a");
    assert.equal(await new FragmentGC().deleteExpired(), 0);

    await scope({ workspace: null, autoLifecycle: false });
    const cleared = await scope({ workspace: null, autoLifecycle: true, resumeAfterDays: 0 });
    assert.equal(cleared.after, null);
    assert.ok(await new FragmentGC().deleteExpired() >= 1);
    assert.equal(await rowOf(id), null);
  });

  it("전역 재개 시각이 미래면 auto여도 정리하지 않는다", async () => {
    process.env.MEMENTO_RETENTION_AUTO_AFTER = new Date(Date.now() + 86_400_000).toISOString();
    const id = await expirable("ws-a");
    assert.equal(await new FragmentGC().deleteExpired(), 0);
    assert.ok(await rowOf(id));
  });
});

describe("보존 기간 판정", () => {
  it("workspace 행이 만료 없음이면 키 전체 기간이 있어도 지우지 않고, 모드만 정한 행은 키 전체 기간을 따른다", async () => {
    await setRetentionPolicy(key, { workspace: null, maxAgeDays: 30 });
    await scope({ workspace: "archive", noExpiry: true });
    await scope({ workspace: "manual", autoLifecycle: false });
    const archive = await expirable("archive");
    const manual  = await expirable("manual");
    const plain   = await expirable("plain");
    await deleteRetentionExpired();
    assert.ok(await rowOf(archive));
    assert.equal(await rowOf(manual), null);
    assert.equal(await rowOf(plain), null);
  });

  it("기존 일수 API의 목록에는 일수 행만 나오고, 일수를 지워도 자동 정리 설정은 남는다", async () => {
    await scope({ workspace: "w", autoLifecycle: false });
    await setRetentionPolicy(key, { workspace: "w", maxAgeDays: 10 });
    assert.deepEqual((await listRetentionPolicies(key)).map((p) => [p.workspace, p.max_age_days]), [["w", 10]]);
    await setRetentionPolicy(key, { workspace: "w", maxAgeDays: null });
    assert.deepEqual(await listRetentionPolicies(key), []);
    const { rows } = await directQuery(
      `SELECT max_age_days, auto_lifecycle FROM ${SCHEMA}.key_retention_policies WHERE key_id = $1 AND workspace = 'w'`, [key]);
    assert.deepEqual(rows, [{ max_age_days: null, auto_lifecycle: false }]);
  });
});

describe("낮은 importance 중복 저장", () => {
  it("같은 본문을 importance 0.2로 다시 저장해도 기존 permanent 등급이 그대로다", async () => {
    const mm  = new MemoryManager();
    const ctx = { _keyId: key, _groupKeyIds: [key], workspace: "dup", agentId: "default" };
    const content = `${RUN} 배포 서버의 백업 스크립트는 매일 03시에 덤프를 다른 호스트로 복사한다`;
    const first = await mm.remember({ ...ctx, content, topic: RUN, type: "fact", importance: 0.9 });
    assert.equal((await rowOf(first.id)).ttl_tier, "permanent");
    const again = await mm.remember({ ...ctx, content, topic: RUN, type: "fact", importance: 0.2 });
    assert.equal(again.id, first.id);
    assert.equal((await rowOf(first.id)).ttl_tier, "permanent");
  });

  it("자동 정리가 꺼진 범위면 중복 저장 방지 장치의 응답에도 retention을 싣는다", async () => {
    process.env.MEMENTO_REMEMBER_DUPLICATE_GUARD = "true";
    try {
      await scope({ workspace: "dup", autoLifecycle: false });
      const mm  = new MemoryManager();
      const ctx = { _keyId: key, _groupKeyIds: [key], workspace: "dup", agentId: "default" };
      const content = `${RUN} 야간 배치는 끝나면 결과 요약을 운영 채널에 한 줄로 남긴다`;
      await mm.remember({ ...ctx, content, topic: RUN, type: "fact", importance: 0.9 });
      const again = await mm.remember({ ...ctx, content, topic: RUN, type: "fact", importance: 0.2 });
      assert.equal(again.existing, true);
      assert.deepEqual(again.retention, { mode: "manual" });
    } finally {
      delete process.env.MEMENTO_REMEMBER_DUPLICATE_GUARD;
    }
  });
});

describe("part_of 묶음 보호", () => {
  /** 분할 결과와 같은 모양: 원본은 닫혀 있고, 조각 둘이 source split:원본과 part_of 링크로 원본을 가리킨다 */
  async function splitGroup({ tier = "warm" } = {}) {
    const parent = await expirable("ws-a");
    await directQuery(`UPDATE ${SCHEMA}.fragments SET valid_to = NOW() WHERE id = $1`, [parent]);
    const pieces = [await expirable("ws-a", { tier, importance: 0.2 }), await expirable("ws-a", { tier, importance: 0.2 })];
    for (const id of pieces) {
      await directQuery(`UPDATE ${SCHEMA}.fragments SET source = 'split:' || $2 WHERE id = $1`, [id, parent]);
      await directQuery(`INSERT INTO ${SCHEMA}.fragment_links (from_id, to_id, relation_type) VALUES ($1, $2, 'part_of')`, [id, parent]);
    }
    return pieces;
  }

  it("켜면 형제가 남아 있는 분할 조각을 만료 삭제와 permanent 강등에서 빼고, 끄면 지금처럼 지운다", async () => {
    process.env.MEMENTO_RETENTION_PROTECT_PART_OF = "true";
    const [a, b] = await splitGroup();
    const [p]    = await splitGroup({ tier: "permanent" });
    const gc     = new FragmentGC();
    await gc.deleteExpired();
    await gc.transitionTTL();
    assert.ok(await rowOf(a));
    assert.ok(await rowOf(b));
    assert.equal((await rowOf(p)).ttl_tier, "permanent");

    delete process.env.MEMENTO_RETENTION_PROTECT_PART_OF;
    await gc.deleteExpired();
    assert.equal(await rowOf(a), null);
    assert.equal(await rowOf(b), null);
  });

  it("켜도 형제가 모두 닫힌 조각은 지운다", async () => {
    process.env.MEMENTO_RETENTION_PROTECT_PART_OF = "true";
    const [a, b] = await splitGroup();
    await directQuery(`UPDATE ${SCHEMA}.fragments SET valid_to = NOW() WHERE id = $1`, [b]);
    await new FragmentGC().deleteExpired();
    assert.equal(await rowOf(a), null);
  });
});
