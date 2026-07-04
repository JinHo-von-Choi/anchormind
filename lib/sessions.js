/**
 * 세션 관리
 *
 * 작성자: 최진호
 * 작성일: 2026-01-30
 * 수정일: 2026-04-20 (rotateSession 추가 — Phase 1 security-hardening)
 */

import crypto            from "crypto";
import { SESSION_TTL_MS, REDIS_ENABLED, CACHE_SESSION_TTL, SSE_HEARTBEAT_INTERVAL_MS, SSE_MAX_HEARTBEAT_FAILURES, IDLE_REFLECT_HOURS } from "./config.js";
import {
  saveSession as saveSessionToRedis,
  getSession as getSessionFromRedis,
  deleteSession as deleteSessionFromRedis
} from "./redis.js";
import { autoReflect } from "./memory/processors/AutoReflect.js";
import { logInfo } from "./logger.js";
import { recordSessionIdleReflect } from "./metrics.js";

/** Streamable HTTP 세션 저장소 */
export const streamableSessions = new Map();

/** Legacy SSE 세션 저장소 */
export const legacySseSessions  = new Map();

/**
 * Streamable HTTP 세션 생성 (지정 sessionId로)
 *
 * @param {string}      sessionId         사용할 세션 ID
 * @param {boolean}     authenticated
 * @param {string|null} keyId             DB API 키 ID (마스터 키 세션은 null)
 * @param {string[]|null} groupKeyIds
 * @param {string[]|null} permissions
 * @param {string|null} defaultWorkspace
 */
export async function createStreamableSessionWithId(sessionId, authenticated = false, keyId = null, groupKeyIds = null, permissions = null, defaultWorkspace = null, mode = null) {
  let sseResponse         = null;
  let heartbeat           = null;
  const now                 = Date.now();

  const sessionData       = {
    sessionId,
    authenticated,
    keyId              : keyId ?? null,
    groupKeyIds        : groupKeyIds ?? null,
    permissions        : permissions ?? null,
    defaultWorkspace   : defaultWorkspace ?? null,
    mode               : mode ?? null,
    createdAt          : now,
    expiresAt          : now + SESSION_TTL_MS,
    lastAccessedAt     : now,
    lastReflectedAt    : null,
    negotiatedVersion  : null
  };

  const session = {
    ...sessionData,
    getSseResponse  : () => sseResponse,
    setSseResponse  : (res) => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }

      sseResponse         = res;

      if (res) {
        let hbFailures    = 0;
        let gracePeriod   = false;

        try {
          if (typeof res.flushHeaders === "function") {
            res.flushHeaders();
          }
          res.write(": connected\n\n");
        } catch {
          // noop
        }

        heartbeat         = setInterval(() => {
          try {
            const ok      = res.write(": ping\n\n");
            if (ok) {
              hbFailures  = 0;
              gracePeriod = false;
            } else {
              hbFailures++;
            }
          } catch {
            hbFailures++;
          }

          if (hbFailures > 0 && hbFailures <= 3) {
            if (!gracePeriod) {
              gracePeriod = true;
            }
          }

          if (hbFailures >= SSE_MAX_HEARTBEAT_FAILURES) {
            clearInterval(heartbeat);
            heartbeat     = null;
            closeStreamableSession(sessionId).catch(() => {});
          }
        }, SSE_HEARTBEAT_INTERVAL_MS);
        /**
         * interval이 event loop을 혼자 붙잡지 않도록 unref.
         * 실제 SSE 세션에서는 res 소켓이 active handle로 process를 유지하므로
         * heartbeat unref는 프로덕션 동작에 영향 없다. 테스트에서는 res가
         * 즉시 close되면 이 interval이 유일한 ref가 되어 event loop hang을
         * 유발한다.
         */
        heartbeat.unref?.();
      }
    },
    close: async ({ preserveRedis = false } = {}) => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat         = null;
      }

      if (sseResponse) {
        try {
          sseResponse.end();
        } catch {
          // noop
        }
        sseResponse       = null;
      }

      streamableSessions.delete(sessionId);

      if (REDIS_ENABLED && !preserveRedis) {
        await deleteSessionFromRedis(sessionId);
      }
    }
  };

  streamableSessions.set(sessionId, session);

  if (REDIS_ENABLED) {
    await saveSessionToRedis(sessionId, sessionData, CACHE_SESSION_TTL);
  }

  return sessionId;
}

/**
 * Streamable HTTP 세션 생성
 *
 * @param {boolean} authenticated
 * @param {string|null} keyId  DB API 키 ID (마스터 키 세션은 null)
 */
