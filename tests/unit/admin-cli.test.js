/**
 * 비상 복구 CLI(anchormind admin recover) 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 1. 명령 모듈의 정적 가져오기 폐포에 설정 모듈, 서버 DB 모듈, dotenv가 없다.
 * 2. 현재 디렉터리의 .env와 DOTENV_CONFIG_PATH가 가리키는 파일이 접속 대상을 정해도 명령은 그 대상을 쓰지 않고 거부한다.
 * 3. --confirm이 없으면 연결하지 않는다. 있으면 한 트랜잭션에서 TOTP 초기화, 전체 세션 폐기, 감사 이벤트 기록을 한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync }    from "node:child_process";
import os               from "node:os";
import path             from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const { default: admin, runRecover, AdminCliError, RECOVER_ACTION } = await import("../../lib/cli/admin.js");
const { AdminUserStore } = await import("../../lib/admin/AdminUserStore.js");

/** 상대 경로 정적 가져오기와 동적 가져오기의 폐포(파일 절대 경로)와 패키지 이름 */
function importClosure(entry) {
  const files    = new Set();
  const packages = new Set();
  const stack    = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (files.has(file)) continue;
    files.add(file);
    const text = readFileSync(file, "utf8");
    const specs = [
      ...text.matchAll(/^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm),
      ...text.matchAll(/^\s*export\s+[^"';]*?\s+from\s+["']([^"']+)["']/gm),
      ...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)
    ].map((m) => m[1]);
    for (const spec of specs) {
      if (spec.startsWith(".")) stack.push(path.resolve(path.dirname(file), spec));
      else packages.add(spec);
    }
  }
  return { files: [...files].map((f) => path.relative(ROOT, f)), packages: [...packages] };
}

describe("가져오기 폐포", () => {
  it("설정 모듈, 서버 DB 모듈, dotenv를 가져오지 않는다", () => {
    const { files, packages } = importClosure(path.join(ROOT, "lib", "cli", "admin.js"));
    assert.ok(files.includes(path.join("lib", "admin", "AdminUserStore.js")));
    for (const banned of [path.join("lib", "config.js"), path.join("lib", "tools", "db.js"), path.join("lib", "logger.js")]) {
      assert.ok(!files.includes(banned), `${banned}가 폐포에 있다`);
    }
    assert.ok(!packages.some((p) => p.startsWith("dotenv")), packages.join(","));
  });

  it("bin은 admin 명령에서 dotenv를 불러오지 않고 환경을 명령에 넘긴다", () => {
    const bin = readFileSync(path.join(ROOT, "bin", "memento.js"), "utf8");
    assert.match(bin, /DOTENV_EXEMPT_COMMANDS = new Set\(\[[^\]]*"admin"[^\]]*\]\)/);
    assert.doesNotMatch(bin, /^import\s+["']dotenv\/config["']/m);
    assert.match(bin, /if \(cmd === "admin"\)\s+return \{ env: process\.env \};/);
    assert.match(bin, /mod\.default\(args, commandOverrides\(cmd\)\)/);
  });
});

