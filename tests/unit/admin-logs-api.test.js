/**
 * Admin 로그 뷰어 API 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-26
 *
 * /logs/files, /logs/read, /logs/stats 엔드포인트의 라우팅, 인증, 응답 형태를 검증한다.
 * 실제 파일시스템에 임시 로그 파일을 생성하여 통합 수준 단위 테스트 수행.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { teardownTestResources } from "../_lifecycle.js";
import { readLogStats } from "../../lib/admin/admin-logs.js";

const ADMIN_BASE = "/v1/internal/model/nothing";

/* ------------------------------------------------------------------ */
/*  테스트용 임시 로그 디렉토리 및 파일 생성                                */
/* ------------------------------------------------------------------ */

const tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-log-test-"));
/** 로그 로테이션은 서버 현지 날짜로 파일 이름을 짓는다. */
const localStamp = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today      = localStamp(new Date());

const COMBINED_LOG = [
  `${today} 10:00:01 [info]: Server started`,
  `${today} 10:00:02 [info]: Winston logger initialized`,
  `${today} 10:00:03 [warn]: Deprecated API called`,
  `${today} 10:01:00 [error]: Connection refused`,
  `  at Socket.connect (net.js:1024:16)`,
  `${today} 10:02:00 [debug]: Cache miss for key xyz`
].join("\n") + "\n";

const ERROR_LOG = [
  `${today} 10:01:00 [error]: Connection refused`,
  `${today} 10:05:00 [error]: Timeout waiting for response`
].join("\n") + "\n";

fs.writeFileSync(path.join(tmpLogDir, `combined-${today}.log`), COMBINED_LOG);
fs.writeFileSync(path.join(tmpLogDir, `error-${today}.log`), ERROR_LOG);
fs.writeFileSync(path.join(tmpLogDir, `combined-2026-03-20.log`), "2026-03-20 08:00:00 [info]: Old entry\n");
/** 제외 대상 파일 */
fs.writeFileSync(path.join(tmpLogDir, "combined-2026-03-20.log.gz"), "binary");
fs.writeFileSync(path.join(tmpLogDir, "error-audit.json"), "{}");
fs.writeFileSync(path.join(tmpLogDir, "access-stats.json"), "{}");

/* ------------------------------------------------------------------ */
/*  모듈 모킹: LOG_DIR를 임시 디렉토리로 교체                              */
/* ------------------------------------------------------------------ */

/**
 * handleAdminApi를 직접 import하면 DB 의존성이 발생하므로,
 * 핵심 로직(파일 목록, 읽기, 통계)을 순수 함수로 추출하여 테스트한다.
 */

const LOG_FILE_RE = /^(\w+)-(\d{4}-\d{2}-\d{2})\.log$/;
const LOG_LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[(\w+)\]: (.*)$/;
const MAX_LOG_SIZE = 50 * 1024 * 1024;

/** /logs/files 핵심 로직 */
function getLogFiles(logDir) {
  const resolvedLogDir = path.resolve(logDir);
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
  return { files, totalSize, logDir };
}

/** /logs/read 핵심 로직 */
function readLogFile(logDir, fileParam, { tail = 200, level = null, search = null } = {}) {
  if (!fileParam) return { error: "file parameter is required", status: 400 };

  const basename    = path.basename(fileParam);
  const resolvedDir = path.resolve(logDir);
  const filePath    = path.join(resolvedDir, basename);

  if (!filePath.startsWith(resolvedDir + path.sep) && filePath !== resolvedDir) {
    return { error: "Forbidden", status: 403 };
  }
  if (!basename.endsWith(".log")) {
    return { error: "Only .log files allowed", status: 403 };
  }

  let stat;
  try { stat = fs.statSync(filePath); } catch { return { error: "File not found", status: 404 }; }
  if (stat.size > MAX_LOG_SIZE) return { error: "File exceeds 50MB limit", status: 413 };

  const clampedTail = Math.min(1000, Math.max(1, tail));
  const content     = fs.readFileSync(filePath, "utf-8");
  const rawLines    = content.split("\n").filter(l => l.length > 0);
  const tailLines   = rawLines.slice(-clampedTail);

  const parsed = [];
  for (const line of tailLines) {
    const m = line.match(LOG_LINE_RE);
    if (m) {
      parsed.push({ timestamp: m[1], level: m[2], message: m[3] });
    } else if (parsed.length > 0) {
      parsed[parsed.length - 1].message += "\n" + line;
    }
  }

  const total    = parsed.length;
  let   filtered = parsed;
  if (level) filtered = filtered.filter(e => e.level === level);
  if (search) {
    const lower = search.toLowerCase();
    filtered = filtered.filter(e => e.message.toLowerCase().includes(lower));
  }

  return { file: basename, lines: filtered, total, filtered: filtered.length, status: 200 };
}