export async function createStreamableSession(authenticated = false, keyId = null, groupKeyIds = null, permissions = null, defaultWorkspace = null, mode = null) {
  const sessionId           = crypto.randomUUID();
  return createStreamableSessionWithId(sessionId, authenticated, keyId, groupKeyIds, permissions, defaultWorkspace, mode);
}

/**
 * Streamable HTTP 세션 검증 (TTL 체크)
 */
export async function validateStreamableSession(sessionId) {
  let session             = streamableSessions.get(sessionId);

  // 메모리에 없으면 Redis에서 조회 시도
  if (!session && REDIS_ENABLED) {
    const redisSession    = await getSessionFromRedis(sessionId);

    if (redisSession) {
      /**
       * Redis 복원 세션: 인증 상태(keyId, authenticated)만 복원.
       * SSE 연결은 TCP 소켓 기반이므로 프로세스 경계를 넘어 복구 불가.
       * POST /mcp (JSON-RPC)는 정상 처리, GET /mcp (SSE 스트림)은 재연결 필요.
       */
      const now           = Date.now();
      session             = {
        lastReflectedAt   : null,
        ...redisSession,
        lastAccessedAt    : now,
        expiresAt         : now + SESSION_TTL_MS,
        _restoredFromRedis: true,
        getSseResponse    : () => null,
        setSseResponse    : () => {},
        close             : async ({ preserveRedis = false } = {}) => {
          streamableSessions.delete(sessionId);
          if (REDIS_ENABLED && !preserveRedis) {
            await deleteSessionFromRedis(sessionId);
          }
        }
      };

      streamableSessions.set(sessionId, session);

      // Redis 복원 직후 TTL 갱신 (슬라이딩 윈도우 연장)
      const persistableRestore = { ...redisSession, lastAccessedAt: now, expiresAt: now + SESSION_TTL_MS };
      delete persistableRestore.getSseResponse;
      delete persistableRestore.setSseResponse;
      delete persistableRestore.close;
      delete persistableRestore._restoredFromRedis;
      const remainingTtlSec = Math.ceil(SESSION_TTL_MS / 1000);
      await saveSessionToRedis(sessionId, persistableRestore, remainingTtlSec);
    }
  }

  if (!session) {
    return { valid: false, reason: "Session not found" };
  }

  const now                 = Date.now();

  if (now > session.expiresAt) {
    await closeStreamableSession(sessionId);
    return { valid: false, reason: "Session expired" };
  }

  session.lastAccessedAt  = now;
  session.expiresAt       = now + SESSION_TTL_MS;

  // Redis에 갱신된 expiresAt/lastAccessedAt 저장 (TTL 연장 + JSON 값 동기화)
  if (REDIS_ENABLED) {
    const persistableData = { ...session };
    delete persistableData.getSseResponse;
    delete persistableData.setSseResponse;
    delete persistableData.close;
    delete persistableData._restoredFromRedis;
    const remainingTtlSec = Math.ceil((session.expiresAt - Date.now()) / 1000);
    await saveSessionToRedis(sessionId, persistableData, Math.max(remainingTtlSec, 60));
  }

  return { valid: true, session };
}

/**
 * Streamable HTTP 세션 종료
 *
 * @param {string} sessionId
 * @param {{ preserveRedis?: boolean }} [opts]
 *   preserveRedis: true 시 Redis 세션을 삭제하지 않음 (graceful shutdown 전용).
 *                  TTL 기반 자연 만료에 의존하여 재시작 후 세션 복원 가능.
 */
export async function closeStreamableSession(sessionId, { preserveRedis = false } = {}) {
  const session             = streamableSessions.get(sessionId);

  if (!session) return;

  /** 세션 종료 전 자동 reflect (비차단: 실패해도 세션은 닫힘) */
  try { await autoReflect(sessionId); } catch { /* noop */ }

  await session.close({ preserveRedis });
}

/**
 * Legacy SSE 세션 생성
 */
export function createLegacySseSession(res) {
  const sessionId           = crypto.randomUUID();
  const now                 = Date.now();
  let hbFailures            = 0;
  const heartbeat           = setInterval(() => {
    try {
      const ok              = res.write(": ping\n\n");
      if (ok) {
        hbFailures          = 0;
      } else {
        hbFailures++;
      }
    } catch {
      hbFailures++;
    }
    if (hbFailures >= SSE_MAX_HEARTBEAT_FAILURES) {
      closeLegacySseSession(sessionId);
    }
  }, SSE_HEARTBEAT_INTERVAL_MS);
  /** 테스트 cleanup 호환 — res 소켓이 active handle이므로 unref 해도 프로덕션 무영향. */
  heartbeat.unref?.();

  legacySseSessions.set(sessionId, {
    res,
    heartbeat,
    authenticated : false,
    createdAt     : now,
    expiresAt     : now + SESSION_TTL_MS,
    lastAccessedAt: now
  });
  return sessionId;
}

