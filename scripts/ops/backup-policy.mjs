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
 *   node scripts/ops/backup-policy.mjs guard <저장 위치>        저장소 안쪽, 루트, 홈 디렉터리 자체면 종료 코드 2
 *   node scripts/ops/backup-policy.mjs expire <저장 위치> <일수> [--with <시각>[:<라벨>]] [--prune-labelled <일수>]
 *                                                             삭제 대상 파일 이름을 한 줄씩 출력. --with 는 그 시각의
 *                                                             새 벌이 있는 것으로 보고 고른다
 *   node scripts/ops/backup-policy.mjs partials <저장 위치>      이 스크립트가 남긴 미확정 파일 이름을 한 줄씩 출력
 *   node scripts/ops/backup-policy.mjs set <시각> [라벨]         한 번의 백업 파일 이름을 출력
 */

import fs               from "node:fs";
import os               from "node:os";
import path             from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const STAMP_PATTERN   = /^\d{8}T\d{6}Z$/;
const LABEL_PATTERN   = /^[a-z0-9-]{1,32}$/;
const FILE_SOURCE     = "memento-(\\d{8})T(\\d{6})Z(?:-([a-z0-9-]{1,32}))?\\.(dump\\.sha256|dump|counts\\.json|roles\\.sql)";
const FILE_PATTERN    = new RegExp(`^${FILE_SOURCE}$`);
const PARTIAL_PATTERN = new RegExp(`^${FILE_SOURCE}\\.partial$`);
const DAY_MS          = 86400000;

/** 정책 위반. 메시지에는 거부한 값만 담는다. */
export class BackupPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackupPolicyError";
  }
}

/**
 * 관리 대상 백업 파일 이름을 해석한다. 파일 한 벌은 dump, dump.sha256, counts.json,
 * roles.sql 네 종류이고 dump가 있어야 완결된 벌이다. 라벨이 붙은 벌은
 * memento-<시각>-<라벨> 로 이름 짓는다.
 *
 * @param {string} name
 * @returns {{stamp: string, day: string, label: string|null, kind: string}|null} 관리 대상이 아니면 null
 */
export function parseBackupFile(name) {
  const match = FILE_PATTERN.exec(String(name));
  if (!match) return null;
  return { stamp: `${match[1]}T${match[2]}Z`, day: match[1], label: match[3] ?? null, kind: match[4] };
}

/**
 * 이 스크립트가 쓰다 남긴 미확정 파일 이름인지 판정한다. 관리 대상 이름에 .partial 이
 * 붙은 것만 해당하며, 다른 프로그램의 .partial 파일은 해당하지 않는다.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isOwnPartial(name) {
  return PARTIAL_PATTERN.test(String(name));
}

/**
 * 라벨 형식을 검사한다.
 *
 * @param {string} label
 * @returns {string} 같은 라벨
 */
export function assertLabel(label) {
  if (typeof label !== "string" || !LABEL_PATTERN.test(label)) {
    throw new BackupPolicyError(`라벨은 [a-z0-9-] 1자 이상 32자 이하여야 한다: ${JSON.stringify(label)}`);
  }
  return label;
}

/**
 * 시각에서 한 번의 백업이 만드는 파일 이름 묶음을 만든다.
 *
 * @param {string} stamp YYYYMMDDTHHMMSSZ
 * @param {string|null} [label=null] 라벨. 있으면 보관 일수 정리에서 제외된다
 * @returns {{dump: string, sha256: string, counts: string, roles: string}}
 */
export function backupSet(stamp, label = null) {
  if (!STAMP_PATTERN.test(String(stamp))) {
    throw new BackupPolicyError(`백업 시각 형식이 아니다: ${JSON.stringify(stamp)}`);
  }
  const stem = label === null ? `memento-${stamp}` : `memento-${stamp}-${assertLabel(label)}`;
  return {
    dump  : `${stem}.dump`,
    sha256: `${stem}.dump.sha256`,
    counts: `${stem}.counts.json`,
    roles : `${stem}.roles.sql`
  };
}

/**
 * 시각 문자열을 Date로 바꾼다.
 *
 * @param {string} stamp YYYYMMDDTHHMMSSZ
 * @returns {Date}
 */
function stampToDate(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
}

/**
 * 보관 일수를 넘긴 백업 파일을 고른다. 라벨이 없는 벌 중 완결된 벌(dump 파일이 있는 벌)만
 * 날짜별로 가장 늦은 한 벌을 대표로 삼고, 최근 keepDays개 날짜의 대표를 남긴다. 나머지
 * 벌과 dump 없이 남은 조각은 삭제 대상이다. 라벨이 붙은 벌은 보관 일수와 무관하게 남기며,
 * pruneLabelledDays가 주어졌을 때만 그 일수보다 오래된 라벨 벌을 삭제 대상에 넣는다.
 * 관리 대상이 아닌 이름은 다루지 않는다. 시간 복잡도 O(n log n).
 *
 * @param {string[]} names 저장 위치의 파일 이름 목록
 * @param {number} keepDays 남길 날짜 수(1 이상의 정수)
 * @param {{pruneLabelledDays?: number|null, now?: Date}} [options]
 * @returns {string[]} 정렬된 삭제 대상 파일 이름
 */
