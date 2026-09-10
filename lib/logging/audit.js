/**
 * 감사 로그 (audit / access)
 *
 * 작성자: 최진호
 * 작성일: 2026-03-09
 */

import { promises as fsp } from "fs";
import path                 from "path";
import { LOG_DIR }          from "../config.js";
import { logError }         from "../logger.js";

function auditField(value) {
  return value == null ? "" : String(value).replace(/[\r\n|;]/g, " ");
}

/**
 * 감사 로그 기록 (기억 도구 상태 변경 작업 추적)
 * 형식: timestamp | operation | topic | type | fragmentId | success | details
 */
export async function logAudit(operation, {
  topic, type, fragmentId, success, details, agentScope, includePeerAgents
} = {}) {
  const timestamp          = new Date().toISOString();
  const logEntry           = `${[
    timestamp,
    operation,
    auditField(topic)      || "-",
    auditField(type)       || "-",
    auditField(fragmentId) || "-",
    success    === false ? "FAIL" : "OK",
    [
      auditField(details),
      agentScope ? `agent_scope=${auditField(agentScope)}` : "",
      includePeerAgents !== undefined ? `peer=${includePeerAgents === true}` : ""
    ].filter(Boolean).join("; ")
  ].join(" | ")  }\n`;

  try {
    await fsp.mkdir(LOG_DIR, { recursive: true });
    const logFile          = path.join(LOG_DIR, `audit-${new Date().toISOString().split("T")[0]}.log`);
    await fsp.appendFile(logFile, logEntry);
  } catch (err) {
    logError("[Audit] Failed to write audit log:", err);
  }
}

/**
 * 액세스 로그 기록
 */
export async function logAccess(method, reqPath, sessionId, statusCode, responseTime) {
  const timestamp          = new Date().toISOString();
  const logEntry           = `${timestamp} | ${method} | ${reqPath} | ${sessionId || "N/A"} | ${statusCode} | ${responseTime}ms\n`;

  try {
    await fsp.mkdir(LOG_DIR, { recursive: true });
    const logFile          = path.join(LOG_DIR, `access-${new Date().toISOString().split("T")[0]}.log`);
    await fsp.appendFile(logFile, logEntry);
  } catch (err) {
    logError("[Log] Failed to write access log:", err);
  }
}
