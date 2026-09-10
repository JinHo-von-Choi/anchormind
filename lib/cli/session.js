/**
 * CLI: session - 세션 조회·정리·교체
 *
 * 서브명령:
 *   list [--limit N] [--workspace X]   활성 세션 목록
 *   show <sessionId>                   특정 세션 상세
 *   delete <sessionId>                 세션 강제 종료
 *   rotate <sessionId> [--reason X]    세션 ID 교체 (Session Fixation 방지)
 *
 * 원격 모드 (--remote URL --key KEY):
 *   Admin HTTP API 직접 호출.
 *   rotate는 POST /session/rotate 엔드포인트를 직접 호출한다.
 *
 * 로컬 모드:
 *   lib/sessions.js의 listAllSessions / validateStreamableSession /
 *   closeStreamableSession / rotateSession 사용.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 */

import { request as nodeHttpRequest }  from "node:http";
import { request as nodeHttpsRequest } from "node:https";
import { resolveFormat, renderTable, renderFieldTable, renderJson, renderCsv } from "./_format.js";

/**
 * Admin HTTP 요청 실행 (GET / DELETE / POST).
 * POST 지원을 위해 body 파라미터를 추가 (JSON 직렬화).
 */
function adminHttpPost(baseUrl, key, path, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u        = new URL(path, baseUrl);
    const protocol = u.protocol;
    const hostname = u.hostname;
    const port     = u.port ? parseInt(u.port, 10) : (protocol === "https:" ? 443 : 80);
    const reqPath  = u.pathname + u.search;
    const fn       = protocol === "https:" ? nodeHttpsRequest : nodeHttpRequest;
    const payload  = JSON.stringify(bodyObj ?? {});

    const req = fn(
      {
        hostname,
        port,
        path    : reqPath,
        method  : "POST",
        headers : {
          "Authorization" : `Bearer ${key}`,
          "Content-Type"  : "application/json",
          "Accept"        : "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data",  (c) => chunks.push(c));
        res.on("end",   ()  => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Admin request timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Admin HTTP 요청 실행 (GET / DELETE).
 *
 * @param {string} baseUrl   - 서버 base URL (예: http://localhost:57332)
 * @param {string} key       - Bearer 토큰
 * @param {string} method    - "GET" | "DELETE"
 * @param {string} path      - /v1/internal/model/nothing/sessions[/:id]
 * @param {number} timeoutMs
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
function adminHttp(baseUrl, key, method, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u        = new URL(path, baseUrl);
    const protocol = u.protocol;
    const hostname = u.hostname;
    const port     = u.port ? parseInt(u.port, 10) : (protocol === "https:" ? 443 : 80);
    const reqPath  = u.pathname + u.search;
    const fn       = protocol === "https:" ? nodeHttpsRequest : nodeHttpRequest;

    const req = fn(
      {
        hostname,
        port,
        path    : reqPath,
        method,
        headers : {
          "Authorization": `Bearer ${key}`,
          "Content-Type" : "application/json",
          "Accept"       : "application/json",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data",  (c) => chunks.push(c));
        res.on("end",   ()  => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Admin request timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end();
  });
}

/** 원격 세션 rotate */
async function remoteRotate(remoteUrl, key, sessionId, reason, timeoutMs) {
  const resp = await adminHttpPost(
    remoteUrl,
    key,
    "/session/rotate",
    { reason },
    timeoutMs
  );

  if (resp.statusCode === 401) throw new Error(`Unauthorized (HTTP 401): ${resp.body.slice(0, 200)}`);
  if (resp.statusCode === 403) throw new Error(`Forbidden (HTTP 403): ${resp.body.slice(0, 200)}`);
  if (resp.statusCode === 404) throw new Error(`Session not found: ${sessionId}`);
  if (resp.statusCode === 429) {
    let parsed = {};
    try { parsed = JSON.parse(resp.body); } catch (_) {}
    const retryAfter = parsed.retryAfter ?? parsed.retry_after ?? "";
    throw new Error(`Rate limit exceeded (HTTP 429)${retryAfter ? ` — retry after ${retryAfter}s` : ""}`);
  }
  if (resp.statusCode !== 200) {
    throw new Error(`POST /session/rotate failed (HTTP ${resp.statusCode}): ${resp.body.slice(0, 200)}`);
  }
  return JSON.parse(resp.body);
}

/** 원격 세션 목록 조회 */
async function remoteList(remoteUrl, key, timeoutMs) {
  const resp = await adminHttp(remoteUrl, key, "GET", "/v1/internal/model/nothing/sessions", timeoutMs);
  if (resp.statusCode !== 200) {
    throw new Error(`Admin GET /sessions failed (HTTP ${resp.statusCode}): ${resp.body.slice(0, 200)}`);
  }
  return JSON.parse(resp.body);
}

/** 원격 세션 상세 조회 */
async function remoteShow(remoteUrl, key, sessionId, timeoutMs) {
  const path = `/v1/internal/model/nothing/sessions/${sessionId}`;
  const resp = await adminHttp(remoteUrl, key, "GET", path, timeoutMs);
  if (resp.statusCode === 404) return null;
  if (resp.statusCode !== 200) {
    throw new Error(`Admin GET /sessions/${sessionId} failed (HTTP ${resp.statusCode}): ${resp.body.slice(0, 200)}`);
  }
  return JSON.parse(resp.body);
}

/** 원격 세션 삭제 */
async function remoteDelete(remoteUrl, key, sessionId, timeoutMs) {
  const path = `/v1/internal/model/nothing/sessions/${sessionId}`;
  const resp = await adminHttp(remoteUrl, key, "DELETE", path, timeoutMs);
  if (resp.statusCode === 404) return { ok: false, reason: "Session not found" };
  if (resp.statusCode !== 200) {
    throw new Error(`Admin DELETE /sessions/${sessionId} failed (HTTP ${resp.statusCode}): ${resp.body.slice(0, 200)}`);
  }
  return JSON.parse(resp.body);
}

/** epoch ms → ISO string. 없으면 "--" */
function fmtTs(ts) {
  if (!ts) return "--";
  return new Date(ts).toISOString();
}

/** 세션 레코드를 표시용 plain 객체로 변환 */
function formatSessionRow(s) {
  return {
    sessionId      : s.sessionId,
    type           : s.type           ?? "--",
    authenticated  : String(s.authenticated ?? false),
    keyId          : s.keyId          ?? "--",
    createdAt      : fmtTs(s.createdAt),
    expiresAt      : fmtTs(s.expiresAt),
    lastAccessedAt : fmtTs(s.lastAccessedAt),
  };
}

const LIST_COLUMNS = ["sessionId", "type", "authenticated", "keyId", "createdAt", "expiresAt", "lastAccessedAt"];

/** list 서브명령 */
async function cmdList(args, remoteUrl, remoteKey, timeoutMs) {
  const limit     = args.limit ? parseInt(args.limit, 10) : undefined;
  const workspace = args.workspace ?? null;
  const fmt       = resolveFormat(args);

  let sessions;

  if (remoteUrl) {
    const data = await remoteList(remoteUrl, remoteKey, timeoutMs);
    sessions   = data.sessions ?? [];
  } else {
    const { listAllSessions } = await import("../sessions.js");
    sessions = listAllSessions();
  }

  if (workspace) {
    sessions = sessions.filter(s => (s.workspace ?? s.defaultWorkspace) === workspace);
  }

  if (limit !== undefined && !isNaN(limit)) {
    sessions = sessions.slice(0, limit);
  }

  const rows = sessions.map(formatSessionRow);

  if (fmt === "json") {
    console.log(renderJson(rows));
    return;
  }

  if (fmt === "csv") {
    console.log(rows.length > 0 ? renderCsv(rows, LIST_COLUMNS) : "(no data)");
    return;
  }

  console.log(rows.length > 0 ? renderTable(rows, LIST_COLUMNS) : "(no active sessions)");
}

/** show 서브명령 */
async function cmdShow(args, remoteUrl, remoteKey, timeoutMs) {
  const sessionId = args._[1];
  if (!sessionId) {
    console.error("Usage: memento-mcp session show <sessionId>");
    process.exit(1);
  }

  const fmt = resolveFormat(args);
  let data;

  if (remoteUrl) {
    data = await remoteShow(remoteUrl, remoteKey, sessionId, timeoutMs);
  } else {
    const { validateStreamableSession } = await import("../sessions.js");
    const result = await validateStreamableSession(sessionId);
    data = result.valid ? result.session : null;
  }

  if (!data) {
    console.error(`Session not found: ${sessionId}`);
    process.exit(1);
  }

  if (fmt === "json") {
    console.log(renderJson(data));
    return;
  }

  const fieldObj = {
    sessionId      : data.sessionId      ?? sessionId,
    type           : data.type           ?? "--",
    authenticated  : String(data.authenticated ?? false),
    keyId          : data.keyId          ?? "--",
    createdAt      : fmtTs(data.createdAt),
    expiresAt      : fmtTs(data.expiresAt),
    lastAccessedAt : fmtTs(data.lastAccessedAt),
    workspace      : data.defaultWorkspace ?? data.workspace ?? "--",
    mode           : data.mode            ?? "--",
  };

  if (fmt === "csv") {
    console.log(renderCsv([fieldObj], Object.keys(fieldObj)));
    return;
  }

  console.log(`Session: ${fieldObj.sessionId}`);
  console.log(renderFieldTable(fieldObj));

  if (Array.isArray(data.searchEvents) && data.searchEvents.length > 0) {
    console.log(`\nRecent search events (${data.searchEvents.length}):`);
    console.log(renderTable(data.searchEvents, ["id", "query_type", "result_count", "latency_ms", "created_at"]));
  }
}

/** delete 서브명령 */
async function cmdDelete(args, remoteUrl, remoteKey, timeoutMs) {
  const sessionId = args._[1];
  if (!sessionId) {
    console.error("Usage: memento-mcp session delete <sessionId>");
    process.exit(1);
  }

  const fmt = resolveFormat(args);
  let result;

  if (remoteUrl) {
    result = await remoteDelete(remoteUrl, remoteKey, sessionId, timeoutMs);
  } else {
    const { closeStreamableSession, streamableSessions, closeLegacySseSession, legacySseSessions } = await import("../sessions.js");

    if (streamableSessions.has(sessionId)) {
      await closeStreamableSession(sessionId);
      result = { ok: true };
    } else if (legacySseSessions.has(sessionId)) {
      await closeLegacySseSession(sessionId);
      result = { ok: true };
    } else {
      result = { ok: false, reason: "Session not found" };
    }
  }

  if (fmt === "json") {
    console.log(renderJson(result));
    return;
  }

  if (result.ok) {
    console.log(`Session ${sessionId} deleted.`);
  } else {
    console.error(`Failed: ${result.reason ?? "unknown error"}`);
    process.exit(1);
  }
}

/** rotate 서브명령 */
async function cmdRotate(args, remoteUrl, remoteKey, timeoutMs) {
  const sessionId = args._[1];
  if (!sessionId) {
    console.error("Usage: memento-mcp session rotate <sessionId> [--reason X]");
    process.exit(1);
  }

  const reason = (typeof args.reason === "string" && args.reason.trim())
    ? args.reason.trim().slice(0, 128)
    : "user_request";

  const fmt = resolveFormat(args);
  let result;

  if (remoteUrl) {
    result = await remoteRotate(remoteUrl, remoteKey, sessionId, reason, timeoutMs);
  } else {
    const { rotateSession } = await import("../sessions.js");
    const raw = await rotateSession(sessionId, { reason, trustedLocal: true });
    result = {
      oldSessionId: raw.oldSessionId,
      newSessionId: raw.newSessionId,
      expiresAt:    raw.expiresAt,
      reason,
    };
  }

  if (fmt === "json") {
    console.log(renderJson(result));
    return;
  }

  const fieldObj = {
    oldSessionId : result.oldSessionId,
    newSessionId : result.newSessionId,
    expiresAt    : fmtTs(result.expiresAt),
    reason       : result.reason ?? reason,
  };

  if (fmt === "csv") {
    console.log(renderCsv([fieldObj], Object.keys(fieldObj)));
    return;
  }

  console.log(`Session rotated: ${fieldObj.oldSessionId} -> ${fieldObj.newSessionId}`);
  console.log(renderFieldTable(fieldObj));
}

export const usage = [
  "Usage: memento-mcp session <subcommand> [options]",
  "",
  "Manage active sessions (headless/CI-friendly).",
  "",
  "Subcommands:",
  "  list                              List active sessions",
  "  show <sessionId>                  Show session detail",
  "  delete <sessionId>                Force-close a session",
  "  rotate <sessionId> [--reason X]   Rotate session ID (session fixation prevention)",
  "",
  "Options:",
  "  --limit N                  Max sessions to return (list only)",
  "  --workspace X              Filter by workspace (list only)",
  "  --reason X                 Rotate reason (rotate only, default: user_request)",
  "  --format table|json|csv    Output format (default: table if TTY, json otherwise)",
  "  --json                     Shorthand for --format json",
  "  --remote <URL>             Admin base URL (예: http://localhost:57332)",
  "  --key <KEY>                Bearer token for admin API (--remote 사용 시 필수)",
  "  --timeout <ms>             Request timeout in ms (default: 30000)",
  "",
  "Examples:",
  "  memento-mcp session list",
  "  memento-mcp session list --limit 20 --format json",
  "  memento-mcp session show abc123-...",
  "  memento-mcp session delete abc123-...",
  "  memento-mcp session rotate abc123-... --reason suspected_leak",
  "  memento-mcp session rotate abc123-... --remote http://localhost:57332 --key mmcp_xxx",
  "  memento-mcp session list --remote http://localhost:57332 --key mmcp_xxx",
].join("\n");

export default async function session(args) {
  const sub = args._[0];

  if (!sub || args.help || args.h) {
    console.log(usage);
    process.exit(0);
  }

  const remoteUrl = args.remote || process.env.MEMENTO_CLI_REMOTE;
  const remoteKey = args.key    || process.env.MEMENTO_CLI_KEY;
  const timeoutMs = args.timeout ? parseInt(args.timeout, 10) : 30_000;

  if (remoteUrl && !remoteKey) {
    console.error("--remote 사용 시 --key <KEY> 또는 MEMENTO_CLI_KEY 환경변수가 필요합니다.");
    process.exit(1);
  }

  switch (sub) {
    case "list":
      await cmdList(args, remoteUrl, remoteKey, timeoutMs);
      break;
    case "show":
      await cmdShow(args, remoteUrl, remoteKey, timeoutMs);
      break;
    case "delete":
      await cmdDelete(args, remoteUrl, remoteKey, timeoutMs);
      break;
    case "rotate":
      await cmdRotate(args, remoteUrl, remoteKey, timeoutMs);
      break;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      console.error('Available: list, show, delete, rotate. Run "memento-mcp session --help" for usage.');
      process.exit(1);
  }
}
