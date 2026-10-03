/**
 * 관리자 계정 저장소 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 1. 부트스트랩 경쟁: 계정 0개에서 여러 연결이 동시에 첫 owner를 만들면 하나만 성공한다(advisory 잠금).
 * 2. 마지막 owner 경쟁: owner 둘이 서로를 동시에 강등, 비활성화, 삭제해도 활성 owner가 하나 이상 남는다.
 * 3. 세션 폐기 연쇄: 회전, 계열 폐기, 역할 변경, 비활성화, 비상 복구가 세션을 폐기하고 외래 키가 삭제를 잇는다.
 * 4. TOTP 단계와 복구 코드는 동시 사용에서 한 번만 통과한다.
 */
import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import pg                              from "pg";

process.env.MEMENTO_AUDIT_DB = "off";

const { prepareLaneDatabase, dropLaneDatabase, directClientConfig } = await import("./_harness.js");

await prepareLaneDatabase();

const { AdminUserStore, AdminUserStoreError } = await import("../../lib/admin/AdminUserStore.js");
const { newSessionValues, rotatedSessionValues } = await import("../../lib/admin/admin-session-policy.js");
const { runRecover } = await import("../../lib/cli/admin.js");

const HASH = "$scrypt$ln=10,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** 연결마다 따로인 풀(경쟁을 실제 서로 다른 세션으로 만든다) */
const pools = [];
function newStore() {
  const pool = new pg.Pool({ ...directClientConfig(), max: 4 });
  pools.push(pool);
  return new AdminUserStore(pool);
}

let store;
let client;

before(async () => {
  store  = newStore();
  client = new pg.Client(directClientConfig());
  await client.connect();
});

after(async () => {
  await client?.end();
  await Promise.all(pools.map((p) => p.end()));
  await dropLaneDatabase();
});

async function reset() {
  await client.query("DELETE FROM agent_memory.admin_users");
}

async function activeOwners() {
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM agent_memory.admin_users u
    WHERE u.status = 'active' AND EXISTS (SELECT 1 FROM agent_memory.admin_role_bindings b
      WHERE b.user_id = u.id AND b.role = 'owner' AND b.workspace IS NULL)`);
  return rows[0].n;
}

describe("마이그레이션", () => {
  it("표 다섯 개와 감사 행위자 종류 admin을 받는 제약이 있다", async () => {
    const { rows } = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'agent_memory'
      AND table_name IN ('admin_users','admin_sessions','admin_role_bindings','admin_recovery_codes','admin_identities') ORDER BY 1`);
    assert.equal(rows.length, 5);
    const def = await client.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
      WHERE conrelid = 'agent_memory.admin_audit_events'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%actor_kind%'`);
    assert.equal(def.rows.length, 1);
    assert.match(def.rows[0].d, /'admin'/);
  });
});

