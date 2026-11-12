/**
 * 행 수준 보안 키 목록 정책 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * migration-080 정책을 FORCE ROW LEVEL SECURITY와 소유자가 아닌 역할(NOBYPASSRLS)로 실제로 적용해 본다. 키 목록 안의
 * 키 파편만 보이는지, 목록이 비면 종전처럼 키 축을 보지 않는지, system 주체는 전체를 보는지, 목록 밖 키의 행은
 * 쓸 수 없는지, 키 격리 절이 넣은 키 목록이 queryWithAgentVector를 거쳐 app.current_key_ids로 넘어가는지 본다.
 * 풀로 바로 보내는 질의와 호출자가 연 트랜잭션은 queryScoped와 applyRowScope(lib/tools/row-scope.js)로 같은 범위를 건다.
 * FORCE와 역할은 이 실행의 전용 데이터베이스에만 걸고, 역할은 끝나면 지운다.
 */
import crypto                  from "node:crypto";
import { describe, it, before, after } from "node:test";
import assert                  from "node:assert/strict";
import pg                      from "pg";

const { prepareLaneDatabase, dropLaneDatabase, directQuery, directClientConfig } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool, queryWithAgentVector } = await import("../../lib/tools/db.js");
const { keyScopeClause }                     = await import("../../lib/memory/keyScope.js");
const { noteKeyScope }                       = await import("../../lib/tools/key-scope-ids.js");
const { queryScoped, applyRowScope, ROW_SUBJECT } = await import("../../lib/tools/row-scope.js");

const ROLE = `lane_rls_${crypto.randomBytes(4).toString("hex")}`;
/** 역할을 지울 관리 접속. 데이터베이스를 지운 뒤에는 접속 정보를 다시 얻을 수 없어 미리 받아 둔다. */
const SERVER_ADMIN = { ...directClientConfig(), database: "postgres" };
const KEYS = { a: `rls-a-${crypto.randomUUID()}`, b: `rls-b-${crypto.randomUUID()}`, c: `rls-c-${crypto.randomUUID()}` };

before(async () => {
  for (const id of Object.values(KEYS)) {
    await directQuery(`INSERT INTO agent_memory.api_keys (id, name, key_hash, key_prefix) VALUES ($1, $1, md5($1), 'mmcp_rls')`, [id]);
  }
  const rows = [[KEYS.a, 2], [KEYS.b, 1], [KEYS.c, 1], [null, 1]];
  for (const [keyId, n] of rows) {
    for (let i = 0; i < n; i++) {
      const id = crypto.randomUUID();
      await directQuery(
        `INSERT INTO agent_memory.fragments (id, content, type, topic, importance, ttl_tier, agent_id, keywords, content_hash, key_id)
         VALUES ($1, 'rls ' || $1, 'fact', 'rls', 0.5, 'warm', 'default', '{}', md5($1), $2)`,
        [id, keyId]
      );
    }
  }
  await directQuery(`CREATE ROLE ${ROLE} NOLOGIN NOBYPASSRLS`);
  await directQuery(`GRANT USAGE ON SCHEMA agent_memory TO ${ROLE}`);
  await directQuery(`GRANT SELECT, INSERT, UPDATE, DELETE ON agent_memory.fragments, agent_memory.fragment_links TO ${ROLE}`);
  await directQuery("ALTER TABLE agent_memory.fragments FORCE ROW LEVEL SECURITY");
});

after(async () => {
  await shutdownPool();
  await directQuery("ALTER TABLE agent_memory.fragments NO FORCE ROW LEVEL SECURITY").catch(() => {});
  await directQuery(`REVOKE ALL ON agent_memory.fragments, agent_memory.fragment_links FROM ${ROLE}`).catch(() => {});
  await directQuery(`REVOKE USAGE ON SCHEMA agent_memory FROM ${ROLE}`).catch(() => {});
  await dropLaneDatabase();
  /** 역할은 서버 전체 객체라 데이터베이스를 지운 뒤 지운다 */
  const admin = new pg.Client(SERVER_ADMIN);
  await admin.connect();
  await admin.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {});
  await admin.end();
});

