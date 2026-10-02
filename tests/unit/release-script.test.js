/**
 * 릴리스 준비 스크립트 시험
 *
 * 문서 변환 함수는 순수 함수 단위로, 전체 절차는 시험이 직접 만든 임시 git 저장소와
 * 가짜 gh 실행 파일 위에서 확인한다. 작업 저장소와 원격에는 접근하지 않는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import { execFileSync, spawnSync }     from "node:child_process";
import fs                              from "node:fs";
import os                              from "node:os";
import path                            from "node:path";
import { fileURLToPath }               from "node:url";

import {
  ReleaseError, compareVersions, promoteUnreleased, extractReleaseNotes,
  updateSecurityTable, updateSkillVersion, bumpPackageJson, bumpLockfile, main
} from "../../scripts/release.js";

const REPO_ROOT      = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
const RELEASE_SCRIPT = path.join(REPO_ROOT, "scripts", "release.js");

const CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Changed",
  "",
  "- 항목 하나.",
  "",
  "## [5.12.0] - 2026-10-02",
  "",
  "### Added",
  "",
  "- 이전 항목.",
  ""
].join("\n");

const SECURITY = "| 버전 | 지원 |\n|-|-|\n| 5.11.x | 지원 |\n| 5.10 이하 | 미지원 |\n";

describe("compareVersions", () => {
  it("숫자 크기로 비교한다", () => {
    assert.ok(compareVersions("5.12.1", "5.12.0") > 0);
    assert.ok(compareVersions("5.10.0", "5.9.9") > 0);
    assert.equal(compareVersions("5.12.0", "5.12.0"), 0);
  });

  it("형식이 다르면 ReleaseError", () => {
    assert.throws(() => compareVersions("5.12", "5.12.0"), ReleaseError);
  });
});

describe("promoteUnreleased", () => {
  it("[Unreleased] 본문을 새 버전 절로 옮기고 빈 [Unreleased]를 남긴다", () => {
    const out = promoteUnreleased(CHANGELOG, "5.13.0", "2026-10-10");
    assert.match(out, /## \[Unreleased\]\n\n## \[5\.13\.0\] - 2026-10-10\n\n### Changed\n\n- 항목 하나\.\n\n## \[5\.12\.0\]/);
  });

  it("[Unreleased]가 비어 있으면 ReleaseError", () => {
    const empty = CHANGELOG.replace("### Changed\n\n- 항목 하나.\n\n", "");
    assert.throws(() => promoteUnreleased(empty, "5.13.0", "2026-10-10"), /비어 있다/);
  });

  it("같은 버전 절이 이미 있으면 ReleaseError", () => {
    assert.throws(() => promoteUnreleased(CHANGELOG, "5.12.0", "2026-10-10"), /이미 있다/);
  });
});

describe("extractReleaseNotes", () => {
  it("해당 버전 절의 본문만 돌려준다", () => {
    assert.equal(extractReleaseNotes(CHANGELOG, "5.12.0"), "### Added\n\n- 이전 항목.\n");
  });
});

describe("updateSecurityTable", () => {
  it("마이너 릴리스면 지원 행과 미지원 경계를 올린다", () => {
    const out = updateSecurityTable(SECURITY, "5.12.0");
    assert.match(out, /\| 5\.12\.x \| 지원 \|/);
    assert.match(out, /\| 5\.11 이하 \| 미지원 \|/);
  });

  it("같은 마이너의 패치 릴리스면 그대로 둔다", () => {
    const once = updateSecurityTable(SECURITY, "5.12.0");
    assert.equal(updateSecurityTable(once, "5.12.3"), once);
  });

  it("표 형식을 찾지 못하면 ReleaseError", () => {
    assert.throws(() => updateSecurityTable("표 없음", "5.13.0"), ReleaseError);
  });
});

describe("버전 표기 갱신", () => {
  it("SKILL.md 현재 버전 줄을 바꾼다", () => {
    assert.equal(updateSkillVersion("# x\n\n## 현재 버전: v5.12.0\n", "5.13.0"), "# x\n\n## 현재 버전: v5.13.0\n");
  });

  it("package.json 최상위 version만 바꾼다", () => {
    const pkg = '{\n  "name": "a",\n  "version": "5.12.0",\n  "dependencies": {\n    "x": {\n      "version": "1.0.0"\n    }\n  }\n}\n';
    const out = bumpPackageJson(pkg, "5.13.0");
    assert.equal(JSON.parse(out).version, "5.13.0");
    assert.equal(JSON.parse(out).dependencies.x.version, "1.0.0");
  });

  it("package-lock.json 최상위와 packages[\"\"]의 version을 바꾼다", () => {
    const lock = JSON.stringify({
      name: "anchormind-mcp", version: "5.12.0", lockfileVersion: 3,
      packages: { "": { name: "anchormind-mcp", version: "5.12.0" }, "node_modules/x": { version: "5.12.0" } }
    }, null, 2) + "\n";
    const out = JSON.parse(bumpLockfile(lock, "5.13.0"));
    assert.equal(out.version, "5.13.0");
    assert.equal(out.packages[""].version, "5.13.0");
    assert.equal(out.packages["node_modules/x"].version, "5.12.0");
  });
});

/**
 * 시험이 만든 임시 디렉터리에서만 동작하도록 보장한다.
 * 작업 저장소이거나 임시 디렉터리 밖이거나 자기 자신이 최상위 저장소가 아니면 즉시 실패한다.
 */