/**
 * Legacy SSE 세션 검증 (TTL 체크)
 */
export function validateLegacySseSession(sessionId) {
  const session             = legacySseSessions.get(sessionId);

  if (!session) {
    return { valid: false, reason: "Session not found" };
  }

  const now                 = Date.now();

  if (now > session.expiresAt) {
    closeLegacySseSession(sessionId);
    return { valid: false, reason: "Session expired" };
  }

  session.lastAccessedAt  = now;
  session.expiresAt       = now + SESSION_TTL_MS;
  return { valid: true, session };
}

/**
 * Legacy SSE 세션 정리
 *
 * @param {string} sessionId
 * @param {{ preserveRedis?: boolean }} [opts]
 *   preserveRedis: 미래 호환용 — Legacy SSE는 현재 Redis 백업이 없으므로 동작 무영향.
 */
export async function closeLegacySseSession(sessionId, { preserveRedis = false } = {}) {
  const session             = legacySseSessions.get(sessionId);

  if (!session) {
    return;
  }

  /** 세션 종료 전 자동 reflect */
  try { await autoReflect(sessionId); } catch { /* noop */ }

  clearInterval(session.heartbeat);
  legacySseSessions.delete(sessionId);

  try {
    session.res.end();
  } catch {
    // noop
  }
}

/**
 * 세션 교체 (Session Rotation)
 *
 * 기존 세션을 원자적으로 종료하고 동일한 인증 컨텍스트를 이어받은
 * 신규 세션을 발급한다. 세션 고정 공격(Session Fixation) 방지에 사용된다.
 *
 * 원자성 보장 전략:
 * - 신규 세션을 먼저 생성(createStreamableSessionWithId)하여 등록한다.
 * - 기존 세션 close 시 preserveRedis=false 로 Redis를 즉시 삭제한다.
 * - 신규 세션 생성 후 기존 세션 close 중 예외가 발생해도 신규 세션이 활성
 *   상태이므로 클라이언트는 newSessionId로 계속 작업할 수 있다.
 * - 기존 세션이 존재하지 않거나 만료됐으면 즉시 에러를 반환해 고아 세션 방지.
 *
 * @param {string} oldSessionId
 * @param {{ reason?: string }} [opts]
 * @returns {Promise<{ oldSessionId: string, newSessionId: string, expiresAt: number, keyId: string|null, workspace: string|null }>}
 */
export async function rotateSession(oldSessionId, { reason = "explicit_rotate" } = {}) {
  /** 기존 세션 존재 및 유효성 확인 (validateStreamableSession은 TTL 갱신 부작용이 있으므로 직접 조회) */
  let existing = streamableSessions.get(oldSessionId);

  if (!existing && REDIS_ENABLED) {
    const redisSession = await getSessionFromRedis(oldSessionId);
    if (redisSession) {
      existing = redisSession;
    }
  }

  if (!existing) {
    const err       = new Error("Session not found");
    err.statusCode  = 404;
    throw err;
  }

  const now = Date.now();
  if (now > existing.expiresAt) {
    /** 만료된 세션 — 정리 후 에러 반환 */
    await closeStreamableSession(oldSessionId).catch(() => {});
    const err       = new Error("Session expired");
    err.statusCode  = 401;
    throw err;
  }

  /** 이관할 컨텍스트 스냅샷 (close 전에 캡처) */
  const keyId            = existing.keyId            ?? null;
  const groupKeyIds      = existing.groupKeyIds      ?? null;
  const permissions      = existing.permissions      ?? null;
  const defaultWorkspace = existing.defaultWorkspace ?? null;
  const mode             = existing.mode             ?? null;
  const authenticated    = existing.authenticated    ?? false;

  /** 신규 세션 발급 (동일 컨텍스트 이관) */
  const newSessionId = crypto.randomUUID();
  await createStreamableSessionWithId(
    newSessionId,
    authenticated,
    keyId,
    groupKeyIds,
    permissions,
    defaultWorkspace,
    mode
  );

  /** 기존 세션 종료 — 신규 세션 등록 완료 후 진행 (부분 실패 시 신규 세션은 유효) */
  try {
    /** autoReflect를 건너뛰고 직접 close: rotate는 세션 전환이므로 reflect 불필요 */
    const oldSession = streamableSessions.get(oldSessionId);
    if (oldSession) {
      await oldSession.close({ preserveRedis: false });
    } else if (REDIS_ENABLED) {
      await deleteSessionFromRedis(oldSessionId);
    }
  } catch {
    /** 기존 세션 정리 실패는 무시 — 신규 세션이 이미 유효하므로 진행 */
  }

  const newSession = streamableSessions.get(newSessionId);
  const expiresAt  = newSession ? newSession.expiresAt : now + SESSION_TTL_MS;

  logInfo(`[Session] Rotated: ${oldSessionId.slice(0, 8)}... → ${newSessionId.slice(0, 8)}... reason=${reason}`);

  return { oldSessionId, newSessionId, expiresAt, keyId, workspace: defaultWorkspace };
}

