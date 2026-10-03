#!/usr/bin/env node
/**
 * 백업 보관 정책
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * backup.sh가 쓰는 순수 판정을 한 곳에 둔다. 백업 파일 이름 규칙, 보관 일수에 따른
 * 삭제 대상 선정, 저장 위치가 저장소 안쪽인지 검사한다. 데이터베이스에는 접속하지 않고
 * 환경 파일도 읽지 않는다.
 *
 * 명령줄:
 *   node scripts/ops/backup-policy.mjs guard <저장 위치>        저장소 안쪽이면 종료 코드 2
 *   node scripts/ops/backup-policy.mjs expire <저장 위치> <일수> [시각]
 *                                                             삭제 대상 파일 이름을 한 줄씩 출력. 시각을 주면
 *                                                             그 시각의 새 벌이 있는 것으로 보고 고른다
 *   node scripts/ops/backup-policy.mjs set <시각>                한 번의 백업 파일 이름을 출력
 */

import fs               from "node:fs";
import path             from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const STAMP_PATTERN = /^\d{8}T\d{6}Z$/;
const FILE_PATTERN  = /^memento-(\d{8})T(\d{6})Z\.(dump\.sha256|dump|counts\.json|roles\.sql)$/;

/** 정책 위반. 메시지에는 거부한 값만 담는다. */
export class BackupPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackupPolicyError";
  }
}

/**
 * 관리 대상 백업 파일 이름을 해석한다. 파일 한 벌은 dump, dump.sha256, counts.json,
 * roles.sql 네 종류이고 dump가 있어야 완결된 벌이다.
 *
 * @param {string} name
 * @returns {{stamp: string, day: string, kind: string}|null} 관리 대상이 아니면 null
 */
export function parseBackupFile(name) {
  const match = FILE_PATTERN.exec(String(name));
  if (!match) return null;
  return { stamp: `${match[1]}T${match[2]}Z`, day: match[1], kind: match[3] };
}

/**
 * 시각에서 한 번의 백업이 만드는 파일 이름 묶음을 만든다.
 *
 * @param {string} stamp YYYYMMDDTHHMMSSZ
 * @returns {{dump: string, sha256: string, counts: string, roles: string}}
 */
export function backupSet(stamp) {
  if (!STAMP_PATTERN.test(String(stamp))) {
    throw new BackupPolicyError(`백업 시각 형식이 아니다: ${JSON.stringify(stamp)}`);
  }
  return {
    dump  : `memento-${stamp}.dump`,
    sha256: `memento-${stamp}.dump.sha256`,
    counts: `memento-${stamp}.counts.json`,
    roles : `memento-${stamp}.roles.sql`
  };
}

/**
 * 보관 일수를 넘긴 백업 파일을 고른다. 완결된 벌(dump 파일이 있는 벌)만 날짜별로
 * 가장 늦은 한 벌을 대표로 삼고, 최근 keepDays개 날짜의 대표를 남긴다. 나머지 벌과
 * dump 없이 남은 조각은 모두 삭제 대상이다. 관리 대상이 아닌 이름은 다루지 않는다.
 * 시간 복잡도 O(n log n).
 *
 * @param {string[]} names 저장 위치의 파일 이름 목록
 * @param {number} keepDays 남길 날짜 수(1 이상의 정수)
 * @returns {string[]} 정렬된 삭제 대상 파일 이름
 */
export function selectExpired(names, keepDays) {
  if (!Number.isInteger(keepDays) || keepDays < 1) {
    throw new BackupPolicyError(`보관 일수는 1 이상의 정수여야 한다: ${String(keepDays)}`);
  }

  const parsed = [];
  for (const name of names) {
    const info = parseBackupFile(name);
    if (info) parsed.push({ name, ...info });
  }

  const newestByDay = new Map();
  for (const item of parsed) {
    if (item.kind !== "dump") continue;
    const current = newestByDay.get(item.day);
    if (current === undefined || item.stamp > current) newestByDay.set(item.day, item.stamp);
  }

  const keptDays   = [...newestByDay.keys()].sort().reverse().slice(0, keepDays);
  const keptStamps = new Set(keptDays.map(day => newestByDay.get(day)));

  return parsed.filter(item => !keptStamps.has(item.stamp)).map(item => item.name).sort();
}

/**
 * 경로를 심볼릭 링크까지 풀어 절대 경로로 만든다. 아직 없는 꼬리 경로는 존재하는
 * 가장 가까운 상위 경로를 푼 값에 그대로 붙인다.
 *
 * @param {string} target
 * @returns {string}
 */
export function resolveReal(target) {
  let current = path.resolve(target);
  const rest  = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...rest);
}

/**
 * 저장 위치가 저장소 안쪽이면 거부한다.
 *
 * @param {string} dest 저장 위치
 * @param {string} repoRoot 저장소 루트
 * @param {(p: string) => string} [resolve=resolveReal] 경로 해석 함수
 * @returns {string} 해석된 저장 위치
 */
export function assertOutsideRepo(dest, repoRoot, resolve = resolveReal) {
  if (typeof dest !== "string" || dest.trim() === "") {
    throw new BackupPolicyError("저장 위치가 비어 있다");
  }
  const resolvedDest = resolve(dest);
  const resolvedRepo = resolve(repoRoot);
  const relative     = path.relative(resolvedRepo, resolvedDest);
  const inside       = relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  if (inside) {
    throw new BackupPolicyError(`저장 위치 ${resolvedDest} 는 저장소 ${resolvedRepo} 안쪽이다`);
  }
  return resolvedDest;
}

/**
 * 명령줄 진입점.
 *
 * @param {string[]} argv
 * @param {{out: (line: string) => void}} [io]
 * @returns {void}
 */
export function main(argv, io = { out: (line) => process.stdout.write(`${line}\n`) }) {
  const [command, first, second, third] = argv;
  if (command === "guard") {
    io.out(assertOutsideRepo(first, REPO_ROOT));
  } else if (command === "expire") {
    if (!/^\d+$/.test(String(second))) throw new BackupPolicyError(`보관 일수는 정수여야 한다: ${String(second)}`);
    const existing = fs.existsSync(first) ? fs.readdirSync(first) : [];
    const planned  = third === undefined ? [] : Object.values(backupSet(third));
    for (const name of selectExpired([...existing, ...planned], Number(second))) {
      if (!planned.includes(name)) io.out(name);
    }
  } else if (command === "set") {
    const names = backupSet(first);
    for (const kind of ["dump", "sha256", "counts", "roles"]) io.out(names[kind]);
  } else {
    throw new BackupPolicyError("명령은 guard, expire, set 중 하나여야 한다");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`백업 정책 거부: ${err.message}\n`);
    process.exitCode = err instanceof BackupPolicyError ? 2 : 1;
    if (!(err instanceof BackupPolicyError)) throw err;
  }
}