describe("환경 파일이 접속 대상을 바꾸지 못한다", () => {
  it("cwd의 .env와 DOTENV_CONFIG_PATH 파일에 PGHOST가 있어도 대상 없음으로 거부하고 그 값을 쓰지 않는다", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "admin-cli-"));
    try {
      writeFileSync(path.join(dir, ".env"), "PGHOST=cwd-env-host.invalid\nPGDATABASE=cwddb\n");
      writeFileSync(path.join(dir, "other.env"), "PGHOST=path-env-host.invalid\nPGDATABASE=pathdb\n");
      const env = { PATH: process.env.PATH, HOME: dir, UPDATE_CHECK_DISABLED: "true", DOTENV_CONFIG_PATH: path.join(dir, "other.env") };
      const run = spawnSync(process.execPath, [path.join(ROOT, "bin", "memento.js"), "admin", "recover", "--confirm"], { cwd: dir, env, encoding: "utf8" });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /접속 대상이 없다/);
      assert.doesNotMatch(run.stdout + run.stderr, /cwd-env-host|path-env-host|cwddb|pathdb/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** 질의를 기록하는 pg 연결 대역 */
function stubPool({ userId = "7d4b8c1e-0000-4000-8000-000000000001", revoked = 3 } = {}) {
  const log = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      log.push({ text, params });
      if (text.startsWith("SELECT id FROM")) return { rows: userId ? [{ id: userId }] : [], rowCount: userId ? 1 : 0 };
      if (text.startsWith("UPDATE agent_memory.admin_users")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE agent_memory.admin_sessions")) return { rows: [], rowCount: revoked };
      if (text.startsWith("INSERT INTO agent_memory.outbox_events")) return { rows: [{ id: "42" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  return { log, ended: false, async connect() { return client; }, async end() { this.ended = true; } };
}

describe("recover 실행", () => {
  it("대상이 없으면 연결 없이 거부한다", async () => {
    let connected = false;
    await assert.rejects(admin({ _: ["recover"], confirm: true }, { env: {}, connect: async () => { connected = true; } }), AdminCliError);
    assert.equal(connected, false);
  });

  it("--confirm이 없으면 할 일만 출력하고 연결하지 않는다", async () => {
    let connected = false;
    const lines = [];
    const out = await admin({ _: ["recover"], user: "owner1" },
      { env: { PGHOST: "db.example", PGDATABASE: "memento" }, connect: async () => { connected = true; }, out: (t) => lines.push(t) });
    assert.deepEqual(out, { applied: false });
    assert.equal(connected, false);
    assert.match(lines.join("\n"), /--confirm/);
  });

  it("형식이 틀린 계정 이름은 연결 전에 거부한다", async () => {
    let connected = false;
    await assert.rejects(admin({ _: ["recover"], user: "bad name", confirm: true },
      { env: { PGHOST: "h", PGDATABASE: "d" }, connect: async () => { connected = true; } }));
    assert.equal(connected, false);
  });

  it("--confirm이면 한 트랜잭션에서 TOTP 초기화, 전체 세션 폐기, 고우선 감사 이벤트를 기록한다", async () => {
    const pool = stubPool();
    const errs = [];
    const out  = await admin({ _: ["recover"], user: "Owner1", confirm: true, json: true },
      { env: { PGHOST: "db.example", PGDATABASE: "memento" }, connect: async () => pool, out: () => {}, err: (t) => errs.push(t) });
    assert.equal(out.applied, true);
    assert.equal(out.revokedSessions, 3);
    assert.equal(pool.ended, true);
    const texts = pool.log.map((q) => q.text);
    assert.equal(texts[0], "BEGIN");
    assert.equal(texts.at(-1), "COMMIT");
    assert.deepEqual(pool.log.find((q) => q.text.startsWith("SELECT id FROM")).params, ["owner1"]);
    assert.ok(texts.some((t) => /^UPDATE agent_memory\.admin_users SET totp_secret_sealed = NULL/.test(t)));
    assert.ok(texts.some((t) => /^DELETE FROM agent_memory\.admin_recovery_codes/.test(t)));
    assert.ok(texts.some((t) => /^UPDATE agent_memory\.admin_sessions SET revoked_at = now\(\), revoke_reason = \$1 WHERE revoked_at IS NULL$/.test(t)));
    const insert  = pool.log.find((q) => q.text.startsWith("INSERT INTO agent_memory.outbox_events"));
    const payload = JSON.parse(insert.params[2]);
    assert.equal(insert.params[0], "audit.record");
    assert.equal(payload.action, RECOVER_ACTION);
    assert.equal(payload.actor.kind, "system");
    assert.deepEqual(payload.detail, { priority: "high", channel: "cli", totpReset: true, revokedSessions: 3 });
    assert.equal(payload.target.type, "admin_user");
    assert.match(errs.join("\n"), /priority high/);
  });

  it("없는 계정이면 바꾸지 않고(ROLLBACK) 감사 이벤트도 남기지 않는다", async () => {
    const pool = stubPool({ userId: null });
    await assert.rejects(runRecover(new AdminUserStore(pool), { norm: "ghost", username: "ghost" }), AdminCliError);
    const texts = pool.log.map((q) => q.text);
    assert.equal(texts.at(-1), "ROLLBACK");
    assert.ok(!texts.some((t) => t.startsWith("INSERT INTO agent_memory.outbox_events")));
    assert.ok(!texts.some((t) => t.startsWith("UPDATE agent_memory.admin_sessions")));
  });

  it("--user 없이도 전체 세션을 폐기하고 TOTP는 바꾸지 않는다", async () => {
    const pool = stubPool();
    const out  = await admin({ _: ["recover"], confirm: true }, { env: { PGHOST: "h", PGDATABASE: "d" }, connect: async () => pool, out: () => {}, err: () => {} });
    assert.equal(out.userId, null);
    assert.ok(!pool.log.some((q) => q.text.startsWith("UPDATE agent_memory.admin_users")));
  });
});