export function selectExpired(names, keepDays, options = {}) {
  const { pruneLabelledDays = null, now = new Date() } = options;
  if (!Number.isInteger(keepDays) || keepDays < 1) {
    throw new BackupPolicyError(`보관 일수는 1 이상의 정수여야 한다: ${String(keepDays)}`);
  }
  if (pruneLabelledDays !== null && (!Number.isInteger(pruneLabelledDays) || pruneLabelledDays < 1)) {
    throw new BackupPolicyError(`라벨 벌 정리 일수는 1 이상의 정수여야 한다: ${String(pruneLabelledDays)}`);
  }

  const plain    = [];
  const labelled = [];
  for (const name of names) {
    const info = parseBackupFile(name);
    if (!info) continue;
    (info.label === null ? plain : labelled).push({ name, ...info });
  }

  const newestByDay = new Map();
  for (const item of plain) {
    if (item.kind !== "dump") continue;
    const current = newestByDay.get(item.day);
    if (current === undefined || item.stamp > current) newestByDay.set(item.day, item.stamp);
  }

  const keptDays   = [...newestByDay.keys()].sort().reverse().slice(0, keepDays);
  const keptStamps = new Set(keptDays.map(day => newestByDay.get(day)));

  const expired = plain.filter(item => !keptStamps.has(item.stamp)).map(item => item.name);

  if (pruneLabelledDays !== null) {
    const cutoff = now.getTime() - pruneLabelledDays * DAY_MS;
    for (const item of labelled) {
      if (stampToDate(item.stamp).getTime() < cutoff) expired.push(item.name);
    }
  }
  return expired.sort();
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
 * 저장 위치가 파일 시스템 루트이거나 홈 디렉터리 자체이면 거부한다.
 *
 * @param {string} dest 저장 위치
 * @param {string|undefined} home 홈 디렉터리
 * @param {(p: string) => string} [resolve=resolveReal] 경로 해석 함수
 * @returns {string} 같은 저장 위치
 */
export function assertNotProtectedDir(dest, home, resolve = resolveReal) {
  const resolvedDest = resolve(dest);
  if (resolvedDest === path.parse(resolvedDest).root) {
    throw new BackupPolicyError(`파일 시스템 루트 ${resolvedDest} 는 저장 위치로 쓸 수 없다`);
  }
  if (typeof home === "string" && home !== "" && resolvedDest === resolve(home)) {
    throw new BackupPolicyError(`홈 디렉터리 ${resolvedDest} 자체는 저장 위치로 쓸 수 없다. 하위 디렉터리를 지정한다`);
  }
  return dest;
}

/**
 * 명령줄 진입점.
 *
 * @param {string[]} argv
 * @param {{out: (line: string) => void}} [io]
 * @returns {void}
 */
export function main(argv, io = { out: (line) => process.stdout.write(`${line}\n`) }) {
  const [command, first, ...rest] = argv;
  if (command === "guard") {
    const resolved = assertOutsideRepo(first, REPO_ROOT);
    assertNotProtectedDir(resolved, process.env.HOME ?? os.homedir());
    io.out(resolved);
  } else if (command === "expire") {
    const [keep, ...flags] = rest;
    if (!/^\d+$/.test(String(keep))) throw new BackupPolicyError(`보관 일수는 정수여야 한다: ${String(keep)}`);
    const options = parseExpireFlags(flags);
    const existing = fs.existsSync(first) ? fs.readdirSync(first) : [];
    const planned  = options.planned === null ? [] : Object.values(backupSet(options.planned.stamp, options.planned.label));
    for (const name of selectExpired([...existing, ...planned], Number(keep), { pruneLabelledDays: options.pruneLabelledDays })) {
      if (!planned.includes(name)) io.out(name);
    }
  } else if (command === "partials") {
    if (!fs.existsSync(first)) return;
    for (const name of fs.readdirSync(first).sort()) {
      if (isOwnPartial(name)) io.out(name);
    }
  } else if (command === "set") {
    const names = backupSet(first, rest[0] ?? null);
    for (const kind of ["dump", "sha256", "counts", "roles"]) io.out(names[kind]);
  } else {
    throw new BackupPolicyError("명령은 guard, expire, partials, set 중 하나여야 한다");
  }
}

/**
 * expire 명령의 선택 인자를 해석한다.
 *
 * @param {string[]} flags --with <시각>[:<라벨>], --prune-labelled <일수>
 * @returns {{planned: {stamp: string, label: string|null}|null, pruneLabelledDays: number|null}}
 */
function parseExpireFlags(flags) {
  const out = { planned: null, pruneLabelledDays: null };
  for (let i = 0; i < flags.length; i += 2) {
    const value = flags[i + 1];
    if (flags[i] === "--with") {
      const [stamp, label] = String(value).split(":");
      out.planned = { stamp, label: label ?? null };
    } else if (flags[i] === "--prune-labelled") {
      if (!/^\d+$/.test(String(value))) throw new BackupPolicyError(`라벨 벌 정리 일수는 정수여야 한다: ${String(value)}`);
      out.pruneLabelledDays = Number(value);
    } else {
      throw new BackupPolicyError(`알 수 없는 인자: ${String(flags[i])}`);
    }
  }
  return out;
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
