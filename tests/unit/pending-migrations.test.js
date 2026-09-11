import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs   from "node:fs";
import os   from "node:os";
import path from "node:path";

import {
  listMigrationFiles,
  findPendingMigrations,
  warnPendingMigrations
} from "../../lib/memory/admin/PendingMigrations.js";

function makeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pending-migrations-"));
  for (const name of files) fs.writeFileSync(path.join(dir, name), "SELECT 1;");
  return dir;
}

function makePool({ tableExists = true, applied = [], fail = false } = {}) {
  return {
    query: async (sql) => {
      if (fail) throw new Error("connection refused");
      if (/to_regclass/.test(sql)) return { rows: [{ t: tableExists ? "agent_memory.schema_migrations" : null }] };
      if (/FROM agent_memory\.schema_migrations/.test(sql)) return { rows: applied.map(filename => ({ filename })) };
      throw new Error(`unexpected sql: ${sql}`);
    }
  };
}

describe("PendingMigrations", () => {
  it("migration-NNN-*.sql 파일만 번호 순으로 나열한다", () => {
    const dir = makeDir(["migration-002-b.sql", "README.md", "migration-001-a.sql", "rollback-migration-001.sql"]);
    assert.deepEqual(listMigrationFiles(dir), ["migration-001-a.sql", "migration-002-b.sql"]);
  });

  it("존재하지 않는 디렉터리는 빈 목록이다", () => {
    assert.deepEqual(listMigrationFiles(path.join(os.tmpdir(), "no-such-dir-" + Date.now())), []);
  });

  it("schema_migrations에 없는 파일만 미적용으로 돌려준다", async () => {
    const dir  = makeDir(["migration-001-a.sql", "migration-002-b.sql", "migration-003-c.sql"]);
    const pool = makePool({ applied: ["migration-001-a.sql", "migration-002-b.sql"] });
    assert.deepEqual(await findPendingMigrations(pool, dir), ["migration-003-c.sql"]);
  });

  it("모두 적용됐으면 빈 목록이다", async () => {
    const dir  = makeDir(["migration-001-a.sql"]);
    const pool = makePool({ applied: ["migration-001-a.sql"] });
    assert.deepEqual(await findPendingMigrations(pool, dir), []);
  });

  it("schema_migrations 테이블이 없으면 전체 파일이 미적용이다", async () => {
    const dir  = makeDir(["migration-001-a.sql", "migration-002-b.sql"]);
    const pool = makePool({ tableExists: false });
    assert.deepEqual(await findPendingMigrations(pool, dir), ["migration-001-a.sql", "migration-002-b.sql"]);
  });

  it("pool이 없으면 조회 없이 빈 목록이다", async () => {
    const dir = makeDir(["migration-001-a.sql"]);
    assert.deepEqual(await findPendingMigrations(null, dir), []);
  });

  it("warnPendingMigrations는 미적용 파일명을 error 콜백에 나열한다", async () => {
    const dir  = makeDir(["migration-001-a.sql", "migration-047-x.sql"]);
    const pool = makePool({ applied: ["migration-001-a.sql"] });
    const logs = [];
    const pending = await warnPendingMigrations(pool, { migrationDir: dir, error: (msg, meta) => logs.push({ msg, meta }) });
    assert.deepEqual(pending, ["migration-047-x.sql"]);
    assert.equal(logs.length, 1);
    assert.match(logs[0].msg, /migration-047-x\.sql/);
    assert.match(logs[0].msg, /npm run migrate/);
    assert.deepEqual(logs[0].meta.pending, ["migration-047-x.sql"]);
  });

  it("warnPendingMigrations는 전부 적용 상태에서 아무것도 기록하지 않는다", async () => {
    const dir  = makeDir(["migration-001-a.sql"]);
    const pool = makePool({ applied: ["migration-001-a.sql"] });
    const logs = [];
    const pending = await warnPendingMigrations(pool, { migrationDir: dir, error: (...args) => logs.push(args) });
    assert.deepEqual(pending, []);
    assert.equal(logs.length, 0);
  });

  it("warnPendingMigrations는 조회 실패 시 null을 돌려주고 기동을 막지 않는다", async () => {
    const dir  = makeDir(["migration-001-a.sql"]);
    const logs = [];
    const pending = await warnPendingMigrations(makePool({ fail: true }), { migrationDir: dir, error: (msg, meta) => logs.push({ msg, meta }) });
    assert.equal(pending, null);
    assert.equal(logs.length, 1);
    assert.match(logs[0].msg, /검사 실패/);
    assert.equal(logs[0].meta.error, "connection refused");
  });
});
