/**
 * 고아 case_events 요약 정리 스크립트의 대상 지정, 거부, 백업 확인 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 스크립트는 환경 파일과 앱 설정 모듈을 읽지 않고 --url 또는 표준 PG 환경변수로만 대상을 받는다.
 * 대상이 없으면 연결하지 않고 거부하며, 실제 변경은 --execute 와 백업 확인 옵션이 함께 있어야 한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import fs               from "node:fs";
import os               from "node:os";
import path             from "node:path";
import { spawnSync }    from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  main, parsePurgeArgs, BACKUP_FLAG, backupCommand
} from "../../scripts/purge-orphan-case-summaries.js";

const ROOT   = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "purge-orphan-case-summaries.js");
const TARGET = { PGHOST: "db.example.test", PGPORT: "6543", PGDATABASE: "memdb", PGUSER: "opsuser", PGPASSWORD: "secret-pw-123" };

/** 출력과 연결 호출을 모으는 대역 */
function harness(queryResult = { rows: [{ n: 0 }], rowCount: 0 }) {
  const out = [];
  const err = [];
  const connects = [];
  const queries  = [];
  const deps = {
    out    : line => out.push(line),
    err    : line => err.push(line),
    connect: async config => {
      connects.push(config);
      return { query: async (sql, params) => { queries.push({ sql, params }); return queryResult; }, end: async () => {} };
    }
  };
  return { out, err, connects, queries, deps };
}

/** 이 스크립트가 정적으로 가져오는 저장소 안 모듈 전체 */
function staticImports(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(/^import\s[^;]*?from\s+["'](\.[^"']+)["']/gms)) {
    staticImports(path.resolve(path.dirname(file), m[1]), seen);
  }
  return seen;
}

