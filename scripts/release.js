#!/usr/bin/env node
/**
 * 릴리스 준비 스크립트
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 사용: node scripts/release.js X.Y.Z [--date YYYY-MM-DD] [--skip-ci-check] [--allow-branch]
 *
 * main 브랜치의 깨끗한 작업 트리에서, HEAD 의 Tests 워크플로가 성공했을 때만 진행한다.
 * 다른 브랜치는 --allow-branch 를 명시해야 한다(분리된 HEAD 는 항상 거부).
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

const ROOT           = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_FILES  = ["CHANGELOG.md", "package.json", "package-lock.json", "SKILL.md", "SECURITY.md"];
const CODE_PATHS     = ["lib", "server.js", "scripts", "bin", "config"];
const USAGE          = "사용법: node scripts/release.js X.Y.Z [--date YYYY-MM-DD] [--skip-ci-check] [--allow-branch]";
const RELEASE_BRANCH = "main";
/**
 * 커밋 전 단계의 실패 안내. git add 이후 커밋이 실패하면 변경이 인덱스에 올라가 있으므로
 * 인덱스 기준의 git checkout -- 로는 되돌려지지 않는다. HEAD 기준으로 인덱스와 작업 트리를 함께 되돌린다.
 */
const CHECKOUT_HINT  = `변경 파일 되돌리기: git checkout HEAD -- ${RELEASE_FILES.join(" ")}`;