function assertTempPath(dir) {
  const real = fs.realpathSync(dir);
  const tmp  = fs.realpathSync(os.tmpdir());
  assert.ok(real.startsWith(tmp + path.sep), `임시 디렉터리 밖이다: ${real}`);
  assert.notEqual(real, REPO_ROOT, "작업 저장소에서는 실행하지 않는다");
  assert.ok(!REPO_ROOT.startsWith(real + path.sep), "작업 저장소의 상위 경로이다");
  return real;
}

function assertOwnTempRepo(dir) {
  const real = assertTempPath(dir);
  const top = execFileSync("git", ["-C", real, "rev-parse", "--show-toplevel"], { encoding: "utf8", env: gitEnv() }).trim();
  assert.equal(fs.realpathSync(top), real, "임시 저장소의 최상위가 아니다");
}

function gitEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...extra };
}

const FAKE_GH = [
  "#!/bin/sh",
  "echo \"$@\" >> \"$FAKE_GH_LOG\"",
  "if [ \"$1\" = \"run\" ] && [ \"$2\" = \"list\" ]; then cat \"$FAKE_GH_RUNS\"; exit 0; fi",
  "echo \"unexpected gh call: $*\" >&2",
  "exit 97",
  ""
].join("\n");

const LOCK = JSON.stringify({
  name: "release-fixture", version: "5.12.0", lockfileVersion: 3,
  packages: { "": { name: "release-fixture", version: "5.12.0" } }
}, null, 2) + "\n";

const SKILL = "# Skill\n\n## 현재 버전: v5.12.0\n";

class Fixture {
  constructor() {
    this.base    = fs.mkdtempSync(path.join(os.tmpdir(), "release-script-test-"));
    this.dir     = path.join(this.base, "repo");
    this.bin     = path.join(this.base, "bin");
    this.notes   = path.join(this.base, "notes");
    this.markers = path.join(this.base, "markers.log");
    this.ghLog   = path.join(this.base, "gh.log");
    this.ghRuns  = path.join(this.base, "gh-runs.json");
    fs.mkdirSync(this.dir);
    fs.mkdirSync(this.bin);
    fs.mkdirSync(this.notes);
    fs.writeFileSync(this.ghLog, "");
    this.#writeGh();
    this.#initRepo();
  }

