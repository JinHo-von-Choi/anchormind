/**
 * 세션 감사 로그
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * NDJSON 형식으로 세션 이벤트를 session-audit.log에 기록한다.
 * sessionId 원문은 절대 저장하지 않고 sha256 앞 16자 해시만 기록한다.
 */

import crypto            from "node:crypto";
import { promises as fsp } from "node:fs";
import path              from "node:path";
import { LOG_DIR }       from "./config.js";
import { logError }      from "./logger.js";

const AUDIT_LOG_NAME = "session-audit.log";

/**
 * sessionId → sha256 앞 16자 해시
 *
 * @param {string} sessionId
 * @returns {string} "sha256:<hex16>"
 */
function hashSessionId(sessionId) {
  const hex = crypto.createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 16);
  return `sha256:${hex}`;
}

/**
 * 세션 회전 이벤트 감사 로그 기록
 *
 * @param {{ keyId: string|null, oldSessionId: string, newSessionId: string, reason: string, clientIp?: string, userAgent?: string }} params
 */
export async function logSessionRotate({ keyId, oldSessionId, newSessionId, reason, clientIp, userAgent }) {
  const entry = JSON.stringify({
    event      : "session.rotate",
    ts         : new Date().toISOString(),
    keyId      : keyId ?? "master",
    oldSidHash : hashSessionId(oldSessionId),
    newSidHash : hashSessionId(newSessionId),
    reason     : String(reason || "unspecified").slice(0, 256),
    clientIp   : clientIp   || "unknown",
    userAgent  : userAgent  || "unknown"
  }) + "\n";

  try {
    await fsp.mkdir(LOG_DIR, { recursive: true });
    const logFile = path.join(LOG_DIR, AUDIT_LOG_NAME);
    await fsp.appendFile(logFile, entry);
  } catch (err) {
    /** 파일 append 실패 시 stdout 폴백 — 로그 실패가 rotate 자체를 막지 않음 */
    try {
      process.stdout.write(`[SessionAudit] ${entry}`);
    // iron-laws: ignore[IL-301] 감사 로그 기록 실패를 logError로 남긴다
    } catch {
      logError("[SessionAudit] Failed to write session audit log:", err);
    }
  }
}