/** 릴리스 준비를 멈춰야 하는 조건 */
export class ReleaseError extends Error {
  constructor(message, options) {
    super(message, options);
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
 * 본문이 비었거나 하위 제목(###)만 있으면 비어 있는 것으로 본다.
 *
 * @param {string} body
 * @returns {boolean}
 */
function isEmptyBody(body) {
  return body.split("\n").every(line => line.trim() === "" || /^#{3,6}\s/.test(line));
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
  const found = /^## \[Unreleased\][ \t]*$/m.exec(changelog);
  if (!found) throw new ReleaseError("CHANGELOG.md 에 ## [Unreleased] 절이 없다");
  if (changelog.includes(`## [${version}]`)) {
    throw new ReleaseError(`CHANGELOG.md 에 ${version} 절이 이미 있다`);
  }
  const start     = found.index;
  const bodyStart = start + found[0].length;
  const next      = changelog.indexOf("\n## [", bodyStart);
  const body      = changelog.slice(bodyStart, next < 0 ? undefined : next).trim();
  if (isEmptyBody(body)) throw new ReleaseError("[Unreleased] 절이 비어 있다");
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
   * @param {object}   [opts.fsImpl]   - 파일 입출력 구현(시험에서 쓰기 실패를 주입한다)
   * @param {Function} [opts.log]
   * @param {Function} [opts.warn]
   */
  constructor({ root = ROOT, env = process.env, notesDir = os.tmpdir(), quiet = false, fsImpl = fs, log = console.log, warn = console.warn } = {}) {
    this.fsImpl   = fsImpl;
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
    return this.fsImpl.readFileSync(path.join(this.root, file), "utf8");
  }

  /** 임시 파일에 쓴 뒤 이름을 바꿔 넣는다. 실패하면 대상 파일은 그대로다. */
  writeAtomic(file, text) {
    const target = path.join(this.root, file);
    const tmp    = `${target}.release-tmp`;
    try {
      this.fsImpl.writeFileSync(tmp, text);
      this.fsImpl.renameSync(tmp, target);
    } catch (err) {
      this.fsImpl.rmSync(tmp, { force: true });
      throw err;
    }
  }
}

function parseArgs(argv) {
  const version = argv.find(a => /^\d+\.\d+\.\d+$/.test(a));
  const dateIdx = argv.indexOf("--date");
  const date    = dateIdx >= 0 ? argv[dateIdx + 1] : new Date().toISOString().slice(0, 10);
  if (!version) throw new ReleaseError(USAGE);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) throw new ReleaseError(`날짜 형식이 YYYY-MM-DD 가 아니다: ${date}`);
  return { version, date, skipCi: argv.includes("--skip-ci-check"), allowBranch: argv.includes("--allow-branch") };
}

function resolveBranch(ws, allowBranch) {
  const branch = ws.run("git", ["branch", "--show-current"]).trim();
  if (!branch) {
    throw new ReleaseError("HEAD 가 분리되어 있다. 브랜치로 이동한 뒤 다시 실행한다");
  }
  if (branch === RELEASE_BRANCH) return branch;
  if (!allowBranch) {
    throw new ReleaseError(`현재 브랜치가 ${RELEASE_BRANCH} 가 아니다: ${branch}. 의도한 것이면 --allow-branch 를 준다`);
  }
  ws.warn(`[release] --allow-branch: ${RELEASE_BRANCH} 가 아닌 브랜치 ${branch} 에서 릴리스한다. 출력된 push 명령은 이 브랜치를 대상으로 한다`);
  return branch;
}

function assertReleasable(ws, version, allowBranch) {
  const branch  = resolveBranch(ws, allowBranch);
  const current = JSON.parse(ws.read("package.json")).version;
  if (compareVersions(version, current) <= 0) {
    throw new ReleaseError(`새 버전 ${version} 은 현재 ${current} 보다 커야 한다`);
  }
  if (ws.run("git", ["tag", "-l", `v${version}`]).trim()) throw new ReleaseError(`태그 v${version} 이 이미 있다`);
  const dirty = ws.run("git", ["status", "--porcelain", "--untracked-files=no"]).trim();
  if (dirty) throw new ReleaseError(`커밋되지 않은 변경이 있다:\n${dirty}`);
  return branch;
}

/** gh 조회 실패는 원문 출력 없이 ReleaseError 로 바꾼다(--skip-ci-check 를 주지 않으면 진행하지 않는다). */
function fetchWorkflowRuns(ws) {
  const skipHint = "CI 확인 없이 진행하려면 --skip-ci-check 를 준다";
  let out;
  try {
    out = ws.run("gh", [
      "run", "list", "--workflow", "test.yml", "--limit", "30",
      "--json", "headSha,status,conclusion,databaseId"
    ]);
  } catch (err) {
    const reason = err.code === "ENOENT" ? "gh 를 찾지 못했다" : "gh 호출이 실패했다(로그인, 네트워크 확인)";
    throw new ReleaseError(`Tests 워크플로 결과를 조회하지 못했다: ${reason}. ${skipHint}`);
  }
  let runs;
  try {
    runs = JSON.parse(out);
  } catch {
    runs = null;
  }
  if (!Array.isArray(runs)) {
    throw new ReleaseError(`Tests 워크플로 조회 결과를 해석하지 못했다: gh 출력이 JSON 목록이 아니다. ${skipHint}`);
  }
  return runs;
}

function assertCiGreen(ws, sha) {
  const runs = fetchWorkflowRuns(ws).filter(r => r.headSha === sha);
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

/** 다섯 파일을 읽어 줄바꿈을 검사하고, 모든 변환을 검증해 새 내용을 만든다. 파일은 쓰지 않는다. */
function planFiles(ws, version, date) {
  const originals = Object.fromEntries(RELEASE_FILES.map(file => [file, ws.read(file)]));
  for (const file of RELEASE_FILES) {
    if (originals[file].includes("\r\n")) {
      throw new ReleaseError(`${file} 이 CRLF 줄바꿈이다. LF 로 바꾼 뒤 다시 실행한다`);
    }
  }
  const changelog = promoteUnreleased(originals["CHANGELOG.md"], version, date);
  const next      = {
    "CHANGELOG.md"     : changelog,
    "package.json"     : bumpPackageJson(originals["package.json"], version),
    "package-lock.json": bumpLockfile(originals["package-lock.json"], version),
    "SKILL.md"         : updateSkillVersion(originals["SKILL.md"], version),
    "SECURITY.md"      : updateSecurityTable(originals["SECURITY.md"], version)
  };
  return { originals, next, changelog };
}

/** 쓰기 도중 실패하면 이미 쓴 파일을 원래 내용으로 되돌린다. */
function writeAll(ws, originals, next) {
  const written = [];
  try {
    for (const file of RELEASE_FILES) {
      ws.writeAtomic(file, next[file]);
      written.push(file);
    }
  } catch (err) {
    const stuck = [];
    for (const file of written) {
      try {
        ws.writeAtomic(file, originals[file]);
      } catch {
        stuck.push(file);
      }
    }
    if (stuck.length > 0) {
      throw new ReleaseError(`파일 쓰기가 실패했고(${err.message}) 복원하지 못한 파일이 있다: ${stuck.join(", ")}. ${CHECKOUT_HINT}`, { cause: err });
    }
    throw new ReleaseError(`파일 쓰기가 실패했다(${err.message}). 이미 쓴 파일은 원래 내용으로 복원했다`, { cause: err });
  }
}

function runChecks(ws) {
  try {
    ws.run("npm", ["run", "lint"], { show: true });
    ws.run("npm", ["run", "lint:migrations"], { show: true });
    ws.run("npm", ["test"], { show: true });
  } catch (err) {
    throw new ReleaseError(`검사가 실패했다(${err.message}).`, { cause: err });
  }
}

/** 단계가 실패하면 되돌리는 명령 한 줄을 메시지에 붙인다. */
function withHint(hint, step) {
  try {
    return step();
  } catch (err) {
    throw new ReleaseError(`${err.message}\n${hint}`, { cause: err });
  }
}

/** 셸 메타문자가 있으면 작은따옴표로 감싼다. */
function shellQuote(text) {
  return /^[\w./@+-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

function printNextSteps(ws, { version, notesPath, branch, skipCi }) {
  const lines = ["", `[release] 커밋과 태그 v${version} 을 만들었다. 아래 명령은 소유자가 직접 실행한다:`];
  if (skipCi) lines.push("[release] 경고: --skip-ci-check 로 HEAD 의 CI 결과를 확인하지 않았다");
  lines.push(
    `  git push origin ${shellQuote(branch)}`,
    `  git push origin v${version}`,
    `  gh release create v${version} --title v${version} --notes-file ${shellQuote(notesPath)}`,
    ""
  );
  ws.log(lines.join("\n"));
}

/**
 * @param {string[]} argv
 * @param {object}   [options] - Workspace 옵션(시험에서 임시 저장소를 주입한다)
 * @returns {Promise<{version: string, tag: string, notesPath: string}>}
 */
export async function main(argv, options = {}) {
  const ws                                     = new Workspace(options);
  const { version, date, skipCi, allowBranch } = parseArgs(argv);

  const branch = assertReleasable(ws, version, allowBranch);
  if (skipCi) {
    ws.warn("[release] --skip-ci-check: HEAD 의 CI 결과를 확인하지 않는다");
  } else {
    assertCiGreen(ws, ws.run("git", ["rev-parse", "HEAD"]).trim());
  }
  reportMissingChangelog(ws);

  const { originals, next, changelog } = planFiles(ws, version, date);
  writeAll(ws, originals, next);

  withHint(CHECKOUT_HINT, () => {
    runChecks(ws);
    ws.run("git", ["add", ...RELEASE_FILES]);
    ws.run("git", ["commit", "-m", `release: ${version}`]);
  });

  const notesPath = path.join(ws.notesDir, `anchormind-v${version}-notes.md`);
  withHint(`커밋과 태그 되돌리기: git tag -d v${version}; git reset --hard HEAD~1`, () => {
    ws.run("git", ["tag", "-a", `v${version}`, "-m", `release: ${version}`]);
    ws.fsImpl.writeFileSync(notesPath, extractReleaseNotes(changelog, version));
  });

  printNextSteps(ws, { version, notesPath, branch, skipCi });
  return { version, tag: `v${version}`, notesPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`[release] ${err.message}`);
    process.exitCode = 1;
  });
}
