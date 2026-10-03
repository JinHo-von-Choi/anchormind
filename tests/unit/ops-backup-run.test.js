/**
 * backup.sh 실행 시험
 *
 * psql, pg_dump, pg_restore, pg_dumpall을 PATH 앞에 둔 가짜 실행 파일로 바꿔 실제 bash
 * 스크립트의 전체 경로(스냅숏, 덤프, 이름 확정, 보관 정리)를 DB 없이 확인한다. 저장 위치의
 * 다른 파일, 디렉터리 권한, 라벨 벌의 보관, 접속 문자열 거부를 본다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert                                       from "node:assert/strict";
import { spawnSync }                                from "node:child_process";
import fs                                           from "node:fs";
import os                                           from "node:os";
import path                                         from "node:path";

const REPO_ROOT = fs.realpathSync(path.resolve(import.meta.dirname, "..", ".."));
const BACKUP    = path.join(REPO_ROOT, "scripts", "ops", "backup.sh");

const STUBS = {
  psql: String.raw`#!/usr/bin/env bash
if [[ -n "\${FAKE_PSQL_FAIL:-}" ]]; then read -r _line; exit 1; fi
buf=""
while IFS= read -r line; do
  case "$line" in
    '\echo @@END@@')
      if [[ "$buf" == *pg_export_snapshot* ]]; then echo 'SNAP:00000003-0000001B-1'; fi
      if [[ "$buf" == *json_build_object* ]]; then
        echo '{"tables":{"fragments":1,"fragment_links":0,"fragment_versions":0,"api_keys":0},"schemaMigrationsMax":"migration-049.sql","hnsw":{"total":0,"valid":0}}'
      fi
      echo '@@END@@'
      if [[ -n "\${FAKE_PSQL_EXIT_AFTER_COMMIT:-}" && "$buf" == COMMIT* ]]; then exit 0; fi
      buf="" ;;
    '\q') exit 0 ;;
    *) buf+="$line"$'\n' ;;
  esac
done
`,
  date: String.raw`#!/usr/bin/env bash
if [[ -n "\${FAKE_STAMP:-}" && "$*" == *"%Y%m%dT%H%M%SZ"* ]]; then echo "$FAKE_STAMP"; else exec /bin/date "$@"; fi
`,
  pg_dump: String.raw`#!/usr/bin/env bash
echo "pg_dump $*" >> "\${STUB_LOG:-/dev/null}"
for arg in "$@"; do
  case "$arg" in --file=*) printf 'DUMP' > "\${arg#--file=}" ;; esac
done
`,
  pg_dumpall: String.raw`#!/usr/bin/env bash
echo "pg_dumpall $*" >> "\${STUB_LOG:-/dev/null}"
for arg in "$@"; do
  case "$arg" in --file=*) printf -- '-- roles\n' > "\${arg#--file=}" ;; esac
done
`,
  pg_restore: String.raw`#!/usr/bin/env bash
echo '1; 0 0 TABLE agent_memory fragments memento'
`
};

const OLD_SET = (stamp, label = "") => ["dump", "dump.sha256", "counts.json", "roles.sql"].map(k => `memento-${stamp}${label}.${k}`);
const FOREIGN = ["user-download.partial", "movie.mkv.partial", "memento-notes.partial", "notes.txt", "memento-keep.dump", "other.dump.sha256"];

describe("backup.sh 전체 경로 (가짜 PostgreSQL 도구)", () => {
  let root;
  let bin;
  let seq = 0;

  const modeOf = (p) => (fs.statSync(p).mode & 0o777).toString(8);

  /** 시험마다 새 저장 위치 경로를 만든다. 만들지는 않는다. */
  const freshDir = () => path.join(root, `dest-${seq++}`);

  const run = (args, extraEnv = {}) => spawnSync("bash", [BACKUP, ...args], {
    encoding: "utf8",
    env     : { PATH: `${bin}:${process.env.PATH}`, HOME: root, PGDATABASE: "memento", ...extraEnv }
  });

  const seedForeign = (dest) => {
    for (const name of FOREIGN) fs.writeFileSync(path.join(dest, name), `keep ${name}`);
  };

  const assertForeignIntact = (dest) => {
    for (const name of FOREIGN) {
      assert.equal(fs.readFileSync(path.join(dest, name), "utf8"), `keep ${name}`, name);
    }
  };

  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ops-run-")));
    bin  = path.join(root, "bin");
    fs.mkdirSync(bin);
    for (const [name, body] of Object.entries(STUBS)) {
      fs.writeFileSync(path.join(bin, name), body.replaceAll("\\${", "${"), { mode: 0o755 });
    }
    fs.writeFileSync(
      path.join(bin, "node"),
      `#!/usr/bin/env bash\nfor a in "$@"; do\n  if [[ "$a" == expire && -n "\${FAKE_NODE_FAIL_EXPIRE:-}" ]]; then echo boom >&2; exit 1; fi\ndone\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 }
    );
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  beforeEach(() => { seq += 1; });

  describe("저장 위치의 다른 파일", () => {
    it("실패한 실행은 다른 .partial 파일과 다른 파일을 지우지 않고 이 스크립트의 미확정 파일만 지운다", () => {
      const dest = freshDir();
      fs.mkdirSync(dest, { mode: 0o700 });
      seedForeign(dest);
      fs.writeFileSync(path.join(dest, "memento-20200101T000000Z.dump.partial"), "mine");
      fs.writeFileSync(path.join(dest, "memento-20200101T000000Z-pre-migration.counts.json.partial"), "mine");

      const res = run(["--dir", dest], { FAKE_PSQL_FAIL: "1" });
      assert.equal(res.status, 1, res.stderr);
      assertForeignIntact(dest);
      assert.equal(fs.existsSync(path.join(dest, "memento-20200101T000000Z.dump.partial")), false);
      assert.equal(fs.existsSync(path.join(dest, "memento-20200101T000000Z-pre-migration.counts.json.partial")), false);
      assert.deepEqual(fs.readdirSync(dest).filter(n => n.endsWith(".dump") && n !== "memento-keep.dump"), []);
    });

    it("성공한 실행도 다른 파일을 모두 남기고 새 벌을 만든다", () => {
      const dest = freshDir();
      fs.mkdirSync(dest, { mode: 0o700 });
      seedForeign(dest);

      const res = run(["--dir", dest, "--keep", "1"]);
      assert.equal(res.status, 0, res.stderr);
      assertForeignIntact(dest);
      const made = fs.readdirSync(dest).filter(n => /^memento-\d{8}T\d{6}Z\.(dump|dump\.sha256|counts\.json|roles\.sql)$/.test(n));
      assert.equal(made.length, 4);
      for (const name of made) assert.equal(modeOf(path.join(dest, name)), "600", name);
      assert.match(res.stdout, /written: memento-\d{8}T\d{6}Z\.dump \d+ bytes/);
      assert.match(res.stdout, /toc entries: 1/);
    });

    it("스냅숏 세션이 COMMIT 응답 직후 끝나도 새 벌을 만들고 종료 코드 0이다", () => {
      const dest = freshDir();
      fs.mkdirSync(dest, { mode: 0o700 });

      const res = run(["--dir", dest], { FAKE_PSQL_EXIT_AFTER_COMMIT: "1" });
      assert.equal(res.status, 0, `${res.signal} ${res.stderr}`);
      const made = fs.readdirSync(dest).filter(n => /^memento-\d{8}T\d{6}Z\.(dump|dump\.sha256|counts\.json|roles\.sql)$/.test(n));
      assert.equal(made.length, 4);
    });

    it("보관 정리는 관리 대상 이름만 지우고 이름이 비슷한 다른 파일은 지우지 않는다", () => {
      const dest = freshDir();
      fs.mkdirSync(dest, { mode: 0o700 });
      seedForeign(dest);
      for (const name of OLD_SET("20200101T030000Z")) fs.writeFileSync(path.join(dest, name), "old");

      const res = run(["--dir", dest, "--keep", "1"]);
      assert.equal(res.status, 0, res.stderr);
      assertForeignIntact(dest);
      for (const name of OLD_SET("20200101T030000Z")) assert.equal(fs.existsSync(path.join(dest, name)), false, name);
      assert.match(res.stdout, /removed files: 4/);
    });
  });

  describe("저장 위치 권한", () => {
    it("스크립트가 만든 디렉터리는 700이다", () => {
      const dest = path.join(freshDir(), "nested", "backups");
      const res  = run(["--dir", dest]);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(modeOf(dest), "700");
      assert.equal(modeOf(path.dirname(dest)), "700");
    });

    it("그룹이나 다른 사용자가 접근할 수 있는 기존 디렉터리는 권한을 바꾸지 않고 종료 코드 2로 거부한다", () => {
      for (const mode of [0o755, 0o750, 0o705]) {
        const dest = freshDir();
        fs.mkdirSync(dest);
        fs.chmodSync(dest, mode);
        const res = run(["--dir", dest]);
        assert.equal(res.status, 2, mode.toString(8));
        assert.match(res.stderr, /권한이 .* 이라 그룹이나 다른 사용자가 접근할 수 있다/);
        assert.equal(modeOf(dest), mode.toString(8));
        assert.deepEqual(fs.readdirSync(dest), []);
      }
    });

    it("dry-run도 같은 기준으로 기존 디렉터리를 검사한다", () => {
      const dest = freshDir();
      fs.mkdirSync(dest);
      fs.chmodSync(dest, 0o755);
      assert.equal(run(["--dir", dest, "--dry-run"]).status, 2);
      assert.equal(modeOf(dest), "755");
    });

    it("700 기존 디렉터리는 권한을 그대로 두고 사용한다", () => {
      const dest = freshDir();
      fs.mkdirSync(dest);
      fs.chmodSync(dest, 0o700);
      assert.equal(run(["--dir", dest]).status, 0);
      assert.equal(modeOf(dest), "700");
    });

    it("--allow-open-dir이면 열린 기존 디렉터리를 쓰되 권한은 바꾸지 않는다", () => {
      for (const mode of [0o755, 0o770]) {
        const dest = freshDir();
        fs.mkdirSync(dest);
        fs.chmodSync(dest, mode);
        const res = run(["--dir", dest, "--allow-open-dir"]);
        assert.equal(res.status, 0, res.stderr);
        assert.equal(modeOf(dest), mode.toString(8));
      }
    });

    it("파일 시스템 루트와 홈 디렉터리 자체는 --allow-open-dir이 있어도 거부한다", () => {
      for (const args of [["--dir", "/"], ["--dir", root], ["--dir", root, "--allow-open-dir"], ["--dir", "/", "--dry-run"]]) {
        const res = run(args);
        assert.equal(res.status, 2, args.join(" "));
        assert.match(res.stderr, /저장 위치 검사에 실패했다/);
      }
      assert.equal(fs.existsSync(path.join(root, ".backup.lock")), false);
    });

    it("디렉터리가 아닌 기존 경로는 거부한다", () => {
      const file = path.join(root, `file-${seq}`);
      fs.writeFileSync(file, "x");
      assert.equal(run(["--dir", file]).status, 2);
    });
  });

  describe("라벨 벌", () => {
    it("--label은 라벨 이름의 벌을 만든다", () => {
      const dest = freshDir();
      const res  = run(["--dir", dest, "--label", "pre-migration"]);
      assert.equal(res.status, 0, res.stderr);
      const names = fs.readdirSync(dest).filter(n => n.startsWith("memento-"));
      assert.equal(names.length, 4);
      assert.ok(names.every(n => /^memento-\d{8}T\d{6}Z-pre-migration\.(dump|dump\.sha256|counts\.json|roles\.sql)$/.test(n)), names.join());
    });

    it("라벨 벌은 같은 날의 이후 백업과 보관 정리에서 지워지지 않는다", () => {
      const dest = freshDir();
      assert.equal(run(["--dir", dest, "--label", "pre-migration"]).status, 0);
      const labelled = fs.readdirSync(dest).filter(n => n.includes("-pre-migration."));

      // 같은 UTC 초에 이름이 겹치지 않도록 라벨 없는 벌은 한 번만 만든다.
      for (const name of OLD_SET("20200101T030000Z")) fs.writeFileSync(path.join(dest, name), "old");
      const res = run(["--dir", dest, "--keep", "1"]);
      assert.equal(res.status, 0, res.stderr);
      for (const name of labelled) assert.equal(fs.existsSync(path.join(dest, name)), true, name);
      assert.match(res.stdout, /removed files: 4/);
    });

    it("--prune-labelled가 없으면 오래된 라벨 벌도 남고, 있으면 그 일수보다 오래된 것만 지운다", () => {
      const dest = freshDir();
      fs.mkdirSync(dest, { mode: 0o700 });
      const old = OLD_SET("20200101T030000Z", "-pre-migration");
      for (const name of old) fs.writeFileSync(path.join(dest, name), "old");

      assert.equal(run(["--dir", dest, "--label", "keep-me"]).status, 0);
      for (const name of old) assert.equal(fs.existsSync(path.join(dest, name)), true, name);

      const res = run(["--dir", dest, "--prune-labelled", "30"]);
      assert.equal(res.status, 0, res.stderr);
      for (const name of old) assert.equal(fs.existsSync(path.join(dest, name)), false, name);
      assert.ok(fs.readdirSync(dest).some(n => n.includes("-keep-me.dump")));
    });

    it("dry-run은 라벨 이름과 정리 대상 라벨 벌을 알린다", () => {
      const dest = freshDir();
      fs.mkdirSync(dest, { mode: 0o700 });
      for (const name of OLD_SET("20200101T030000Z", "-pre-migration")) fs.writeFileSync(path.join(dest, name), "old");
      const res = run(["--dir", dest, "--label", "pre-migration", "--prune-labelled", "30", "--dry-run"]);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /would write: memento-\d{8}T\d{6}Z-pre-migration\.dump$/m);
      assert.equal((res.stdout.match(/would remove: /g) || []).length, 4);
    });

    it("라벨 형식이 틀리면 종료 코드 2다", () => {
      for (const label of ["Up", "a b", "a/b", "a_b", "a".repeat(33)]) {
        assert.equal(run(["--dir", freshDir(), "--label", label, "--dry-run"]).status, 2, label);
      }
    });

    it("--prune-labelled 값이 1 이상의 정수가 아니면 종료 코드 2다", () => {
      for (const days of ["0", "-1", "x", "1.5"]) {
        assert.equal(run(["--dir", freshDir(), "--prune-labelled", days, "--dry-run"]).status, 2, days);
      }
    });
  });

  describe("접속 문자열 거부", () => {
    for (const value of ["postgresql://user:pw-secret@host/db", "postgres://h/db", "host=h dbname=d password=pw-secret", "PASSWORD = pw-secret"]) {
      it(`--dbname ${JSON.stringify(value)} 은 값을 출력하지 않고 거부한다`, () => {
        for (const extra of [[], ["--dry-run"]]) {
          const res = run(["--dir", freshDir(), "--dbname", value, ...extra]);
          assert.equal(res.status, 2);
          assert.match(res.stderr, /접속 문자열/);
          assert.ok(!(res.stdout + res.stderr).includes("pw-secret"));
        }
      });
    }

    it("PGDATABASE 접속 문자열도 거부한다", () => {
      const res = run(["--dir", freshDir(), "--dry-run"], { PGDATABASE: "host=h password=pw-secret" });
      assert.equal(res.status, 2);
      assert.ok(!(res.stdout + res.stderr).includes("pw-secret"));
    });

    it("일반 데이터베이스 이름은 통과한다", () => {
      assert.equal(run(["--dir", freshDir(), "--dbname", "memento-prod_1", "--dry-run"]).status, 0);
    });
  });

  describe("보관 정리 실패", () => {
    it("정책 계산이 실패하면 조용히 넘어가지 않고 종료 코드 1로 알린다", () => {
      const dest = freshDir();
      const res  = run(["--dir", dest], { FAKE_NODE_FAIL_EXPIRE: "1" });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /정책 계산이 실패했다: expire/);
      assert.ok(fs.readdirSync(dest).some(n => n.endsWith(".dump")));
    });

    it("dry-run에서도 정책 계산 실패를 알린다", () => {
      const res = run(["--dir", freshDir(), "--dry-run"], { FAKE_NODE_FAIL_EXPIRE: "1" });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /정책 계산이 실패했다/);
    });
  });

  describe("심볼릭 링크와 기존 파일", () => {
    const STAMP = "20261003T070000Z";
    const NAMES = ["dump", "dump.sha256", "counts.json", "roles.sql"].map(k => `memento-${STAMP}.${k}`);

    const planted = (dest, outside) => {
      fs.mkdirSync(dest, { mode: 0o700 });
      fs.writeFileSync(outside, "precious");
    };

    it("잠금 파일 이름의 심볼릭 링크를 따라가 바깥 파일을 건드리지 않는다", () => {
      const dest    = freshDir();
      const outside = path.join(root, `outside-lock-${seq}.txt`);
      planted(dest, outside);
      fs.symlinkSync(outside, path.join(dest, ".backup.lock"));
      const res = run(["--dir", dest], { FAKE_STAMP: STAMP });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(fs.readFileSync(outside, "utf8"), "precious");
      assert.equal(fs.lstatSync(path.join(dest, ".backup.lock")).isSymbolicLink(), true);
    });

    for (const [i, name] of [...NAMES, ...NAMES.map(n => `${n}.partial`)].entries()) {
      for (const target of ["file", "dangling"]) {
        it(`${name} 이 ${target === "file" ? "바깥 파일" : "없는 대상"}을 가리키는 링크이면 거부하고 아무것도 쓰거나 지우지 않는다 (${i})`, () => {
          const dest    = freshDir();
          const outside = path.join(root, `outside-${seq}-${i}-${target}.txt`);
          planted(dest, outside);
          fs.symlinkSync(target === "file" ? outside : path.join(root, `no-such-${seq}-${i}`), path.join(dest, name));
          fs.writeFileSync(path.join(dest, "memento-20200101T000000Z.dump"), "old plain set");
          const before = fs.readdirSync(dest).sort();

          const res = run(["--dir", dest, "--keep", "1"], { FAKE_STAMP: STAMP });
          assert.notEqual(res.status, 0, res.stdout);
          assert.match(res.stderr, /심볼릭 링크|이미 있거나/);
          assert.equal(fs.readFileSync(outside, "utf8"), "precious");
          assert.deepEqual(fs.readdirSync(dest).sort(), before);
          assert.equal(fs.readFileSync(path.join(dest, "memento-20200101T000000Z.dump"), "utf8"), "old plain set");
          assert.equal(fs.existsSync(path.join(root, `no-such-${seq}-${i}`)), false);
        });
      }
    }

    for (const name of NAMES) {
      it(`${name} 이 일반 파일로 이미 있으면 덮어쓰지 않고 거부한다`, () => {
        const dest = freshDir();
        fs.mkdirSync(dest, { mode: 0o700 });
        fs.writeFileSync(path.join(dest, name), "existing content");
        const res = run(["--dir", dest], { FAKE_STAMP: STAMP });
        assert.notEqual(res.status, 0);
        assert.equal(fs.readFileSync(path.join(dest, name), "utf8"), "existing content");
      });
    }

    it("심볼릭 링크가 있으면 dry-run도 진행하지 않는다", () => {
      const dest    = freshDir();
      const outside = path.join(root, `outside-dry-${seq}.txt`);
      planted(dest, outside);
      fs.symlinkSync(outside, path.join(dest, "memento-20250102T000000Z.counts.json"));
      const res = run(["--dir", dest, "--dry-run"], { FAKE_STAMP: STAMP });
      assert.equal(res.status, 2);
      assert.equal(fs.readFileSync(outside, "utf8"), "precious");
    });

    it("보관 정리 단계에서 링크를 만나면 다른 파일을 하나도 지우지 않고 거부한다", () => {
      const dest    = freshDir();
      const outside = path.join(root, `outside-ret-${seq}.txt`);
      planted(dest, outside);
      for (const name of OLD_SET("20200101T030000Z")) fs.writeFileSync(path.join(dest, name), "old");
      fs.symlinkSync(outside, path.join(dest, "memento-20200102T030000Z.roles.sql"));
      const before = fs.readdirSync(dest).sort();
      const res    = run(["--dir", dest, "--keep", "1"], { FAKE_STAMP: STAMP });
      assert.equal(res.status, 2);
      assert.deepEqual(fs.readdirSync(dest).sort(), before);
      assert.equal(fs.readFileSync(outside, "utf8"), "precious");
    });
  });

  describe("방금 쓴 벌의 보호", () => {
    const NOW_STAMP = "20261003T030000Z";
    const names     = (stamp) => OLD_SET(stamp);
    const make      = (dest, stamp) => { for (const n of names(stamp)) fs.writeFileSync(path.join(dest, n), "x"); };
    const present   = (dest, stamp) => names(stamp).every(n => fs.existsSync(path.join(dest, n)));

    for (const keep of ["1", "14"]) {
      for (const later of ["20261004T030000Z", "20261003T230000Z"]) {
        it(`나중 시각의 벌(${later})이 있어도 keep=${keep} 에서 새 벌과 그 벌을 지우지 않는다`, () => {
          const dest = freshDir();
          fs.mkdirSync(dest, { mode: 0o700 });
          make(dest, later);
          const res = run(["--dir", dest, "--keep", keep], { FAKE_STAMP: NOW_STAMP });
          assert.equal(res.status, 0, res.stderr);
          assert.equal(present(dest, NOW_STAMP), true);
          assert.equal(present(dest, later), true);
          assert.match(res.stdout, /removed files: 0/);
        });

        it(`같은 입력의 dry-run은 실제 실행과 같은 삭제 목록을 낸다 (keep=${keep}, ${later})`, () => {
          const dest = freshDir();
          fs.mkdirSync(dest, { mode: 0o700 });
          make(dest, later);
          make(dest, "20200101T030000Z");
          const dry  = run(["--dir", dest, "--keep", keep, "--dry-run"], { FAKE_STAMP: NOW_STAMP });
          const real = run(["--dir", dest, "--keep", keep], { FAKE_STAMP: NOW_STAMP });
          assert.equal(dry.status, 0, dry.stderr);
          assert.equal(real.status, 0, real.stderr);
          const planned = dry.stdout.split("\n").filter(l => l.startsWith("would remove: ")).map(l => l.slice(14)).sort();
          const removed = real.stdout.split("\n").filter(l => l.startsWith("removed: ")).map(l => l.slice(9)).sort();
          assert.deepEqual(removed, planned);
        });
      }
    }

    it("복사해 넣은 여러 벌이 새 벌보다 늦어도 새 벌과 늦은 벌은 남고 오래된 벌만 규칙대로 정리된다", () => {
      const dest = freshDir();
      fs.mkdirSync(dest, { mode: 0o700 });
      for (const st of ["20261001T030000Z", "20261005T030000Z", "20261006T030000Z", "20261006T230000Z"]) make(dest, st);
      const res = run(["--dir", dest, "--keep", "1"], { FAKE_STAMP: NOW_STAMP });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(present(dest, NOW_STAMP), true);
      for (const st of ["20261005T030000Z", "20261006T030000Z", "20261006T230000Z"]) assert.equal(present(dest, st), true, st);
      assert.equal(present(dest, "20261001T030000Z"), false);
    });
  });

  describe("이름이 비슷한 디렉터리", () => {
    it("관리 대상 이름의 디렉터리가 있어도 실행이 성공하고 디렉터리는 남으며 foreign 으로 알린다", () => {
      const dest = freshDir();
      fs.mkdirSync(dest, { mode: 0o700 });
      fs.mkdirSync(path.join(dest, "memento-20200101T000000Z.roles.sql"));
      fs.mkdirSync(path.join(dest, "memento-20200101T000000Z.dump.partial"));
      for (const name of OLD_SET("20200102T030000Z")) fs.writeFileSync(path.join(dest, name), "old");
      for (let i = 0; i < 2; i++) {
        const res = run(["--dir", dest, "--keep", "1"], { FAKE_STAMP: `2026100${3 + i}T070000Z` });
        assert.equal(res.status, 0, res.stderr);
        assert.match(res.stderr, /foreign entry skipped: memento-20200101T000000Z\.roles\.sql \(directory\)/);
      }
      assert.equal(fs.statSync(path.join(dest, "memento-20200101T000000Z.roles.sql")).isDirectory(), true);
      assert.equal(fs.statSync(path.join(dest, "memento-20200101T000000Z.dump.partial")).isDirectory(), true);
      assert.equal(fs.existsSync(path.join(dest, OLD_SET("20200102T030000Z")[0])), false);
    });
  });

  describe("옵션 값 검증", () => {
    for (const [flag, value] of [["--keep", "08"], ["--keep", "007"], ["--keep", "0"], ["--keep", "99999"], ["--keep", "abc"], ["--keep", "-1"],
                                 ["--prune-labelled", "08"], ["--prune-labelled", "0"], ["--prune-labelled", "99999"]]) {
      it(`${flag} ${value} 은 산술 오류 문구 없이 종료 코드 2로 거부한다`, () => {
        const res = run(["--dir", freshDir(), flag, value, "--dry-run"]);
        assert.equal(res.status, 2);
        assert.doesNotMatch(res.stderr, /syntax|arithmetic|value too great|연산/i);
        assert.equal(res.stderr.trim().split("\n").length, 1, res.stderr);
      });
    }

    it("환경변수 보관 일수의 앞자리 0도 같은 방식으로 거부한다", () => {
      const res = run(["--dir", freshDir(), "--dry-run"], { MEMENTO_BACKUP_KEEP_DAYS: "08" });
      assert.equal(res.status, 2);
      assert.doesNotMatch(res.stderr, /syntax|arithmetic|value too great/i);
    });

    for (const args of [["--dir", "--keep", "5"], ["--keep", "--dry-run"], ["--label", "--dry-run"], ["--dbname", "--dry-run"], ["--host", "--no-roles"]]) {
      it(`값 자리에 옵션이 오면(${args.join(" ")}) 거부한다`, () => {
        const res = run([...args, "--dir", freshDir()]);
        assert.equal(res.status, 2);
        assert.match(res.stderr, /값이 필요하다/);
      });
    }

    it("상속된 dbname 환경변수로 접속 문자열 검사를 우회하거나 역할 덤프에 새지 않는다", () => {
      const log = path.join(root, `stub-${seq}.log`);
      const res = run(["--dir", freshDir()], { dbname: "host=h password=zz", STUB_LOG: log });
      assert.equal(res.status, 0, res.stderr);
      assert.ok(!fs.readFileSync(log, "utf8").includes("password=zz"));
    });
  });
});
