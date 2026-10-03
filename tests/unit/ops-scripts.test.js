/**
 * 백업과 복구 훈련 스크립트 시험
 *
 * 구조 검사(환경 파일을 읽지 않는다, 접속 비밀을 인자로 받지 않는다, 복구 대상 검사가
 * 연결보다 앞선다, 행 수 질의가 행 내용을 읽지 않는다)와 backup.sh의 DB 없는 동작
 * (dry-run, 저장 위치 거부, 기본값)을 확인한다. DB와 pg_dump는 쓰지 않는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import { spawnSync }                   from "node:child_process";
import fs                              from "node:fs";
import os                              from "node:os";
import path                            from "node:path";

const REPO_ROOT = fs.realpathSync(path.resolve(import.meta.dirname, "..", ".."));
const OPS_DIR   = path.join(REPO_ROOT, "scripts", "ops");
const BACKUP    = path.join(OPS_DIR, "backup.sh");

const OPS_FILES = fs.readdirSync(OPS_DIR).filter(name => /\.(sh|mjs|sql)$/.test(name));
const source    = (name) => fs.readFileSync(path.join(OPS_DIR, name), "utf8");

/** 문자열 위치를 찾는다. 없으면 순서 검사가 우연히 통과하지 않도록 실패시킨다. */
const where = (text, needle, from = 0) => {
  const at = text.indexOf(needle, from);
  assert.ok(at >= 0, `찾지 못함: ${needle}`);
  return at;
};

