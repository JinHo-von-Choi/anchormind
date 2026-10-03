/**
 * 디렉터리 아래 파일 묶음의 안전한 검사와 쓰기
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * init이 만드는 파일 묶음을 다룬다.
 *   inspectUnder      기준 디렉터리 아래 경로의 모든 조각을 lstat으로 보며, 어느 조각이든 심볼릭 링크거나
 *                     중간 조각이 디렉터리가 아니면 막힌 경로로 본다. 심볼릭 링크를 따라 기준 밖에 쓰지 않는다.
 *   unwritableTargets 쓰기 전에 각 파일이 놓일 가장 가까운 기존 디렉터리의 쓰기 권한을 본다.
 *   writeAll          파일마다 같은 디렉터리의 임시 파일에 쓴 뒤 rename으로 바꾼다. 도중에 실패하면 이번 실행이
 *                     만든 파일과 디렉터리를 지우고 바꾼 파일의 원래 내용을 되돌린 뒤 FileTransactionError를 던진다.
 */

import fs     from "node:fs";
import path   from "node:path";
import crypto from "node:crypto";

/** 쓰기 도중 실패. path는 실패한 파일, leftovers는 되돌리지 못한 경로다. */
export class FileTransactionError extends Error {
  constructor(failedPath, cause, leftovers) {
    super(`${failedPath}: ${cause.code ?? cause.message}`, { cause });
    this.name      = "FileTransactionError";
    this.path      = failedPath;
    this.code      = cause.code ?? null;
    this.leftovers = leftovers;
  }
}

/**
 * @param {string} p
 * @returns {fs.Stats|null}
 */
function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * 기준 디렉터리 아래 상대 경로(/ 구분)의 상태.
 *
 * @param {string} root 실제 경로로 푼 기준 디렉터리
 * @param {string} relPath
 * @returns {{ kind: "missing" } | { kind: "file", content: string } | { kind: "blocked", reason: string }}
 */
export function inspectUnder(root, relPath) {
  const parts = relPath.split("/");
  let   cur   = root;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    const stat = lstatOrNull(cur);
    if (!stat) return { kind: "missing" };
    const shown = parts.slice(0, i + 1).join("/");
    if (stat.isSymbolicLink()) return { kind: "blocked", reason: `symbolic link at ${shown}` };
    if (i < parts.length - 1 && !stat.isDirectory()) return { kind: "blocked", reason: `${shown} is not a directory` };
  }
  return fs.lstatSync(cur).isFile()
    ? { kind: "file", content: fs.readFileSync(cur, "utf8") }
    : { kind: "blocked", reason: "not a regular file" };
}

/**
 * 경로에서 위로 올라가며 처음 있는 조상 경로.
 *
 * @param {string} p
 * @returns {string}
 */
function nearestExisting(p) {
  let cur = p;
  while (!lstatOrNull(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
  return cur;
}

/**
 * 쓸 수 없는 파일 경로 목록. 파일이 놓일 가장 가까운 기존 디렉터리에 쓰기 권한이 없으면 쓸 수 없다.
 *
 * @param {Array<{ absPath: string }>} entries
 * @param {{ accessSync: Function }} ops
 * @returns {string[]}
 */
export function unwritableTargets(entries, ops) {
  const denied = [];
  for (const entry of entries) {
    const dir = nearestExisting(path.dirname(entry.absPath));
    try {
      ops.accessSync(dir, fs.constants.W_OK);
    } catch (err) {
      denied.push(`${entry.absPath} (${err.code ?? err.message})`);
    }
  }
  return denied;
}

/** 같은 디렉터리의 임시 파일 경로 */
const tempPathFor = (absPath) =>
  path.join(path.dirname(absPath), `.${path.basename(absPath)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);

/**
 * 없는 상위 디렉터리를 위에서부터 만들고 만든 경로를 기록한다.
 */
function ensureDirs(dir, ops, journal) {
  const missing = [];
  for (let cur = dir; !lstatOrNull(cur); cur = path.dirname(cur)) missing.unshift(cur);
  for (const d of missing) {
    ops.mkdirSync(d, { mode: 0o755 });
    journal.dirs.push(d);
  }
}

/**
 * 파일 하나를 임시 파일에 쓴 뒤 rename으로 바꾼다.
 */
function writeOne(entry, ops, journal) {
  ensureDirs(path.dirname(entry.absPath), ops, journal);
  const temp = tempPathFor(entry.absPath);
  journal.temp = temp;
  ops.writeFileSync(temp, entry.content, { mode: 0o644, flag: "wx" });
  ops.renameSync(temp, entry.absPath);
  journal.temp = null;
  if (entry.status === "create") journal.files.push(entry.absPath);
  else journal.replaced.push({ absPath: entry.absPath, existing: entry.existing });
}

/**
 * 이번 실행의 변경을 거꾸로 되돌린다. 되돌리지 못한 경로를 돌려준다.
 *
 * @returns {string[]}
 */
function rollback(journal, ops) {
  const leftovers = [];
  const attempt   = (label, fn) => {
    try {
      fn();
    } catch (err) {
      leftovers.push(`${label} (${err.code ?? err.message})`);
    }
  };
  if (journal.temp && lstatOrNull(journal.temp)) attempt(journal.temp, () => ops.unlinkSync(journal.temp));
  for (const file of [...journal.files].reverse()) attempt(file, () => ops.unlinkSync(file));
  for (const { absPath, existing } of [...journal.replaced].reverse()) {
    attempt(absPath, () => {
      const temp = tempPathFor(absPath);
      ops.writeFileSync(temp, existing, { mode: 0o644, flag: "wx" });
      ops.renameSync(temp, absPath);
    });
  }
  for (const dir of [...journal.dirs].reverse()) attempt(dir, () => ops.rmdirSync(dir));
  return leftovers;
}

/**
 * 묶음 전체를 쓴다. 실패하면 되돌리고 FileTransactionError를 던진다.
 *
 * @param {Array<{ absPath: string, content: string, status: "create"|"conflict", existing: string }>} entries
 * @param {object} ops fs 함수 묶음(accessSync, mkdirSync, writeFileSync, renameSync, unlinkSync, rmdirSync)
 * @returns {number} 쓴 파일 수
 */
export function writeAll(entries, ops) {
  const journal = { files: [], replaced: [], dirs: [], temp: null };
  let   current = null;
  try {
    for (const entry of entries) {
      current = entry.absPath;
      writeOne(entry, ops, journal);
    }
  } catch (err) {
    throw new FileTransactionError(current, err, rollback(journal, ops));
  }
  return entries.length;
}