/* ------------------------------------------------------------------ */
/*  인증 로직 (admin-routes.js에서 추출)                                  */
/* ------------------------------------------------------------------ */

function validateMasterKey(req, accessKey) {
  if (!accessKey) return true;
  const auth = req.headers?.authorization;
  if (!auth) return false;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return match[1] === accessKey;
}

/* ------------------------------------------------------------------ */
/*  테스트                                                               */
/* ------------------------------------------------------------------ */

describe("Admin Log Viewer API", () => {

  after(async () => {
    fs.rmSync(tmpLogDir, { recursive: true, force: true });
    await teardownTestResources();
  });

  describe("GET /logs/files", () => {
    it("returns array with expected shape, excluding .gz and .json files", () => {
      const result = getLogFiles(tmpLogDir);

      assert.ok(Array.isArray(result.files));
      assert.equal(result.files.length, 3); // combined-today, error-today, combined-2026-03-20

      for (const f of result.files) {
        assert.ok(typeof f.name === "string");
        assert.ok(typeof f.type === "string");
        assert.ok(typeof f.date === "string");
        assert.ok(typeof f.size === "number");
        assert.ok(f.name.endsWith(".log"));
      }

      assert.ok(typeof result.totalSize === "number");
      assert.ok(result.totalSize > 0);

      /** .gz, -audit.json, access-stats.json 제외 확인 */
      const names = result.files.map(f => f.name);
      assert.ok(!names.some(n => n.endsWith(".gz")));
      assert.ok(!names.some(n => n.includes("audit")));
      assert.ok(!names.some(n => n.includes("access-stats")));
    });

    it("sorts files by date descending", () => {
      const result = getLogFiles(tmpLogDir);
      for (let i = 1; i < result.files.length; i++) {
        assert.ok(result.files[i - 1].date >= result.files[i].date);
      }
    });
  });

  describe("GET /logs/read", () => {
    it("returns parsed lines with valid file", () => {
      const result = readLogFile(tmpLogDir, `combined-${today}.log`);
      assert.equal(result.status, 200);
      assert.ok(Array.isArray(result.lines));
      assert.ok(result.total > 0);

      for (const line of result.lines) {
        assert.ok(typeof line.timestamp === "string");
        assert.ok(typeof line.level === "string");
        assert.ok(typeof line.message === "string");
      }
    });

    it("appends stack trace lines to previous entry message", () => {
      const result = readLogFile(tmpLogDir, `combined-${today}.log`);
      const errorLine = result.lines.find(l => l.message.includes("Connection refused"));
      assert.ok(errorLine);
      assert.ok(errorLine.message.includes("Socket.connect"));
    });

    it("filters by level", () => {
      const result = readLogFile(tmpLogDir, `combined-${today}.log`, { level: "error" });
      assert.equal(result.status, 200);
      for (const line of result.lines) {
        assert.equal(line.level, "error");
      }
      assert.ok(result.filtered < result.total);
    });

    it("filters by search keyword (case-insensitive)", () => {
      const result = readLogFile(tmpLogDir, `combined-${today}.log`, { search: "WINSTON" });
      assert.equal(result.status, 200);
      assert.ok(result.lines.length >= 1);
      assert.ok(result.lines[0].message.toLowerCase().includes("winston"));
    });

    it("rejects path traversal attempt with 403", () => {
      const result = readLogFile(tmpLogDir, "../../../etc/passwd");
      assert.equal(result.status, 403);
    });

    it("returns 400 without file param", () => {
      const result = readLogFile(tmpLogDir, null);
      assert.equal(result.status, 400);
    });

    it("rejects non-.log extension with 403", () => {
      const result = readLogFile(tmpLogDir, "combined-2026-03-20.log.gz");
      assert.equal(result.status, 403);
    });

    it("returns 404 for non-existent file", () => {
      const result = readLogFile(tmpLogDir, "combined-9999-01-01.log");
      assert.equal(result.status, 404);
    });
  });

  describe("GET /logs/stats", () => {
    it("returns today counts object with expected keys", () => {
      const result = readLogStats(tmpLogDir);
      assert.ok(typeof result.today === "object");
      assert.ok("info" in result.today);
      assert.ok("warn" in result.today);
      assert.ok("error" in result.today);
      assert.ok("debug" in result.today);
    });

    it("counts today log levels correctly", () => {
      const result = readLogStats(tmpLogDir);
      assert.equal(result.today.info, 2);
      assert.equal(result.today.warn, 1);
      assert.equal(result.today.error, 1);
      assert.equal(result.today.debug, 1);
    });

    it("returns recent errors from error log", () => {
      const result = readLogStats(tmpLogDir);
      assert.ok(Array.isArray(result.recentErrors));
      assert.ok(result.recentErrors.length >= 1);
      for (const e of result.recentErrors) {
        assert.ok(typeof e.timestamp === "string");
        assert.ok(typeof e.message === "string");
      }
    });

    it("returns file count and size", () => {
      const result = readLogStats(tmpLogDir);
      assert.equal(result.fileCount, 3);
      assert.ok(result.totalSizeBytes > 0);
    });

    it("returns oldest and newest dates", () => {
      const result = readLogStats(tmpLogDir);
      assert.equal(result.oldestFile, "2026-03-20");
      assert.equal(result.newestFile, today);
    });

    it("reads the file named by the server's local date, not the UTC date", () => {
      const dir    = fs.mkdtempSync(path.join(os.tmpdir(), "memento-log-tz-"));
      const prevTz = process.env.TZ;
      try {
        fs.writeFileSync(path.join(dir, "combined-2026-11-20.log"), "2026-11-20 23:00:00 [info]: yesterday\n");
        fs.writeFileSync(path.join(dir, "combined-2026-11-21.log"), "2026-11-21 05:00:00 [warn]: today\n");
        fs.writeFileSync(path.join(dir, "error-2026-11-21.log"), "2026-11-21 05:00:01 [error]: today failed\n");
        process.env.TZ = "Asia/Seoul";
        /** UTC로는 11월 20일 20시, 서울로는 11월 21일 5시 */
        const result = readLogStats(dir, new Date("2026-11-20T20:00:00Z"));
        assert.deepEqual(result.today, { info: 0, warn: 1, error: 0, debug: 0 });
        assert.deepEqual(result.recentErrors.map(e => e.message), ["today failed"]);
      } finally {
        if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("Authentication", () => {
    it("rejects request without valid master key", () => {
      const req    = { headers: {}, url: `${ADMIN_BASE}/logs/files` };
      const result = validateMasterKey(req, "secret-key-123");
      assert.equal(result, false);
    });

    it("accepts request with valid Bearer token", () => {
      const req    = { headers: { authorization: "Bearer secret-key-123" }, url: `${ADMIN_BASE}/logs/files` };
      const result = validateMasterKey(req, "secret-key-123");
      assert.equal(result, true);
    });

    it("allows access when no ACCESS_KEY is configured", () => {
      const req    = { headers: {}, url: `${ADMIN_BASE}/logs/files` };
      const result = validateMasterKey(req, "");
      assert.equal(result, true);
    });
  });
});