describe("운영 스크립트 구조", () => {
  it("백업과 복구 훈련 파일이 모두 있다", () => {
    for (const name of ["backup.sh", "backup-policy.mjs", "restore-verify.mjs", "restore-lib.mjs", "drill-counts.sql"]) {
      assert.ok(OPS_FILES.includes(name), name);
    }
  });

  for (const name of OPS_FILES) {
    it(`${name} 는 환경 파일과 앱 설정 모듈을 참조하지 않는다`, () => {
      const text = source(name);
      assert.doesNotMatch(text, /(?:^|[\s"'`/(=:])\.env(?![A-Za-z0-9_])/m);
      assert.doesNotMatch(text, /dotenv/i);
      assert.doesNotMatch(text, /lib\/config/);
      assert.doesNotMatch(text, /DATABASE_URL/);
    });
  }

  it("backup.sh는 umask 077과 엄격 모드로 시작한다", () => {
    const text = source("backup.sh");
    assert.match(text, /^set -euo pipefail$/m);
    assert.match(text, /^umask 077$/m);
    assert.ok(where(text, "umask 077") < where(text, "mkdir -p"));
  });

  it("backup.sh는 비밀번호를 인자로 받거나 값을 쓰지 않는다", () => {
    const text = source("backup.sh");
    assert.doesNotMatch(text, /--password/);
    assert.doesNotMatch(text, /PGPASSWORD\s*=/);
    assert.doesNotMatch(text, /\s-W\b/);
  });

  it("backup.sh는 dry-run을 지원하고 쓰기 전에 저장 위치를 검사한다", () => {
    const text = source("backup.sh");
    assert.match(text, /--dry-run/);
    const mkdir = where(text, 'mkdir -p -m 700 -- "$dest"');
    assert.ok(where(text, 'POLICY" guard') < mkdir);
    assert.ok(where(text, 'dry_run" -eq 1') < mkdir);
  });

  it("backup.sh는 저장 위치의 권한을 바꾸지 않고 와일드카드로 파일을 지우지 않는다", () => {
    const text = source("backup.sh");
    assert.doesNotMatch(text, /\bchmod\b/);
    assert.doesNotMatch(text, /\*\.partial/);
    assert.doesNotMatch(text, /rm\s+-\w*r/);
    assert.match(text, /policy_lines partials/);
  });

  it("backup.sh는 잠금 파일 대신 저장 위치 디렉터리에 잠금을 걸고 noclobber 로 쓴다", () => {
    const text = source("backup.sh");
    assert.doesNotMatch(text, /\.backup\.lock/);
    assert.match(text, /exec 9< "\$dest"/);
    assert.ok(where(text, "set -C") > where(text, "flock -n 9"));
    assert.ok(where(text, "set -C") < where(text, 'create_exclusive "$dump_part"'));
    assert.match(text, /mv -T --/);
  });

  it("backup.sh의 실제 실행과 dry-run은 같은 보관 계획 인자를 쓴다", () => {
    const text = source("backup.sh");
    assert.equal((text.match(/expire_args=\(expire/g) || []).length, 1);
    assert.equal((text.match(/policy_lines "\$\{expire_args\[@\]\}"/g) || []).length, 2);
  });

  it("backup.sh는 옵션 변수를 맨 위에서 초기화한다", () => {
    const text = source("backup.sh");
    for (const v of ["dbname", "label", "prune_days", "snapshot", "snap_pid", "snap_in", "snap_out"]) {
      assert.match(text, new RegExp(`^${v}=""$`, "m"), v);
    }
    assert.doesNotMatch(text, /\$\{dbname:-\}/);
  });

  it("backup.sh는 코프로세스 변수(SNAP, SNAP_PID)를 시작 직후 한 번만 읽는다", () => {
    const text  = source("backup.sh");
    const start = text.indexOf("coproc SNAP ");
    assert.ok(start > 0);
    const reads = [...text.matchAll(/\$\{?SNAP(_PID|\[)/g)].map(m => m.index);
    assert.equal(reads.length, 3);
    for (const at of reads) assert.ok(at > start && at < text.indexOf("snap_send()"), String(at));
  });

  it("backup.sh는 정책 계산을 프로세스 치환으로 읽지 않는다", () => {
    assert.doesNotMatch(source("backup.sh"), /<\(\s*node/);
  });

  it("restore-verify는 대상 서버 검사 뒤에야 파일을 읽고 연결을 연다", () => {
    const text  = source("restore-verify.mjs");
    const start = text.indexOf("export async function run(");
    const body  = text.slice(start);
    const check = body.indexOf("assertRestoreTarget(");
    assert.ok(check > 0);
    for (const later of ["fs.readFileSync(", "queryOnce(", "fs.existsSync("]) {
      assert.ok(body.indexOf(later) > check, later);
    }
  });

  it("restore-verify는 일회용 데이터베이스 이름 검사를 거쳐서만 지운다", () => {
    const text = source("restore-verify.mjs");
    const drop = text.indexOf("async function dropDatabase(");
    assert.ok(drop > 0);
    assert.ok(text.indexOf("assertRestoreDatabaseName(name)", drop) > drop);
    assert.ok(text.indexOf("assertRestoreDatabaseName(name)", drop) < text.indexOf("DROP DATABASE", drop));
  });

  it("행 수 질의는 행 내용 열을 읽지 않는다", () => {
    const text = source("drill-counts.sql").split("\n").filter(line => !line.trim().startsWith("--")).join("\n");
    assert.doesNotMatch(text, /\bcontent\b|\bkeywords\b|\bkey_hash\b/);
    assert.match(text, /count\(\*\)/);
    assert.match(text, /schema_migrations/);
    assert.match(text, /hnsw/);
  });
});

describe("backup.sh dry-run과 저장 위치 거부", () => {
  let tmp;

  /** 비밀 값을 담은 환경으로 실행해 출력에 새는지 함께 본다. */
  const runBackup = (args, extraEnv = {}) => spawnSync("bash", [BACKUP, ...args], {
    encoding: "utf8",
    env     : { PATH: process.env.PATH, HOME: tmp, PGPASSWORD: "pw-should-not-print", ...extraEnv }
  });

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ops-backup-"));
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("dry-run은 동작 내용과 파일 이름만 출력하고 저장 위치를 만들지 않는다", () => {
    const dest = path.join(tmp, "not-created");
    const res  = runBackup(["--dry-run", "--dir", dest, "--dbname", "memento"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /would write: memento-\d{8}T\d{6}Z\.dump$/m);
    assert.match(res.stdout, /would write: memento-\d{8}T\d{6}Z\.dump\.sha256$/m);
    assert.match(res.stdout, /would write: memento-\d{8}T\d{6}Z\.counts\.json$/m);
    assert.match(res.stdout, /would write: memento-\d{8}T\d{6}Z\.roles\.sql$/m);
    assert.match(res.stdout, /keep days: 14$/m);
    assert.equal(fs.existsSync(dest), false);
    assert.ok(!(res.stdout + res.stderr).includes("pw-should-not-print"));
  });

  it("--no-roles이면 역할 정의 파일을 만들 목록에 넣지 않는다", () => {
    const res = runBackup(["--dry-run", "--dir", path.join(tmp, "x"), "--dbname", "memento", "--no-roles"]);
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /roles\.sql/);
  });

  it("보관 일수는 인자, 환경변수, 기본값 순으로 정해진다", () => {
    const dest = path.join(tmp, "keep-order");
    assert.match(runBackup(["--dry-run", "--dir", dest, "--dbname", "m"], { MEMENTO_BACKUP_KEEP_DAYS: "5" }).stdout, /keep days: 5$/m);
    assert.match(runBackup(["--dry-run", "--dir", dest, "--dbname", "m", "--keep", "9"], { MEMENTO_BACKUP_KEEP_DAYS: "5" }).stdout, /keep days: 9$/m);
  });

  it("보관 일수가 1 이상의 정수가 아니면 종료 코드 2다", () => {
    for (const keep of ["0", "-3", "x", "1.5"]) {
      const res = runBackup(["--dry-run", "--dir", path.join(tmp, "k"), "--dbname", "m", "--keep", keep]);
      assert.equal(res.status, 2, keep);
    }
  });

  it("저장 위치는 환경변수로도 정하고 인자가 이긴다", () => {
    const fromEnv = path.join(tmp, "from-env");
    const fromArg = path.join(tmp, "from-arg");
    assert.match(runBackup(["--dry-run", "--dbname", "m"], { MEMENTO_BACKUP_DIR: fromEnv }).stdout, new RegExp(`destination: ${fromEnv}$`, "m"));
    assert.match(runBackup(["--dry-run", "--dbname", "m", "--dir", fromArg], { MEMENTO_BACKUP_DIR: fromEnv }).stdout, new RegExp(`destination: ${fromArg}$`, "m"));
  });

  it("기본 저장 위치는 저장소 밖 사용자 디렉터리다", () => {
    const res = runBackup(["--dry-run", "--dbname", "m"]);
    assert.equal(res.status, 0, res.stderr);
    const dest = /^destination: (.+)$/m.exec(res.stdout)[1];
    assert.equal(dest, path.join(fs.realpathSync(tmp), ".local", "state", "memento-mcp", "backups"));
    assert.ok(path.relative(REPO_ROOT, dest).startsWith(".."));

    const xdg = runBackup(["--dry-run", "--dbname", "m"], { XDG_STATE_HOME: path.join(tmp, "xdg") });
    assert.match(xdg.stdout, new RegExp(`destination: ${path.join(fs.realpathSync(tmp), "xdg", "memento-mcp", "backups")}$`, "m"));
  });

  it("저장소 안쪽 저장 위치는 종료 코드 2로 거부하고 아무것도 만들지 않는다", () => {
    for (const rel of ["backups", path.join("scripts", "ops", "out"), "."]) {
      const dest = path.resolve(REPO_ROOT, rel);
      const res  = runBackup(["--dry-run", "--dir", dest, "--dbname", "m"]);
      assert.equal(res.status, 2, rel);
      assert.match(res.stderr, /안쪽이다/);
    }
    assert.equal(fs.existsSync(path.join(REPO_ROOT, "backups")), false);
    assert.equal(fs.existsSync(path.join(REPO_ROOT, "scripts", "ops", "out")), false);
  });

  it("dry-run이 아닌 실행도 저장소 안쪽이면 접속 전에 거부한다", () => {
    const res = runBackup(["--dir", path.join(REPO_ROOT, "backups"), "--dbname", "m"]);
    assert.equal(res.status, 2);
    assert.equal(fs.existsSync(path.join(REPO_ROOT, "backups")), false);
  });

  it("데이터베이스 이름이 없으면 종료 코드 2다", () => {
    const res = runBackup(["--dry-run", "--dir", path.join(tmp, "n")]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /데이터베이스 이름/);
  });

  it("dry-run은 새 벌을 더했을 때 보관 일수를 넘기는 기존 파일 이름만 알린다", () => {
    const dest = path.join(tmp, "existing");
    fs.mkdirSync(dest, { mode: 0o700 });
    for (const day of ["20200101", "20200102", "20200103"]) {
      for (const kind of ["dump", "dump.sha256", "counts.json"]) fs.writeFileSync(path.join(dest, `memento-${day}T030000Z.${kind}`), "x");
    }
    fs.writeFileSync(path.join(dest, "notes.txt"), "x");
    const res = runBackup(["--dry-run", "--dir", dest, "--dbname", "m", "--keep", "2"]);
    assert.equal(res.status, 0, res.stderr);
    const removed = res.stdout.split("\n").filter(line => line.startsWith("would remove: "));
    assert.deepEqual(removed.map(line => line.slice("would remove: ".length)).sort(), [
      "memento-20200101T030000Z.counts.json", "memento-20200101T030000Z.dump", "memento-20200101T030000Z.dump.sha256",
      "memento-20200102T030000Z.counts.json", "memento-20200102T030000Z.dump", "memento-20200102T030000Z.dump.sha256"
    ]);
    assert.equal(fs.readdirSync(dest).length, 10);
  });

  it("알 수 없는 인자는 종료 코드 2다", () => {
    assert.equal(runBackup(["--bogus"]).status, 2);
  });
});