describe("부트스트랩 경쟁", () => {
  it("계정 0개에서 동시 부트스트랩 8건 중 하나만 성공하고 나머지는 already_bootstrapped다", async () => {
    await reset();
    const stores = Array.from({ length: 8 }, () => newStore());
    const results = await Promise.allSettled(stores.map((s, i) =>
      s.bootstrapOwner({ username: `owner${i}`, norm: `owner${i}`, passwordHash: HASH, createdBy: "master" })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of results.filter((x) => x.status === "rejected")) {
      assert.ok(r.reason instanceof AdminUserStoreError && r.reason.code === "already_bootstrapped", String(r.reason));
    }
    assert.equal(await store.countUsers(), 1);
    assert.equal(await activeOwners(), 1);
  });

  it("계정이 0개면 일반 생성은 bootstrap_required다", async () => {
    await reset();
    await assert.rejects(store.createUser({ username: "v", norm: "v", passwordHash: HASH, bindings: [{ role: "viewer", workspace: null }] }),
      (e) => e.code === "bootstrap_required");
  });
});

describe("마지막 owner 경쟁", () => {
  async function twoOwners() {
    await reset();
    const a = await store.bootstrapOwner({ username: "a", norm: "a", passwordHash: HASH, createdBy: "master" });
    const b = await store.createUser({ username: "b", norm: "b", passwordHash: HASH, bindings: [{ role: "owner", workspace: null }], createdBy: a.id });
    return [a.id, b.id];
  }

  const changes = {
    demote : (s, id) => s.setRoles(id, [{ role: "viewer", workspace: null }], { createdBy: "t" }),
    disable: (s, id) => s.updateUser(id, { status: "disabled" }),
    delete : (s, id) => s.deleteUser(id)
  };

  for (const [name, change] of Object.entries(changes)) {
    it(`owner 둘을 동시에 ${name}하면 하나는 last_owner로 거절되고 활성 owner가 하나 남는다(10회)`, async () => {
      for (let round = 0; round < 10; round++) {
        const [a, b] = await twoOwners();
        const s1 = newStore();
        const s2 = newStore();
        const results = await Promise.allSettled([change(s1, a), change(s2, b)]);
        const rejected = results.filter((r) => r.status === "rejected");
        assert.equal(rejected.length, 1, `round ${round}`);
        assert.equal(rejected[0].reason.code, "last_owner");
        assert.equal(await activeOwners(), 1, `round ${round}`);
      }
    });
  }

  it("다른 owner가 있으면 강등할 수 있고 마지막 하나는 거절한다", async () => {
    const [a, b] = await twoOwners();
    await changes.demote(store, b);
    await assert.rejects(changes.demote(store, a), (e) => e.code === "last_owner");
    await assert.rejects(changes.disable(store, a), (e) => e.code === "last_owner");
    await assert.rejects(changes.delete(store, a), (e) => e.code === "last_owner");
    assert.equal(await activeOwners(), 1);
  });
});

describe("세션 폐기 연쇄", () => {
  async function userWithSessions(n) {
    await reset();
    const u = await store.bootstrapOwner({ username: "s", norm: "s", passwordHash: HASH, createdBy: "master" });
    const rows = [];
    for (let i = 0; i < n; i++) {
      const v = newSessionValues({ userId: u.id, now: Date.now() });
      await store.insertSession(v.row);
      rows.push(v.row);
    }
    return { userId: u.id, rows };
  }

  async function active(userId) {
    const { rows } = await client.query("SELECT count(*)::int AS n FROM agent_memory.admin_sessions WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    return rows[0].n;
  }

  it("회전은 옛 세션을 rotated로 폐기하고 같은 계열의 새 세션을 넣으며, 이미 폐기된 세션은 회전하지 않는다", async () => {
    const { userId, rows } = await userWithSessions(1);
    const next = rotatedSessionValues(rows[0], { now: Date.now() });
    assert.equal(await store.rotateSession(rows[0].id, next.row), true);
    const old = await store.findSession(rows[0].token_hash);
    assert.equal(old.revoke_reason, "rotated");
    assert.equal((await store.findSession(next.row.token_hash)).family_id, rows[0].family_id);
    const again = rotatedSessionValues(rows[0], { now: Date.now() });
    assert.equal(await store.rotateSession(rows[0].id, again.row), false);
    assert.equal(await store.findSession(again.row.token_hash), null);
    assert.equal(await store.revokeFamily(rows[0].family_id, "rotated_token_reused"), 1);
    assert.equal(await active(userId), 0);
  });

  it("동시 회전 두 건 중 하나만 새 세션을 만든다", async () => {
    const { rows } = await userWithSessions(1);
    const a = rotatedSessionValues(rows[0], { now: Date.now() });
    const b = rotatedSessionValues(rows[0], { now: Date.now() });
    const results = await Promise.all([newStore().rotateSession(rows[0].id, a.row), newStore().rotateSession(rows[0].id, b.row)]);
    assert.deepEqual(results.sort(), [false, true]);
  });

  it("역할 변경, 비활성화는 그 계정의 세션을 모두 폐기하고 삭제는 세션과 바인딩을 지운다", async () => {
    const { userId } = await userWithSessions(3);
    await store.createUser({ username: "o2", norm: "o2", passwordHash: HASH, bindings: [{ role: "owner", workspace: null }], createdBy: "t" });
    const roles = await store.setRoles(userId, [{ role: "owner", workspace: null }, { role: "viewer", workspace: "w" }], { createdBy: "t" });
    assert.equal(roles.revokedSessions, 3);
    await store.insertSession(newSessionValues({ userId, now: Date.now() }).row);
    assert.equal((await store.updateUser(userId, { status: "disabled" })).revokedSessions, 1);
    await store.deleteUser(userId);
    const { rows } = await client.query(`SELECT (SELECT count(*) FROM agent_memory.admin_sessions WHERE user_id = $1)::int AS s,
      (SELECT count(*) FROM agent_memory.admin_role_bindings WHERE user_id = $1)::int AS b`, [userId]);
    assert.deepEqual(rows[0], { s: 0, b: 0 });
  });

  it("비상 복구는 모든 계정의 세션을 폐기하고 TOTP를 초기화하며 감사 이벤트를 outbox에 남긴다", async () => {
    const { userId } = await userWithSessions(2);
    const other = await store.createUser({ username: "o3", norm: "o3", passwordHash: HASH, bindings: [{ role: "viewer", workspace: null }], createdBy: "t" });
    await store.insertSession(newSessionValues({ userId: other.id, now: Date.now() }).row);
    await client.query("UPDATE agent_memory.admin_users SET totp_secret_sealed = 's1.v1.a.b.c', totp_enabled_at = now(), totp_last_step = 5 WHERE id = $1", [userId]);
    await client.query("INSERT INTO agent_memory.admin_recovery_codes (user_id, code_hash) VALUES ($1, $2)", [userId, "a".repeat(64)]);
    const result = await runRecover(store, { norm: "s", username: "s" });
    assert.equal(result.revokedSessions, 3);
    const u = (await client.query("SELECT totp_secret_sealed, totp_last_step FROM agent_memory.admin_users WHERE id = $1", [userId])).rows[0];
    assert.deepEqual(u, { totp_secret_sealed: null, totp_last_step: null });
    assert.equal((await client.query("SELECT count(*)::int AS n FROM agent_memory.admin_recovery_codes WHERE user_id = $1", [userId])).rows[0].n, 0);
    const ev = (await client.query("SELECT topic, payload FROM agent_memory.outbox_events WHERE id = $1", [result.outboxId])).rows[0];
    assert.equal(ev.topic, "audit.record");
    assert.equal(ev.payload.action, "admin.recover");
    assert.equal(ev.payload.detail.priority, "high");
  });
});

describe("TOTP 단계와 복구 코드의 한 번 사용", () => {
  it("같은 단계를 동시에 기록하면 하나만 통과하고 작은 단계는 거부한다", async () => {
    await reset();
    const u = await store.bootstrapOwner({ username: "t", norm: "t", passwordHash: HASH, createdBy: "master" });
    const results = await Promise.all(Array.from({ length: 6 }, () => newStore().consumeTotpStep(u.id, 1000)));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await store.consumeTotpStep(u.id, 999), false);
    assert.equal(await store.consumeTotpStep(u.id, 1001), true);
  });

  it("복구 코드는 동시 사용에서도 한 번만 통과한다", async () => {
    await reset();
    const u = await store.bootstrapOwner({ username: "r", norm: "r", passwordHash: HASH, createdBy: "master" });
    await client.query("INSERT INTO agent_memory.admin_recovery_codes (user_id, code_hash) VALUES ($1, $2)", [u.id, "b".repeat(64)]);
    const results = await Promise.all(Array.from({ length: 5 }, () => newStore().consumeRecoveryCode(u.id, "b".repeat(64))));
    assert.equal(results.filter(Boolean).length, 1);
  });
});
