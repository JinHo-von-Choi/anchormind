#!/usr/bin/env node
/**
 * 릴리스 준비 스크립트
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 사용: node scripts/release.js X.Y.Z [--date YYYY-MM-DD] [--skip-ci-check]
 *
 * 작업 트리가 깨끗하고 HEAD 의 Tests 워크플로가 성공했을 때만 진행한다.
 * CHANGELOG [Unreleased] 를 버전 절로 옮기고 package.json, package-lock.json,
 * SKILL.md, SECURITY.md 의 버전 표기를 갱신한 뒤 lint, 마이그레이션 lint,
 * 단위 시험을 돌린다. 로컬 커밋과 annotated tag 만 만들고, push 와 GitHub Release
 * 생성 명령은 출력만 한다. gh 는 읽기 전용 조회(run list)에만 쓴다.
 */

import { execFileSync }  from "node:child_process";
import fs                from "node:fs";
import os                from "node:os";
import path              from "node:path";
import { fileURLToPath } from "node:url";

const ROOT          = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_FILES = ["CHANGELOG.md", "package.json", "package-lock.json", "SKILL.md", "SECURITY.md"];
const CODE_PATHS    = ["lib", "server.js", "scripts", "bin", "config"];
const USAGE         = "사용법: node scripts/release.js X.Y.Z [--date YYYY-MM-DD] [--skip-ci-check]";

/** 릴리스 준비를 멈춰야 하는 조건 */
export class ReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseError";
  }
}

/**
 * @param {string} version
 * @returns {number[]} [major, minor, patch]
 */
export function parseVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (!m) throw new ReleaseError(`버전 형식이 X.Y.Z 가 아니다: ${version}`);
  return m.slice(1).map(Number);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} a 가 크면 양수
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * [Unreleased] 절 본문을 새 버전 절로 옮긴다.
 *
 * @param {string} changelog
 * @param {string} version
 * @param {string} date - YYYY-MM-DD
 * @returns {string}
 */
export function promoteUnreleased(changelog, version, date) {
  const head  = "## [Unreleased]";
  const start = changelog.indexOf(head);
  if (start < 0) throw new ReleaseError("CHANGELOG.md 에 ## [Unreleased] 절이 없다");
  if (changelog.includes(`## [${version}]`)) {
    throw new ReleaseError(`CHANGELOG.md 에 ${version} 절이 이미 있다`);
  }
  const bodyStart = start + head.length;
  const next      = changelog.indexOf("\n## [", bodyStart);
  const body      = changelog.slice(bodyStart, next < 0 ? undefined : next).trim();
  if (body.length === 0) throw new ReleaseError("[Unreleased] 절이 비어 있다");
  const rest = next < 0 ? "" : changelog.slice(next);
  return `${changelog.slice(0, start)}${head}\n\n## [${version}] - ${date}\n\n${body}\n${rest}`;
}

/**
 * 버전 절의 본문(제목 줄 제외)을 돌려준다.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {string}
 */
export function extractReleaseNotes(changelog, version) {
  const start = changelog.indexOf(`## [${version}]`);
  if (start < 0) throw new ReleaseError(`CHANGELOG.md 에 ${version} 절이 없다`);
  const lineEnd = changelog.indexOf("\n", start);
  const next    = changelog.indexOf("\n## [", lineEnd);
  return changelog.slice(lineEnd + 1, next < 0 ? undefined : next).trim() + "\n";
}

/**
 * SECURITY.md 지원 표를 새 버전에 맞춘다. 같은 마이너의 패치면 그대로 둔다.
 *
 * @param {string} security
 * @param {string} version
 * @returns {string}
 */
export function updateSecurityTable(security, version) {
  const [major, minor] = parseVersion(version);
  const supported      = `| ${major}.${minor}.x | 지원 |`;
  if (security.includes(supported)) return security;
  const supportedRow   = /^\| \d+\.\d+\.x \| 지원 \|$/m;
  const unsupportedRow = /^\| \d+(?:\.\d+|\.x) 이하 \| 미지원 \|$/m;
  if (!supportedRow.test(security) || !unsupportedRow.test(security)) {
    throw new ReleaseError("SECURITY.md 지원 표 형식을 찾지 못했다");
  }
  const previous = minor > 0 ? `${major}.${minor - 1}` : `${major - 1}.x`;
  return security
    .replace(supportedRow, supported)
    .replace(unsupportedRow, `| ${previous} 이하 | 미지원 |`);
}

