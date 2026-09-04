import "../integration/_cleanup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { getPrimaryPool } from "../../lib/tools/db.js";

test("migration-046 이후 구버전 fragment_versions INSERT가 계속 성공한다", async t => {
  const pool = getPrimaryPool();
  let client;
  try {
    client = await pool.connect();
    await client.query("SELECT 1 FROM agent_memory.fragment_versions LIMIT 0");
  } catch {
    client?.release();
    t.skip("PostgreSQL 또는 migration-046 schema를 사용할 수 없음");
    return;
  }

  const id = `rolling-${crypto.randomUUID()}`;
  try {
    await client.query("BEGIN");
    const columns = await client.query(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'agent_memory'
          AND table_name = 'fragment_versions'
          AND column_name IN ('agent_id', 'workspace')`
    );
    assert.equal(columns.rowCount, 2);
    assert.equal(columns.rows.find(row => row.column_name === "agent_id")?.is_nullable, "YES");

    await client.query(
      `INSERT INTO agent_memory.fragments
              (id, content, topic, type, content_hash, agent_id)
       VALUES ($1, 'synthetic rolling fragment', 'synthetic', 'fact', $2, 'agent-a')`,
      [id, crypto.randomUUID()]
    );
    /** 5.9 이하 writer 형태: 신규 snapshot 컬럼을 지정하지 않는다. */
    await client.query(
      `INSERT INTO agent_memory.fragment_versions
              (fragment_id, content, topic, keywords, type, importance, amended_by)
       VALUES ($1, 'synthetic old version', 'synthetic', '{}', 'fact', 0.5, 'agent-a')`,
      [id]
    );
    const version = await client.query(
      "SELECT agent_id, workspace FROM agent_memory.fragment_versions WHERE fragment_id = $1",
      [id]
    );
    assert.deepEqual(version.rows[0], { agent_id: null, workspace: null });
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
});
