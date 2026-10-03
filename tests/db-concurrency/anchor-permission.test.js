/**
 * anchor 권한 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 마이그레이션을 적용한 전용 데이터베이스에서 키 권한과 살아 있는 앵커 수 조회, 권한 변경 전후 값 반환,
 * 부여 스크립트의 dry-run과 --apply를 실제 SQL로 확인한다. 실행마다 전용 데이터베이스를 만들어 쓰고
 * 끝나면 지운다.
 */
import crypto                  from "node:crypto";
import { describe, it, after } from "node:test";
import assert                  from "node:assert/strict";

const { prepareLaneDatabase, dropLaneDatabase, directQuery, directClientConfig } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool }                                  = await import("../../lib/tools/db.js");
const { createApiKey, getAnchorState, updatePermissions } = await import("../../lib/admin/ApiKeyStore.js");
const { main: grantMain }                               = await import("../../scripts/grant-anchor-permission.js");

after(async () => {
  await shutdownPool();
  await dropLaneDatabase();
});

/** 키의 파편 count건을 만든다. anchor, ageDays, closed로 앵커 여부, 생성 시점, 닫힘을 정한다. */
async function seedKeyFragments(keyId, count, { anchor = true, ageDays = 1, closed = false } = {}) {
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  await directQuery(
    `INSERT INTO agent_memory.fragments
            (id, content, type, topic, importance, ttl_tier, agent_id, keywords, content_hash,
             key_id, is_anchor, created_at, valid_to)
     SELECT id, 'anchor lane ' || id, 'fact', 'anchor-lane', 0.9, 'permanent', 'default', '{}', md5(id),
            $2, $3, now() - make_interval(days => $4), CASE WHEN $5 THEN now() ELSE NULL END
       FROM unnest($1::text[]) AS id`,
    [ids, keyId, anchor, ageDays, closed]
  );
}

/** 부여 스크립트를 실행 데이터베이스에 붙여 실행하고 JSON 보고서를 돌려준다. */
async function runGrant(extra = []) {
  const { host, port, user, password, database } = directClientConfig();
  const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
  const out = [];
  const code = await grantMain([...extra, "--url", url], {}, { out: line => out.push(line), err: () => {} });
  assert.equal(code, 0);
  return JSON.parse(out.join("\n"));
}

describe("anchor 권한 실서버", () => {
  it("getAnchorState는 권한 목록과 살아 있는 앵커 수만 센다", async () => {
    const key = await createApiKey({ name: `lane-state-${crypto.randomUUID().slice(0, 8)}`, permissions: ["read", "write"] });
    await seedKeyFragments(key.id, 3);
    await seedKeyFragments(key.id, 2, { anchor: false });
    await seedKeyFragments(key.id, 1, { closed: true });

    assert.deepEqual(await getAnchorState(key.id), { permissions: ["read", "write"], anchorCount: 3 });
    assert.equal(await getAnchorState(crypto.randomUUID()), null);
  });

  it("updatePermissions는 변경 전 권한을 함께 돌려준다", async () => {
    const key    = await createApiKey({ name: `lane-perm-${crypto.randomUUID().slice(0, 8)}`, permissions: ["read", "write"] });
    const result = await updatePermissions(key.id, ["read", "write", "anchor"]);
    assert.deepEqual(result, { permissions: ["read", "write", "anchor"], before: ["read", "write"] });
  });

  it("부여 스크립트는 dry-run에서 쓰지 않고 --apply에서 최근 90일 앵커를 만든 활성 키에만 부여한다", async () => {
    const tag      = crypto.randomUUID().slice(0, 8);
    const recent   = await createApiKey({ name: `lane-recent-${tag}`,   permissions: ["read", "write"] });
    const old      = await createApiKey({ name: `lane-old-${tag}`,      permissions: ["read", "write"] });
    const inactive = await createApiKey({ name: `lane-inactive-${tag}`, permissions: ["read", "write"] });
    const plain    = await createApiKey({ name: `lane-plain-${tag}`,    permissions: ["read", "write"] });
    const readOnly = await createApiKey({ name: `lane-readonly-${tag}`, permissions: ["read"] });
    await seedKeyFragments(recent.id, 2, { ageDays: 10 });
    await seedKeyFragments(old.id, 2, { ageDays: 120 });
    await seedKeyFragments(inactive.id, 1, { ageDays: 5 });
    await seedKeyFragments(plain.id, 4, { anchor: false, ageDays: 5 });
    await seedKeyFragments(readOnly.id, 1, { ageDays: 3 });
    await directQuery("UPDATE agent_memory.api_keys SET status = 'inactive' WHERE id = $1", [inactive.id]);

    const dry  = await runGrant();
    const mine = (report) => Object.fromEntries(report.keys.filter(k => [recent.id, old.id, inactive.id, plain.id, readOnly.id].includes(k.id)).map(k => [k.id, k.action]));
    assert.deepEqual(mine(dry), { [recent.id]: "grant", [inactive.id]: "skip_inactive", [readOnly.id]: "skip_no_write" });
    assert.deepEqual((await getAnchorState(recent.id)).permissions, ["read", "write"]);

    const applied = await runGrant(["--apply"]);
    assert.ok(applied.granted.includes(recent.id));
    assert.deepEqual((await getAnchorState(recent.id)).permissions, ["read", "write", "anchor"]);
    for (const other of [old, inactive, plain]) {
      assert.deepEqual((await getAnchorState(other.id)).permissions, ["read", "write"]);
    }
    assert.deepEqual((await getAnchorState(readOnly.id)).permissions, ["read"]);

    const again = await runGrant(["--apply"]);
    assert.equal(again.granted.includes(recent.id), false);
    assert.equal(mine(again)[recent.id], "skip_has_permission");
  });
});
