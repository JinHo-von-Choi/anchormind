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
import { sessionRef }        from "./session-ref.js";

function auditField(value) {
  return value == null ? "" : String(value).replace(/[\r\n|;]/g, " ");
}

/**
 * 경로 문자열에서 UUID 형태 구간(세션 ID 포함)을 앞 8자로 줄인다.
 *
 * @param {string} pathname
 * @returns {string}
 */
export function maskAuditPath(pathname) {
  return String(pathname)
    .split("/")
    .map((segment) => (/^[0-9a-f-]{36}$/i.test(segment) ? segment.slice(0, 8) : segment))
    .join("/");
}

/**
 * 서버가 확인한 세션 문맥에서 감사 행위자를 만든다.
 *
 * @param {{ isMaster?: boolean, keyId?: string|null, sessionId?: string|null, clientIp?: string|null }} sessionData
 * @returns {Readonly<{ keyId: string, sessionId: string|null, clientIp: string }>}
 */
export function buildAuditActor(sessionData) {
  return Object.freeze({
    keyId    : sessionData.isMaster === true ? "master" : (sessionData.keyId ?? "none"),
    sessionId: sessionData.sessionId ?? null,
    clientIp : sessionData.clientIp ?? "unknown"
  });
}

/**
 * 감사 로그 기록 (기억 도구 상태 변경 작업 추적)
 * 형식: timestamp | operation | topic | type | fragmentId | success | details
 * details 열 끝에 행위자(key=, sid= 앞 8자, ip=)를 덧붙인다.
 *
 * @param {string} operation
 * @param {{ topic?, type?, fragmentId?, success?, details?, agentScope?, includePeerAgents?,
 *           actor?: { keyId?: string|null, sessionId?: string|null, clientIp?: string|null } }} [fields]
 */
export async function logAudit(operation, {
  topic, type, fragmentId, success, details, agentScope, includePeerAgents, actor
} = {}) {
  const timestamp          = new Date().toISOString();
  const logEntry           = `${[
    timestamp,
    auditField(operation),
    auditField(topic)      || "-",
    auditField(type)       || "-",
    auditField(fragmentId) || "-",
    success    === false ? "FAIL" : "OK",
    [
      auditField(details),
      agentScope ? `agent_scope=${auditField(agentScope)}` : "",
      includePeerAgents !== undefined ? `peer=${includePeerAgents === true}` : "",
      actor?.keyId     ? `key=${auditField(actor.keyId)}` : "",
      actor?.sessionId ? `sid=${auditField(String(actor.sessionId).slice(0, 8))}` : "",
      actor?.clientIp  ? `ip=${auditField(actor.clientIp)}` : ""
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
 * 액세스 로그 기록. 세션 ID는 앞 8자만 남긴다.
 */
export async function logAccess(method, reqPath, sessionId, statusCode, responseTime) {
  const timestamp          = new Date().toISOString();
  const logEntry           = `${timestamp} | ${method} | ${reqPath} | ${sessionId ? sessionRef(sessionId) : "N/A"} | ${statusCode} | ${responseTime}ms\n`;

  try {
    await fsp.mkdir(LOG_DIR, { recursive: true });
    const logFile          = path.join(LOG_DIR, `access-${new Date().toISOString().split("T")[0]}.log`);
    await fsp.appendFile(logFile, logEntry);
  } catch (err) {
    logError("[Log] Failed to write access log:", err);
  }
}