/**
 * 세션 수 조회 (health/stats용)
 *
 * @returns {{ streamable: number, legacy: number, total: number }}
 */
export function getSessionCounts() {
  return {
    streamable : streamableSessions.size,
    legacy     : legacySseSessions.size,
    total      : streamableSessions.size + legacySseSessions.size
  };
}

/**
 * 모든 활성 세션의 직렬화 가능한 메타데이터 반환
 * SSE response 객체 등 비직렬화 필드는 제외
 */
export function listAllSessions() {
  const result = [];
  for (const [id, s] of streamableSessions.entries()) {
    result.push({
      sessionId:      id,
      type:           "streamable",
      authenticated:  s.authenticated ?? false,
      keyId:          s.keyId ?? null,
      createdAt:      s.createdAt,
      expiresAt:      s.expiresAt,
      lastAccessedAt: s.lastAccessedAt
    });
  }
  for (const [id, s] of legacySseSessions.entries()) {
    result.push({
      sessionId:      id,
      type:           "legacy",
      authenticated:  s.authenticated ?? false,
      keyId:          null,
      createdAt:      s.createdAt,
      expiresAt:      s.expiresAt,
      lastAccessedAt: s.lastAccessedAt
    });
  }
  return result;
}

/**
 * Legacy SSE 세션 조회
 *
 * @param {string} sessionId
 * @returns {Object|undefined}
 */
export function getLegacySession(sessionId) {
  return legacySseSessions.get(sessionId);
}

/**
 * 모든 세션 ID 배열 반환 (graceful shutdown용)
 *
 * @returns {{ streamableIds: string[], legacyIds: string[] }}
 */
export function getAllSessionIds() {
  return {
    streamableIds : [...streamableSessions.keys()],
    legacyIds     : [...legacySseSessions.keys()]
  };
}

/**
 * 만료된 세션 정리 (주기적 실행)
 *
 * 만료 체크 전, IDLE_REFLECT_HOURS 이상 비활성 상태인 세션에 대해
 * 중간 autoReflect를 실행하여 기억 손실을 방지한다.
 */
export async function cleanupExpiredSessions() {
  const now                   = Date.now();
  const idleThresholdMs       = IDLE_REFLECT_HOURS * 3600 * 1000;
  let streamableExpired     = 0;
  let legacyExpired         = 0;

  for (const [sessionId, session] of streamableSessions.entries()) {
    if (now > session.expiresAt) {
      const ageMin  = Math.round((now - session.createdAt) / 60000);
      const idleMin = Math.round((now - (session.lastAccessedAt || session.createdAt)) / 60000);
      logInfo(`[Session] Expired: ${sessionId.slice(0, 8)}... age=${ageMin}min idle=${idleMin}min`);
      await closeStreamableSession(sessionId);
      streamableExpired++;
    } else {
      const lastAccess    = session.lastAccessedAt || session.createdAt;
      const lastReflected = session.lastReflectedAt;
      const isIdleEnough  = (now - lastAccess) > idleThresholdMs;
      const needsReflect  = !lastReflected || (now - lastReflected) > idleThresholdMs;

      if (isIdleEnough && needsReflect) {
        try {
          await autoReflect(sessionId);
          session.lastReflectedAt = now;
          recordSessionIdleReflect();
          const idleH = (now - lastAccess) / 3600000;
          logInfo(`[Session] Idle reflect executed: ${sessionId.slice(0, 8)}... idle=${idleH.toFixed(1)}h`);
        } catch {
          // 실패해도 루프 계속
        }
      }
    }
  }

  for (const [sessionId, session] of legacySseSessions.entries()) {
    if (now > session.expiresAt) {
      const ageMin  = Math.round((now - session.createdAt) / 60000);
      const idleMin = Math.round((now - (session.lastAccessedAt || session.createdAt)) / 60000);
      logInfo(`[Session] Expired: ${sessionId.slice(0, 8)}... age=${ageMin}min idle=${idleMin}min`);
      await closeLegacySseSession(sessionId);
      legacyExpired++;
    }
  }

  if (streamableExpired > 0 || legacyExpired > 0) {
    logInfo(`[Session Cleanup] Expired sessions removed - Streamable: ${streamableExpired}, Legacy: ${legacyExpired}`);
  }
}