describe("purge-orphan-case-summaries 구조", () => {
  it("환경 파일 로더와 앱 설정 모듈을 정적 가져오기 경로 어디에서도 쓰지 않는다", () => {
    const files = [...staticImports(SCRIPT)].map(f => path.relative(ROOT, f));
    assert.ok(files.includes("lib/memory/write/ForgetCascade.js"));
    for (const file of files) {
      const text = fs.readFileSync(path.join(ROOT, file), "utf8");
      assert.ok(!/dotenv/i.test(text), `${file} 이 dotenv 를 쓴다`);
      assert.ok(!/readFileSync\([^)]*\.env/.test(text), `${file} 이 .env 를 읽는다`);
      assert.notEqual(file, "lib/config.js");
      assert.notEqual(file, "lib/tools/db.js");
    }
  });

  it("현재 디렉터리와 DOTENV_CONFIG_PATH 의 환경 파일에 대상이 있어도 읽지 않고 거부한다", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "purge-orphan-"));
    try {
      const envText = "PGHOST=127.0.0.1\nPGDATABASE=from_env_file\nPOSTGRES_HOST=127.0.0.1\nPOSTGRES_DB=from_env_file\nDATABASE_URL=postgresql://u:p@127.0.0.1:5/from_env_file\n";
      fs.writeFileSync(path.join(tmp, ".env"), envText);
      fs.writeFileSync(path.join(tmp, "other.env"), envText);
      const run = spawnSync(process.execPath, [SCRIPT], {
        cwd: tmp, encoding: "utf8", timeout: 20000,
        env: { PATH: process.env.PATH, HOME: tmp, DOTENV_CONFIG_PATH: path.join(tmp, "other.env") }
      });
      assert.equal(run.status, 2, run.stderr);
      assert.match(run.stderr, /접속 대상이 명시되지 않았다/);
      assert.doesNotMatch(run.stderr + run.stdout, /from_env_file/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("purge-orphan-case-summaries 인자와 거부", () => {
  it("인자를 읽고 알 수 없는 인자, 위치 인자, 범위 밖 묶음 크기를 거부한다", () => {
    assert.deepEqual(parsePurgeArgs([]), { execute: false, backupConfirmed: false, help: false, batch: 500, url: undefined });
    const opts = parsePurgeArgs(["--execute", BACKUP_FLAG, "--batch=200", "--url", "postgresql://h/db"]);
    assert.equal(opts.execute, true);
    assert.equal(opts.backupConfirmed, true);
    assert.equal(opts.batch, 200);
    assert.equal(opts.url, "postgresql://h/db");
    assert.throws(() => parsePurgeArgs(["--bogus"]), /알 수 없는 인자: --bogus/);
    assert.throws(() => parsePurgeArgs(["stray"]), /위치 인자/);
    assert.throws(() => parsePurgeArgs(["--batch", "0"]), /--batch/);
    assert.throws(() => parsePurgeArgs(["--batch", "abc"]), /--batch/);
    assert.throws(() => parsePurgeArgs(["--url"]), /--url 에 값이 필요하다/);
  });

  it("대상이 없으면 연결하지 않고 2로 끝난다", async () => {
    const h    = harness();
    const code = await main([], {}, h.deps);
    assert.equal(code, 2);
    assert.equal(h.connects.length, 0);
    assert.match(h.err.join("\n"), /접속 대상이 명시되지 않았다/);
  });

  it("--execute 에 백업 확인 옵션이 없으면 백업 명령을 알리고 연결하지 않는다", async () => {
    const h    = harness();
    const code = await main(["--execute"], TARGET, h.deps);
    const text = h.err.join("\n");
    assert.equal(code, 2);
    assert.equal(h.connects.length, 0);
    assert.ok(text.includes("pg_dump") && text.includes("-t agent_memory.case_events"));
    assert.ok(text.includes(BACKUP_FLAG));
  });

  it("백업 확인과 함께 실행하면 대상(호스트, 포트, DB만)을 알리고 변경한다", async () => {
    const h    = harness({ rows: [], rowCount: 0 });
    const code = await main(["--execute", BACKUP_FLAG], TARGET, h.deps);
    const all  = [...h.out, ...h.err].join("\n");
    assert.equal(code, 0);
    assert.equal(h.connects.length, 1);
    assert.equal(h.connects[0].host, "db.example.test");
    assert.equal(h.connects[0].database, "memdb");
    assert.ok(all.includes("db.example.test:6543/memdb"));
    assert.ok(!all.includes("secret-pw-123"), "비밀번호를 출력하지 않는다");
    assert.ok(!all.includes("opsuser"), "사용자를 출력하지 않는다");
    assert.ok(all.includes("pg_dump"), "실행 전에 백업 명령을 다시 알린다");
    assert.ok(h.queries.every(q => /^\s*UPDATE agent_memory\.case_events/.test(q.sql)));
    assert.match(h.out.join("\n"), /"mode": "execute"/);
  });

  it("미리보기는 갱신하지 않고 다음 단계의 백업 명령을 알린다", async () => {
    const h    = harness({ rows: [{ n: 4 }], rowCount: 1 });
    const code = await main(["--url", "postgresql://opsuser:secret-pw-123@db.example.test:6543/memdb"], {}, h.deps);
    const all  = [...h.out, ...h.err].join("\n");
    assert.equal(code, 0);
    assert.ok(h.queries.every(q => !/^\s*UPDATE/.test(q.sql)));
    assert.ok(all.includes("db.example.test:6543/memdb"));
    assert.ok(!all.includes("secret-pw-123"));
    assert.ok(all.includes("pg_dump") && all.includes(BACKUP_FLAG));
  });

  it("backupCommand 는 대상 표만 담고 비밀번호와 사용자를 담지 않는다", () => {
    const cmd = backupCommand({ host: "h1", port: 5432, database: "d1", user: "u1", password: "p1" });
    assert.ok(cmd.includes("-t agent_memory.case_events") && cmd.includes("-h h1") && cmd.includes("-d d1"));
    assert.ok(!cmd.includes("p1") && !cmd.includes("u1"));
  });
});