/**
 * 시험 역할로 설정을 걸고 fn을 실행한다.
 *
 * @param {{ agent?: string, keyId?: string, keyIds?: string[] }} vars
 * @param {(client: pg.Client) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function asRuntime(vars, fn) {
  const client = new pg.Client(directClientConfig());
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${ROLE}`);
    await client.query("SELECT set_config('app.current_agent_id', $1, true), set_config('app.current_key_id', $2, true), set_config('app.current_key_ids', $3, true)",
      [vars.agent ?? "default", vars.keyId ?? "", (vars.keyIds ?? []).join(",")]);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

async function visibleKeys(vars) {
  return asRuntime(vars, async (client) => {
    const { rows } = await client.query("SELECT COALESCE(key_id, 'master') AS k, count(*)::int AS n FROM agent_memory.fragments WHERE topic = 'rls' GROUP BY 1 ORDER BY 1");
    return Object.fromEntries(rows.map((r) => [r.k, r.n]));
  });
}

describe("행 수준 보안 키 목록 정책", () => {
  it("키 목록 안의 키 파편만 보이고 키 없는(마스터) 파편은 보이지 않는다", async () => {
    assert.deepEqual(await visibleKeys({ keyIds: [KEYS.a] }), { [KEYS.a]: 2 });
    assert.deepEqual(await visibleKeys({ keyIds: [KEYS.a, KEYS.b] }), { [KEYS.a]: 2, [KEYS.b]: 1 });
    assert.deepEqual(await visibleKeys({ keyId: KEYS.c }), { [KEYS.c]: 1 });
  });

  it("키 범위가 비면 키 축을 보지 않고, system 주체는 목록이 있어도 전체를 본다", async () => {
    const all = { [KEYS.a]: 2, [KEYS.b]: 1, [KEYS.c]: 1, master: 1 };
    assert.deepEqual(await visibleKeys({}), all);
    assert.deepEqual(await visibleKeys({ agent: "system", keyIds: [KEYS.a] }), all);
  });

  it("목록 밖 키의 행은 쓸 수 없다", async () => {
    await assert.rejects(() => asRuntime({ keyIds: [KEYS.a] }, (client) => client.query(
      `INSERT INTO agent_memory.fragments (id, content, type, topic, importance, ttl_tier, agent_id, keywords, content_hash, key_id)
       VALUES ($1, 'rls write', 'fact', 'rls', 0.5, 'warm', 'default', '{}', md5($1), $2)`,
      [crypto.randomUUID(), KEYS.c]
    )), /row-level security/);
  });

  it("키 격리 절이 넣은 키 목록이 queryWithAgentVector를 거쳐 app.current_key_ids로 넘어간다", async () => {
    const params = [];
    const clause = keyScopeClause(params, "t.key_id", { keyId: KEYS.a, groupKeyIds: [KEYS.a, KEYS.b] });
    /** 같은 바인딩 배열에 값을 더한다. 펼친 새 배열은 키 목록을 잃는다(key-scope-ids.js). */
    params.push(KEYS.a);
    const { rows } = await queryWithAgentVector("default",
      `SELECT current_setting('app.current_key_ids', true) AS ids FROM (SELECT $${params.length}::text AS key_id) t WHERE TRUE${clause}`,
      params
    );
    assert.deepEqual(rows[0].ids.split(",").sort(), [KEYS.a, KEYS.b].sort());

    const unscoped = await queryWithAgentVector("default", "SELECT current_setting('app.current_key_ids', true) AS ids", []);
    assert.equal(unscoped.rows[0].ids, "");
  });

  it("풀로 바로 보내는 질의도 queryScoped를 거치면 키 목록과 주체가 정책에 걸린다", async () => {
    /** 접속할 때부터 시험 역할로 바꾼 풀. 이 역할에는 정책이 적용된다. */
    const pool  = new pg.Pool({ ...directClientConfig(), options: `-c role=${ROLE}`, max: 2 });
    const count = "SELECT COALESCE(key_id, 'master') AS k, count(*)::int AS n FROM agent_memory.fragments WHERE topic = 'rls' GROUP BY 1 ORDER BY 1";
    const seen  = async (params, subject) => Object.fromEntries((await queryScoped(pool, count, params, subject)).rows.map((r) => [r.k, r.n]));
    try {
      const scoped = [];
      noteKeyScope(scoped, [KEYS.a, KEYS.b]);
      assert.deepEqual(await seen(scoped), { [KEYS.a]: 2, [KEYS.b]: 1 });

      const all = { [KEYS.a]: 2, [KEYS.b]: 1, [KEYS.c]: 1, master: 1 };
      assert.deepEqual(await seen([], ROW_SUBJECT.SYSTEM), all);
      assert.deepEqual(await seen(scoped, ROW_SUBJECT.ADMIN), all);

      /** 호출자가 연 트랜잭션에는 applyRowScope가 같은 범위를 건다 */
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await applyRowScope(pool, client, { keyIds: [KEYS.c] });
        const { rows } = await client.query(count);
        assert.deepEqual(Object.fromEntries(rows.map((r) => [r.k, r.n])), { [KEYS.c]: 1 });
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    } finally {
      await pool.end();
    }
  });
});