  #writeGh() {
    const ghPath = path.join(this.bin, "gh");
    fs.writeFileSync(ghPath, FAKE_GH);
    fs.chmodSync(ghPath, 0o755);
  }

  #initRepo() {
    assertTempPath(this.dir);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: this.dir, env: gitEnv() });
    this.git("config", "user.name", "Release Test");
    this.git("config", "user.email", "release-test@example.invalid");
    this.git("config", "commit.gpgsign", "false");
    this.git("config", "tag.gpgsign", "false");
    this.write("package.json", this.#packageJson(false));
    this.write("package-lock.json", LOCK);
    this.write("CHANGELOG.md", CHANGELOG.replace("## [Unreleased]\n\n### Changed\n\n- 항목 하나.\n\n", "## [Unreleased]\n\n"));
    this.write("SKILL.md", SKILL);
    this.write("SECURITY.md", SECURITY);
    this.write("lib/a.js", "export const a = 1;\n");
    this.git("add", "-A");
    this.git("commit", "-q", "-m", "base");
    this.git("tag", "-a", "v5.12.0", "-m", "release: 5.12.0");
    this.write("lib/b.js", "export const b = 1;\n");
    this.git("add", "-A");
    this.git("commit", "-q", "-m", "코드만 바꾼 커밋");
    this.write("lib/c.js", "export const c = 1;\n");
    this.write("CHANGELOG.md", CHANGELOG);
    this.git("add", "-A");
    this.git("commit", "-q", "-m", "변경 이력과 함께 바꾼 커밋");
  }

  #packageJson(failLint) {
    const mark = (name) => `node -e "require('fs').appendFileSync('${this.markers}', '${name}\\n')"`;
    const lint = failLint ? 'node -e "process.exit(1)"' : mark("lint");
    const pkg  = {
      name   : "release-fixture",
      version: "5.12.0",
      scripts: { lint, "lint:migrations": mark("lint:migrations"), test: mark("test") }
    };
    return JSON.stringify(pkg, null, 2) + "\n";
  }

  failLint() {
    this.write("package.json", this.#packageJson(true));
    this.git("commit", "-q", "-am", "lint 실패 설정");
  }

  write(file, text) {
    const full = path.join(this.dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }

  read(file) {
    return fs.readFileSync(path.join(this.dir, file), "utf8");
  }

  git(...args) {
    assertOwnTempRepo(this.dir);
    return execFileSync("git", args, { cwd: this.dir, encoding: "utf8", env: gitEnv() });
  }

  head() {
    return this.git("rev-parse", "HEAD").trim();
  }

  setRuns(runs) {
    fs.writeFileSync(this.ghRuns, JSON.stringify(runs));
  }

  setRunsFor(conclusion, status = "completed") {
    this.setRuns([{ headSha: this.head(), status, conclusion, databaseId: 4242 }]);
  }

  env() {
    return gitEnv({
      PATH         : `${this.bin}${path.delimiter}${process.env.PATH}`,
      FAKE_GH_LOG  : this.ghLog,
      FAKE_GH_RUNS : this.ghRuns
    });
  }

  ghCalls() {
    return fs.readFileSync(this.ghLog, "utf8").split("\n").filter(Boolean);
  }

  markerLines() {
    return fs.existsSync(this.markers) ? fs.readFileSync(this.markers, "utf8").split("\n").filter(Boolean) : [];
  }

  run(argv, extra = {}) {
    assertOwnTempRepo(this.dir);
    const logs  = [];
    const warns = [];
    const opts  = {
      root: this.dir, env: this.env(), notesDir: this.notes, quiet: true,
      log : (m) => logs.push(m), warn: (m) => warns.push(m), ...extra
    };
    return main(argv, opts).then((result) => ({ result, logs, warns }));
  }

  dispose() {
    fs.rmSync(this.base, { recursive: true, force: true });
  }
}

describe("릴리스 절차 (임시 저장소, 가짜 gh)", () => {
  let fx;

  before(() => {
    const probe = new Fixture();
    try {
      const out = execFileSync("sh", ["-c", "command -v gh"], { encoding: "utf8", env: probe.env() });
      assert.ok(out.startsWith(os.tmpdir()), "gh 가 가짜 실행 파일로 해석되지 않는다");
    } finally {
      probe.dispose();
    }
  });

  after(() => {
    fx?.dispose();
  });

  async function fresh() {
    fx?.dispose();
    fx = new Fixture();
    return fx;
  }

  it("임시 저장소 검사가 작업 저장소를 거부한다", () => {
    assert.throws(() => assertOwnTempRepo(REPO_ROOT), /임시 디렉터리 밖|작업 저장소/);
  });

  it("CI 성공 HEAD에서 커밋과 annotated tag를 만들고 명령만 출력한다", async () => {
    const f = await fresh();
    f.setRunsFor("success");
    const before = f.head();

    const { result, logs } = await f.run(["5.13.0", "--date", "2026-10-10"]);

    assert.equal(f.git("log", "-1", "--format=%s").trim(), "release: 5.13.0");
    assert.equal(f.git("rev-parse", "HEAD~1").trim(), before);
    assert.equal(f.git("cat-file", "-t", "v5.13.0").trim(), "tag");
    assert.equal(f.git("rev-parse", "v5.13.0^{commit}").trim(), f.head());
    assert.equal(f.git("status", "--porcelain", "--untracked-files=no").trim(), "");
    assert.equal(f.git("remote").trim(), "");

    assert.equal(JSON.parse(f.read("package.json")).version, "5.13.0");
    assert.equal(JSON.parse(f.read("package-lock.json")).packages[""].version, "5.13.0");
    assert.match(f.read("CHANGELOG.md"), /## \[Unreleased\]\n\n## \[5\.13\.0\] - 2026-10-10\n/);
    assert.match(f.read("SKILL.md"), /## 현재 버전: v5\.13\.0/);
    assert.match(f.read("SECURITY.md"), /\| 5\.13\.x \| 지원 \|\n\| 5\.12 이하 \| 미지원 \|/);
    assert.deepEqual(f.markerLines(), ["lint", "lint:migrations", "test"]);

    const text = logs.join("\n");
    assert.match(text, /git push origin main/);
    assert.match(text, /git push origin v5\.13\.0/);
    assert.match(text, /gh release create v5\.13\.0 --title v5\.13\.0 --notes-file /);
    assert.match(text, /변경 이력을 함께 고치지 않은 코드 커밋 1건/);
    assert.match(text, /코드만 바꾼 커밋/);
    assert.doesNotMatch(text, /변경 이력과 함께 바꾼 커밋/);
    assert.equal(fs.readFileSync(result.notesPath, "utf8"), "### Changed\n\n- 항목 하나.\n");

    const calls = f.ghCalls();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^run list --workflow test\.yml /);
  });

  it("CI가 실패한 HEAD는 거부하고 아무것도 바꾸지 않는다", async () => {
    const f = await fresh();
    f.setRunsFor("failure");
    const before = f.head();

    await assert.rejects(f.run(["5.13.0"]), /Tests 워크플로가 성공 상태가 아니다: completed\/failure \(run 4242\)/);

    assert.equal(f.head(), before);
    assert.equal(f.git("tag", "-l", "v5.13.0").trim(), "");
    assert.equal(f.git("status", "--porcelain", "--untracked-files=no").trim(), "");
    assert.deepEqual(f.markerLines(), []);
  });

  it("CI가 진행 중이면 거부한다", async () => {
    const f = await fresh();
    f.setRuns([{ headSha: f.head(), status: "in_progress", conclusion: "", databaseId: 7 }]);
    await assert.rejects(f.run(["5.13.0"]), /in_progress/);
  });

  it("HEAD의 실행이 없으면 거부한다", async () => {
    const f = await fresh();
    f.setRuns([{ headSha: "0".repeat(40), status: "completed", conclusion: "success", databaseId: 1 }]);
    await assert.rejects(f.run(["5.13.0"]), /실행이 없다/);
  });

  it("작업 트리가 깨끗하지 않으면 gh를 부르기 전에 거부한다", async () => {
    const f = await fresh();
    f.setRunsFor("success");
    f.write("lib/a.js", "export const a = 2;\n");
    await assert.rejects(f.run(["5.13.0"]), /커밋되지 않은 변경/);
    assert.deepEqual(f.ghCalls(), []);
  });

  it("--skip-ci-check는 gh를 부르지 않고 경고한다", async () => {
    const f = await fresh();
    const { warns } = await f.run(["5.13.0", "--skip-ci-check"]);
    assert.deepEqual(f.ghCalls(), []);
    assert.match(warns.join("\n"), /--skip-ci-check/);
    assert.equal(f.git("cat-file", "-t", "v5.13.0").trim(), "tag");
  });

  it("현재 이하의 버전과 이미 있는 태그는 거부한다", async () => {
    const f = await fresh();
    f.setRunsFor("success");
    await assert.rejects(f.run(["5.12.0"]), /보다 커야 한다/);
    f.git("tag", "v5.13.0");
    await assert.rejects(f.run(["5.13.0"]), /이미 있다/);
  });

  it("lint가 실패하면 커밋과 태그를 만들지 않는다", async () => {
    const f = await fresh();
    f.failLint();
    f.setRunsFor("success");
    const before = f.head();

    await assert.rejects(f.run(["5.13.0"]), /검사가 실패했다.*git checkout --/s);

    assert.equal(f.head(), before);
    assert.equal(f.git("tag", "-l", "v5.13.0").trim(), "");
  });

  it("명령줄 실행은 CI가 붉은 HEAD에서 종료 코드 1과 메시지를 낸다", async () => {
    const f = await fresh();
    f.setRunsFor("failure");
    const script = path.join(f.dir, "scripts", "release.js");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(RELEASE_SCRIPT, script);
    f.git("add", "-A");
    f.git("commit", "-q", "-m", "스크립트 사본");
    f.setRunsFor("failure");

    assertOwnTempRepo(f.dir);
    const res = spawnSync(process.execPath, [script, "5.13.0"], { cwd: f.dir, encoding: "utf8", env: f.env() });

    assert.equal(res.status, 1);
    assert.match(res.stderr, /Tests 워크플로가 성공 상태가 아니다/);
    assert.equal(f.git("tag", "-l", "v5.13.0").trim(), "");
  });
});
