/**
 * Admin 로그 뷰어 핸들러
 *
 * 작성자: 최진호
 * 작성일: 2026-03-27
 */

import fs   from "node:fs";
import path from "node:path";

import { LOG_DIR }     from "../config.js";
import { logError }    from "../logger.js";
import { ADMIN_BASE }  from "./admin-auth.js";

const LOG_FILE_RE   = /^(\w+)-(\d{4}-\d{2}-\d{2})\.log$/;
const LOG_LINE_RE   = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[(\w+)\]: (.*)$/;
const RESOLVED_LOG_DIR = path.resolve(LOG_DIR);

/**
 * 로그 파일 이름에 들어가는 날짜(YYYY-MM-DD). 로그 로테이션이 서버 현지 시간으로 파일 이름을 지으므로 같은 기준을 쓴다.
 *
 * @param {Date} now
 * @returns {string}
 */
function localDateStamp(now) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 파일 정보를 읽는다. 목록을 읽은 뒤 로테이션으로 지워진 파일이면 null이다.
 *
 * @param {string} filePath
 * @returns {fs.Stats|null}
 */
function statIfPresent(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * 파일 내용을 읽는다. 없거나 읽기 직전에 로테이션으로 옮겨졌으면 null이다.
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function readIfPresent(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * 로그 디렉터리의 파일 수, 크기, 날짜 범위와 오늘 로그의 레벨별 건수, 최근 오류 10건을 모은다.
 *
 * @param {string} logDir
 * @param {Date}   [now=new Date()]
 * @returns {{ today: Record<string, number>, recentErrors: Array<{timestamp: string, message: string}>,
 *             fileCount: number, totalSizeBytes: number, oldestFile: string|null, newestFile: string|null }}
 */
export function readLogStats(logDir, now = new Date()) {
  const entries        = fs.readdirSync(logDir);
  const dates          = [];
  let   totalSizeBytes = 0;

  for (const name of entries) {
    const m = name.match(LOG_FILE_RE);
    if (!m) continue;
    const stat = statIfPresent(path.join(logDir, name));
    if (!stat) continue;
    totalSizeBytes += stat.size;
    dates.push(m[2]);
  }

  dates.sort();

  const today       = localDateStamp(now);
  const todayCounts = { info: 0, warn: 0, error: 0, debug: 0 };
  const combined    = readIfPresent(path.join(logDir, `combined-${today}.log`));
  for (const line of combined?.split("\n") ?? []) {
    const m = line.match(LOG_LINE_RE);
    if (m && Object.hasOwn(todayCounts, m[2])) todayCounts[m[2]]++;
  }

  const recentErrors = [];
  const errors       = readIfPresent(path.join(logDir, `error-${today}.log`));
  const errorLines   = errors?.split("\n").filter(l => l.length > 0) ?? [];
  for (const line of errorLines.slice(-10)) {
    const m = line.match(LOG_LINE_RE);
    if (m) recentErrors.push({ timestamp: m[1], message: m[3] });
  }

  return {
    today     : todayCounts,
    recentErrors,
    fileCount : dates.length,
    totalSizeBytes,
    oldestFile: dates[0] ?? null,
    newestFile: dates[dates.length - 1] ?? null
  };
}

/**
 * /logs/* 핸들러
 * @returns {boolean} 처리 여부
 */
export async function handleLogs(req, res, url) {
  /** GET /logs/files */
  if (req.method === "GET" && url.pathname === `${ADMIN_BASE}/logs/files`) {
    try {
      const resolvedLogDir = RESOLVED_LOG_DIR;
      const entries        = fs.readdirSync(resolvedLogDir);
      const files          = [];
      let   totalSize      = 0;

      for (const name of entries) {
        if (!name.endsWith(".log")) continue;
        const m = name.match(LOG_FILE_RE);
        if (!m) continue;
        const stat = statIfPresent(path.join(resolvedLogDir, name));
        if (!stat) continue;
        files.push({ name, type: m[1], date: m[2], size: stat.size });
        totalSize += stat.size;
      }

      files.sort((a, b) => b.date.localeCompare(a.date));

      res.statusCode = 200;
      res.end(JSON.stringify({ files, totalSize, logDir: LOG_DIR }));
    } catch (err) {
      logError("[Admin] /logs/files error:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return true;
  }

  /** GET /logs/read?file=...&tail=200&level=...&search=... */
  if (req.method === "GET" && url.pathname === `${ADMIN_BASE}/logs/read`) {
    try {
      const fileParam = url.searchParams.get("file");
      if (!fileParam) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "file parameter is required" }));
        return true;
      }

      const basename    = path.basename(fileParam);
      const filePath    = path.join(RESOLVED_LOG_DIR, basename);

      if (!filePath.startsWith(RESOLVED_LOG_DIR + path.sep) && filePath !== RESOLVED_LOG_DIR) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: "Forbidden" }));
        return true;
      }
      if (!basename.endsWith(".log")) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: "Only .log files allowed" }));
        return true;
      }

      if (!fs.existsSync(filePath)) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "File not found" }));
        return true;
      }

      const rawTail    = parseInt(url.searchParams.get("tail") ?? "200", 10);
      const tail       = Math.min(1000, Math.max(1, Number.isNaN(rawTail) ? 200 : rawTail));
      const levelParam = url.searchParams.get("level")?.toLowerCase() ?? null;
      const search     = url.searchParams.get("search") ?? null;

      /** 파일 끝에서 tail 줄만 읽기 (대용량 파일 대응) */
      const CHUNK = 64 * 1024;
      const fd    = fs.openSync(filePath, "r");
      const fstat = fs.fstatSync(fd);
      let collected = "";
      let pos       = fstat.size;

      while (pos > 0) {
        const readSize = Math.min(CHUNK, pos);
        pos -= readSize;
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, pos);
        collected = buf.toString("utf-8") + collected;
        const lineCount = collected.split("\n").filter(l => l.length > 0).length;
        if (lineCount >= tail + 10) break;
      }
      fs.closeSync(fd);

      const rawLines  = collected.split("\n").filter(l => l.length > 0);
      const tailLines = rawLines.slice(-tail);

      /** 파싱: 정규식 비매칭 줄은 이전 항목의 message에 이어붙임 */
      const parsed = [];
      for (const line of tailLines) {
        const m = line.match(LOG_LINE_RE);
        if (m) {
          parsed.push({ timestamp: m[1], level: m[2], message: m[3] });
        } else if (parsed.length > 0) {
          parsed[parsed.length - 1].message += "\n" + line;
        }
      }

      const total = parsed.length;
      let filtered = parsed;

      if (levelParam) {
        filtered = filtered.filter(e => e.level === levelParam);
      }
      if (search) {
        const lower = search.toLowerCase();
        filtered = filtered.filter(e => e.message.toLowerCase().includes(lower));
      }

      res.statusCode = 200;
      res.end(JSON.stringify({
        file:     basename,
        lines:    filtered,
        total,
        filtered: filtered.length
      }));
    } catch (err) {
      logError("[Admin] /logs/read error:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return true;
  }

  /** GET /logs/stats */
  if (req.method === "GET" && url.pathname === `${ADMIN_BASE}/logs/stats`) {
    try {
      res.statusCode = 200;
      res.end(JSON.stringify(readLogStats(RESOLVED_LOG_DIR)));
    } catch (err) {
      logError("[Admin] /logs/stats error:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return true;
  }

  return false;
}