/**
 * @param {string} skill
 * @param {string} version
 * @returns {string}
 */
export function updateSkillVersion(skill, version) {
  const line = /^## 현재 버전: v\d+\.\d+\.\d+$/m;
  if (!line.test(skill)) throw new ReleaseError("SKILL.md 의 현재 버전 줄을 찾지 못했다");
  return skill.replace(line, `## 현재 버전: v${version}`);
}

/**
 * package.json 최상위 version 만 바꾼다(들여쓰기 2칸 형식 기준).
 *
 * @param {string} text
 * @param {string} version
 * @returns {string}
 */
export function bumpPackageJson(text, version) {
  const top = /^( {2}"version": ")[^"]+(")/m;
  if (!top.test(text)) throw new ReleaseError("package.json 최상위 version 을 찾지 못했다");
  return text.replace(top, `$1${version}$2`);
}

/**
 * package-lock.json 의 최상위와 packages[""] version 을 바꾼다.
 *
 * @param {string} text
 * @param {string} version
 * @returns {string}
 */
export function bumpLockfile(text, version) {
  const top  = /^( {2}"version": ")[^"]+(")/m;
  const root = /("packages": \{\s*"": \{[^{}]*?\n {6}"version": ")[^"]+(")/;
  if (!top.test(text) || !root.test(text)) {
    throw new ReleaseError("package-lock.json 의 version 위치를 찾지 못했다");
  }
  return text.replace(top, `$1${version}$2`).replace(root, `$1${version}$2`);
}

/**
 * 한 번의 릴리스 준비가 쓰는 작업 저장소, 환경, 출력 경로를 묶는다.
 */
class Workspace {
  /**
   * @param {object}   [opts]
   * @param {string}   [opts.root]     - 대상 저장소 최상위
   * @param {object}   [opts.env]      - 하위 프로세스 환경
   * @param {string}   [opts.notesDir] - Release 본문 파일을 둘 디렉터리
   * @param {boolean}  [opts.quiet]    - true 면 npm 출력을 가린다
   * @param {Function} [opts.log]
   * @param {Function} [opts.warn]
   */
  constructor({ root = ROOT, env = process.env, notesDir = os.tmpdir(), quiet = false, log = console.log, warn = console.warn } = {}) {
    this.root     = root;
    this.env      = env;
    this.notesDir = notesDir;
    this.quiet    = quiet;
    this.log      = log;
    this.warn     = warn;
  }

  run(cmd, args, { show = false } = {}) {
    return execFileSync(cmd, args, {
      cwd     : this.root,
      env     : this.env,
      encoding: "utf8",
      stdio   : show && !this.quiet ? "inherit" : ["ignore", "pipe", "pipe"]
    });
  }

  read(file) {
    return fs.readFileSync(path.join(this.root, file), "utf8");
  }

  write(file, text) {
    fs.writeFileSync(path.join(this.root, file), text);
  }
}

function parseArgs(argv) {
  const version = argv.find(a => /^\d+\.\d+\.\d+$/.test(a));
  const dateIdx = argv.indexOf("--date");
  const date    = dateIdx >= 0 ? argv[dateIdx + 1] : new Date().toISOString().slice(0, 10);
  if (!version) throw new ReleaseError(USAGE);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) throw new ReleaseError(`날짜 형식이 YYYY-MM-DD 가 아니다: ${date}`);
  return { version, date, skipCi: argv.includes("--skip-ci-check") };
}

function assertReleasable(ws, version) {
  const current = JSON.parse(ws.read("package.json")).version;
  if (compareVersions(version, current) <= 0) {
    throw new ReleaseError(`새 버전 ${version} 은 현재 ${current} 보다 커야 한다`);
  }
  if (ws.run("git", ["tag", "-l", `v${version}`]).trim()) throw new ReleaseError(`태그 v${version} 이 이미 있다`);
  const dirty = ws.run("git", ["status", "--porcelain", "--untracked-files=no"]).trim();
  if (dirty) throw new ReleaseError(`커밋되지 않은 변경이 있다:\n${dirty}`);
}

function assertCiGreen(ws, sha) {
  const runs = JSON.parse(ws.run("gh", [
    "run", "list", "--workflow", "test.yml", "--limit", "30",
    "--json", "headSha,status,conclusion,databaseId"
  ])).filter(r => r.headSha === sha);
  if (runs.length === 0) {
    throw new ReleaseError(`HEAD ${sha.slice(0, 7)} 의 Tests 워크플로 실행이 없다. push 후 CI 완료를 기다린다`);
  }
  const latest = runs[0];
  if (latest.status !== "completed" || latest.conclusion !== "success") {
    throw new ReleaseError(
      `HEAD ${sha.slice(0, 7)} 의 Tests 워크플로가 성공 상태가 아니다: ` +
      `${latest.status}/${latest.conclusion} (run ${latest.databaseId})`
    );
  }
}

function listCodeCommitsWithoutChangelog(ws) {
  let lastTag;
  try {
    lastTag = ws.run("git", ["describe", "--tags", "--abbrev=0", "--match", "v*"]).trim();
  } catch {
    throw new ReleaseError("직전 릴리스 태그(v*)를 찾지 못했다");
  }
  const shas    = ws.run("git", ["log", "--format=%h", `${lastTag}..HEAD`, "--", ...CODE_PATHS])
    .split("\n").filter(Boolean);
  const missing = shas
    .filter(sha => !ws.run("git", ["show", "--name-only", "--format=", sha]).split("\n").includes("CHANGELOG.md"))
    .map(sha => ws.run("git", ["log", "-1", "--format=%h %s", sha]).trim());
  return { lastTag, missing };
}

function reportMissingChangelog(ws) {
  const { lastTag, missing } = listCodeCommitsWithoutChangelog(ws);
  if (missing.length === 0) return;
  ws.log(`[release] ${lastTag} 이후 변경 이력을 함께 고치지 않은 코드 커밋 ${missing.length}건. [Unreleased] 반영 여부를 확인한다:`);
  for (const line of missing) ws.log(`  ${line}`);
}

function applyVersion(ws, version, date) {
  const changelog = promoteUnreleased(ws.read("CHANGELOG.md"), version, date);
  ws.write("CHANGELOG.md", changelog);
  ws.write("package.json", bumpPackageJson(ws.read("package.json"), version));
  ws.write("package-lock.json", bumpLockfile(ws.read("package-lock.json"), version));
  ws.write("SKILL.md", updateSkillVersion(ws.read("SKILL.md"), version));
  ws.write("SECURITY.md", updateSecurityTable(ws.read("SECURITY.md"), version));
  return changelog;
}

function runChecks(ws) {
  try {
    ws.run("npm", ["run", "lint"], { show: true });
    ws.run("npm", ["run", "lint:migrations"], { show: true });
    ws.run("npm", ["test"], { show: true });
  } catch (err) {
    throw new ReleaseError(
      `검사가 실패했다(${err.message}). 변경 파일 되돌리기: git checkout -- ${RELEASE_FILES.join(" ")}`
    );
  }
}

function commitAndTag(ws, version) {
  ws.run("git", ["add", ...RELEASE_FILES]);
  ws.run("git", ["commit", "-m", `release: ${version}`]);
  ws.run("git", ["tag", "-a", `v${version}`, "-m", `release: ${version}`]);
}

function printNextSteps(ws, version, notesPath) {
  ws.log([
    "",
    `[release] 커밋과 태그 v${version} 을 만들었다. 아래 명령은 소유자가 직접 실행한다:`,
    "  git push origin main",
    `  git push origin v${version}`,
    `  gh release create v${version} --title v${version} --notes-file ${notesPath}`,
    ""
  ].join("\n"));
}

/**
 * @param {string[]} argv
 * @param {object}   [options] - Workspace 옵션(시험에서 임시 저장소를 주입한다)
 * @returns {Promise<{version: string, tag: string, notesPath: string}>}
 */
export async function main(argv, options = {}) {
  const ws                        = new Workspace(options);
  const { version, date, skipCi } = parseArgs(argv);

  assertReleasable(ws, version);
  if (skipCi) {
    ws.warn("[release] --skip-ci-check: HEAD 의 CI 결과를 확인하지 않는다");
  } else {
    assertCiGreen(ws, ws.run("git", ["rev-parse", "HEAD"]).trim());
  }
  reportMissingChangelog(ws);

  const changelog = applyVersion(ws, version, date);
  runChecks(ws);
  commitAndTag(ws, version);

  const notesPath = path.join(ws.notesDir, `anchormind-v${version}-notes.md`);
  fs.writeFileSync(notesPath, extractReleaseNotes(changelog, version));
  printNextSteps(ws, version, notesPath);
  return { version, tag: `v${version}`, notesPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`[release] ${err.message}`);
    process.exitCode = 1;
  });
}
