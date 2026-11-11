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
        const stat = fs.statSync(path.join(resolvedLogDir, name));
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
      const resolvedLogDir = RESOLVED_LOG_DIR;
      const entries        = fs.readdirSync(resolvedLogDir);
      const logFiles       = entries.filter(n => n.endsWith(".log") && LOG_FILE_RE.test(n));

      let fileCount      = logFiles.length;
      let totalSizeBytes = 0;
      const dates        = [];

      for (const name of logFiles) {
        const stat = fs.statSync(path.join(resolvedLogDir, name));
        totalSizeBytes += stat.size;
        const m = name.match(LOG_FILE_RE);
        if (m) dates.push(m[2]);
      }

      dates.sort();
      const oldestFile = dates[0] ?? null;
      const newestFile = dates[dates.length - 1] ?? null;

      /** 오늘 날짜의 combined 로그에서 레벨별 카운트 */
      const today         = new Date().toISOString().slice(0, 10);
      const todayCombined = path.join(resolvedLogDir, `combined-${today}.log`);
      const todayCounts   = { info: 0, warn: 0, error: 0, debug: 0 };

      if (fs.existsSync(todayCombined)) {
        const lines = fs.readFileSync(todayCombined, "utf-8").split("\n");
        for (const line of lines) {
          const m = line.match(LOG_LINE_RE);
          if (m && todayCounts[m[2]] !== undefined) {
            todayCounts[m[2]]++;
          }
        }
      }

      /** 오늘 에러 로그에서 최근 10건 */
      const todayError    = path.join(resolvedLogDir, `error-${today}.log`);
      const recentErrors  = [];

      if (fs.existsSync(todayError)) {
        const lines = fs.readFileSync(todayError, "utf-8").split("\n").filter(l => l.length > 0);
        const last10 = lines.slice(-10);
        for (const line of last10) {
          const m = line.match(LOG_LINE_RE);
          if (m) {
            recentErrors.push({ timestamp: m[1], message: m[3] });
          }
        }
      }

      res.statusCode = 200;
      res.end(JSON.stringify({
        today:          todayCounts,
        recentErrors,
        fileCount,
        totalSizeBytes,
        oldestFile,
        newestFile
      }));
    } catch (err) {
      logError("[Admin] /logs/stats error:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return true;
  }

  return false;
}
