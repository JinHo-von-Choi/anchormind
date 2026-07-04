/**
 * Admin 세션 관리 핸들러
 *
 * 작성자: 최진호
 * 작성일: 2026-03-27
 */

import {
  getSessionCounts,
  closeStreamableSession,
  closeLegacySseSession,
  cleanupExpiredSessions,
  streamableSessions,
  legacySseSessions
} from "../sessions.js";
import { getPrimaryPool }           from "../tools/db.js";
import { SessionActivityTracker }   from "../memory/processors/SessionActivityTracker.js";
import { autoReflect }              from "../memory/processors/AutoReflect.js";
import { logError }                 from "../logger.js";
import { safeErrorMessage, ADMIN_BASE } from "./admin-auth.js";

const SESSION_PREFIX = `${ADMIN_BASE}/sessions`;

/**
 * /sessions/* 핸들러
 * @returns {boolean} 처리 여부
 */
export async function handleSessions(req, res, url) {
  /** POST /sessions/cleanup (cleanup을 UUID 매칭보다 먼저 검사) */
  if (req.method === "POST" && url.pathname === `${SESSION_PREFIX}/cleanup`) {
    try {
      await cleanupExpiredSessions();
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, message: "Cleanup completed" }));
    } catch (err) {
      logError("[Admin] /sessions/cleanup error:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: safeErrorMessage(err) }));
    }
    return true;
  }

  /** POST /sessions/reflect-all (미반영 세션 일괄 reflect) */
  if (req.method === "POST" && url.pathname === `${SESSION_PREFIX}/reflect-all`) {
    try {
      const allUnreflected = await SessionActivityTracker.getUnreflectedSessions(100);
      const activeIds      = new Set([...streamableSessions.keys(), ...legacySseSessions.keys()]);
      const unreflected    = allUnreflected.filter(sid => !activeIds.has(sid));
      let reflected = 0;
      let failed    = 0;
      for (const sid of unreflected) {
        try {
          await autoReflect(sid);
          await SessionActivityTracker.markReflected(sid);
          reflected++;
        } catch {
          failed++;
        }
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, reflected, failed, total: unreflected.length }));
    } catch (err) {
      logError("[Admin] /sessions/reflect-all error:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: safeErrorMessage(err) }));
    }
    return true;
  }

  /** POST /sessions/:id/reflect */
  const reflectMatch = url.pathname.match(
    /^\/v1\/internal\/model\/nothing\/sessions\/([0-9a-f-]{36})\/reflect$/
  );
  if (req.method === "POST" && reflectMatch) {
    try {
      const sessionId = reflectMatch[1];
      await autoReflect(sessionId);
      await SessionActivityTracker.markReflected(sessionId);
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      logError("[Admin] /sessions/:id/reflect error:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: safeErrorMessage(err) }));
    }
    return true;
  }

  /** GET /sessions/:id (세션 상세) */
  const sessionDetailMatch = url.pathname.match(
    /^\/v1\/internal\/model\/nothing\/sessions\/([0-9a-f-]{36})$/
  );
  if (req.method === "GET" && sessionDetailMatch) {
    try {
      const sessionId = sessionDetailMatch[1];
      let session     = streamableSessions.get(sessionId);
      let type        = "streamable";

      if (!session) {
        session = legacySseSessions.get(sessionId);
        type    = "legacy";
      }

      if (!session) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Session not found" }));
        return true;
      }

      const pool = getPrimaryPool();

      const [activity, searchEventsR, toolFeedbackR] = await Promise.all([
        SessionActivityTracker.getActivity(sessionId),
        pool.query(
          `SELECT id, query_type, result_count, latency_ms, created_at
             FROM agent_memory.search_events
            WHERE session_id = $1
            ORDER BY created_at DESC LIMIT 20`,
          [sessionId]
        ),
        pool.query(
          `SELECT tool_name, relevant, sufficient, suggestion, created_at
             FROM agent_memory.tool_feedback
            WHERE session_id = $1
            ORDER BY created_at DESC LIMIT 20`,
          [sessionId]
        )
      ]);

      res.statusCode = 200;
      res.end(JSON.stringify({
        sessionId,
        type,
        authenticated:  session.authenticated ?? false,
        keyId:          session.keyId ?? null,
        createdAt:      session.createdAt ?? null,
        expiresAt:      session.expiresAt ?? null,
        lastAccessedAt: session.lastAccessedAt ?? null,
        activity:       activity ?? null,
        searchEvents:   searchEventsR.rows,
        toolFeedback:   toolFeedbackR.rows
      }));
    } catch (err) {
      logError("[Admin] /sessions/:id error:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: safeErrorMessage(err) }));
    }
    return true;
  }

  /** DELETE /sessions/:id (세션 종료) */
  const sessionDeleteMatch = url.pathname.match(
    /^\/v1\/internal\/model\/nothing\/sessions\/([0-9a-f-]{36})$/
  );
  if (req.method === "DELETE" && sessionDeleteMatch) {
    try {
      const sessionId = sessionDeleteMatch[1];

      if (streamableSessions.has(sessionId)) {
        await closeStreamableSession(sessionId);
      } else if (legacySseSessions.has(sessionId)) {
        await closeLegacySseSession(sessionId);
      }

      await SessionActivityTracker.delete(sessionId);
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      logError("[Admin] DELETE /sessions/:id error:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: safeErrorMessage(err) }));
    }
    return true;
  }

  /** GET /sessions (세션 목록) */
  if (req.method === "GET" && url.pathname === SESSION_PREFIX) {
    try {
      const sessions = [];

      for (const [id, s] of streamableSessions.entries()) {
        sessions.push({
          sessionId:      id,
          type:           "streamable",
          authenticated:  s.authenticated ?? false,
          keyId:          s.keyId ?? null,
          createdAt:      s.createdAt ?? null,
          expiresAt:      s.expiresAt ?? null,
          lastAccessedAt: s.lastAccessedAt ?? null
        });
      }

      for (const [id, s] of legacySseSessions.entries()) {
        sessions.push({
          sessionId:      id,
          type:           "legacy",
          authenticated:  s.authenticated ?? false,
          keyId:          s.keyId ?? null,
          createdAt:      s.createdAt ?? null,
          expiresAt:      s.expiresAt ?? null,
          lastAccessedAt: s.lastAccessedAt ?? null
        });
      }

      /** 각 세션의 활동 로그를 병렬 조회하여 enrichment */
      const activityResults = await Promise.all(
        sessions.map(s => SessionActivityTracker.getActivity(s.sessionId))
      );
      for (let i = 0; i < sessions.length; i++) {
        sessions[i].activity = activityResults[i] ?? null;
      }

      const unreflected  = await SessionActivityTracker.getUnreflectedSessions(1000);
      const activeIds    = new Set(sessions.map(s => s.sessionId));
      const orphanUnreflected = unreflected.filter(sid => !activeIds.has(sid));
      const counts       = getSessionCounts();

      res.statusCode = 200;
      res.end(JSON.stringify({
        sessions,
        counts: {
          streamable:   counts.streamable,
          legacy:       counts.legacy,
          total:        counts.total,
          unreflected:  orphanUnreflected.length
        }
      }));
    } catch (err) {
      logError("[Admin] GET /sessions error:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: safeErrorMessage(err) }));
    }
    return true;
  }

  return false;
}
