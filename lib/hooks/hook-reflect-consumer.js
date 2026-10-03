/**
 * 훅 회고 outbox 소비자
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * topic hook.reflect 이벤트(훅 처리기가 Stop, SessionEnd 요청마다 기록)를 받아 reflect를 수행한다.
 *
 * 처리 순서
 *   1. payload 검사. 형식이 맞지 않으면 OutboxPermanentError(재시도 없이 dead-letter).
 *   2. 키 재확인. 기록 뒤 비활성화되었거나 write 권한이 없어진 키는 OutboxPermanentError. 키 저장소 장애는 재시도.
 *   3. 멱등 키(aggregateId = 키 + 클라이언트 + 세션 + 이벤트) 선점. 이미 완료된 키는 수행하지 않고 끝낸다
 *      (같은 세션과 이벤트의 두 번째 요청, 같은 이벤트의 재전달). 다른 전달이 선점 중이면 재시도.
 *   4. payload의 요약 후보로 episode 서사를 만들어 reflect를 부른다. 실패하면 선점을 풀고 재시도한다.
 *   5. 선점을 완료로 바꾼다. 완료 기록에는 건수만 남긴다.
 *
 * reflect와 완료 기록은 한 트랜잭션이 아니다. reflect가 끝난 뒤 완료 기록 전에 프로세스가 끝나면 선점이 남고,
 * 선점 뒤 5분(HOOK_CLAIM_STALE_MS)이 지나면 다음 전달이 선점을 넘겨받아 reflect를 다시 수행한다. 같은 서사는
 * 같은 키와 workspace에서 content_hash로 접혀 episode가 한 번 더 생기지 않는다. 처리기 시간 초과(15초)로
 * 재시도가 겹치는 경우에도 선점이 유효한 5분 안에서는 다음 전달이 busy로 물러선다.
 *
 * 작업자를 돌리는 모든 프로세스가 이 처리기를 등록한다(lib/scheduler.js). MEMENTO_HOOK_ENDPOINTS=off여도
 * 등록하므로 이미 기록된 이벤트는 처리된다.
 */

import crypto from "node:crypto";

import { registerOutboxHandler, OutboxPermanentError } from "../outbox/OutboxHandlers.js";
import { checkPermission }                             from "../rbac.js";
import { logInfo, logWarn }                            from "../logger.js";
import {
  HOOK_CLIENTS, HOOK_LIMITS, HOOK_REFLECT_TOPIC, HOOK_PAYLOAD_VERSION, HOOK_REFLECT_IDEMPOTENCY_TOOL, isReflectEvent
} from "./hook-contract.js";
import { clipText }                                    from "./hook-excerpt.js";
import { recordHookReflect }                           from "./hook-metrics.js";

export { HOOK_REFLECT_IDEMPOTENCY_TOOL };

/** 선점 유효 시간. 처리기 상한(15초)과 임대(60초)보다 충분히 길게 둔다. */
export const HOOK_CLAIM_STALE_MS = 300_000;

/** 완료 기록 보존 일수. 이 기간 안의 같은 세션과 이벤트는 다시 회고하지 않는다. */
export const HOOK_CLAIM_TTL_DAYS = 30;

/** episode 서사의 최대 문자 수(episode 저장 절삭 1000자 안) */
const NARRATIVE_MAX_CHARS = 1000;

/** 클라이언트 표시 이름 */
const CLIENT_LABEL = Object.freeze({ "claude-code": "Claude Code", "codex": "Codex" });

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * payload를 검사한다. 맞지 않으면 OutboxPermanentError.
 *
 * @param {unknown} payload
 * @returns {{ client: string, event: string, sessionId: string, keyId: string|null, workspace: string|null, summary: string }}
 */
export function validateHookReflectPayload(payload) {
  const p     = payload && typeof payload === "object" ? payload : {};
  const fault = (field) => new OutboxPermanentError(`hook.reflect payload field invalid: ${field}`);

  if (p.v !== HOOK_PAYLOAD_VERSION)                     throw fault("v");
  if (!HOOK_CLIENTS.includes(p.client))                 throw fault("client");
  if (!isReflectEvent(p.event))                         throw fault("event");
  if (typeof p.sessionId !== "string" || p.sessionId.length > HOOK_LIMITS.sessionIdMaxLength
      || !SESSION_ID_PATTERN.test(p.sessionId))          throw fault("sessionId");
  if (p.keyId !== null && typeof p.keyId !== "string")  throw fault("keyId");
  if (p.workspace !== null && typeof p.workspace !== "string") throw fault("workspace");
  if (typeof p.summary !== "string" || p.summary.trim() === ""
      || [...p.summary].length > HOOK_LIMITS.summaryMaxChars)  throw fault("summary");

  return { client: p.client, event: p.event, sessionId: p.sessionId, keyId: p.keyId, workspace: p.workspace, summary: p.summary };
}

/**
 * reflect 인자를 만든다. 서사는 payload의 요약 후보(처리기가 민감 정보를 가린 마지막 응답 블록, 1000자 이하)를
 * 공백을 접어 자른 값이고, 앞에 클라이언트와 이벤트를 붙인다. 요약 배열은 비워 episode 하나만 남긴다.
 *
 * @param {ReturnType<typeof validateHookReflectPayload>} payload
 * @param {{ keyId: string|null, groupKeyIds?: string[]|null, defaultWorkspace?: string|null }} key 재확인한 키
 * @returns {object}
 */
export function buildHookReflectArgs(payload, key) {
  const head      = `${CLIENT_LABEL[payload.client]} ${payload.event} 세션 기록: `;
  const narrative = head + clipText(payload.summary, NARRATIVE_MAX_CHARS - head.length);
  return {
    sessionId        : `${payload.client}:${payload.sessionId}`,
    agentId          : "default",
    narrative_summary: narrative,
    ...(payload.workspace ? { workspace: payload.workspace } : {}),
    _keyId           : key.keyId ?? null,
    _groupKeyIds     : key.groupKeyIds ?? null,
    _defaultWorkspace: key.defaultWorkspace ?? null
  };
}

/**
 * 키를 재확인한다. 마스터(keyId null)는 확인하지 않는다.
 *
 * @param {Function} validateKey validateApiKeyById
 * @param {string|null} keyId
 * @returns {Promise<{ keyId: string|null, groupKeyIds: string[]|null, defaultWorkspace: string|null }>}
 */
async function confirmKey(validateKey, keyId) {
  if (keyId === null) return { keyId: null, groupKeyIds: null, defaultWorkspace: null };
  const key = await validateKey(keyId);
  if (!key.valid && key.reason === "store_unavailable") throw new Error("api key store unavailable");
  if (!key.valid) throw new OutboxPermanentError("hook.reflect key is no longer active");
  if (!checkPermission(key.permissions, "reflect", false).allowed) {
    throw new OutboxPermanentError("hook.reflect key lacks write permission");
  }
  return { keyId: key.keyId, groupKeyIds: key.groupKeyIds ?? null, defaultWorkspace: key.defaultWorkspace ?? null };
}

/**
 * 기본 의존성. 무거운 모듈은 처음 쓸 때 불러온다.
 */
const DEFAULT_DEPS = Object.freeze({
  validateKey: async (keyId) => (await import("../admin/ApiKeyStore.js")).validateApiKeyById(keyId),
  claim      : async (args) => (await import("../memory/write/IdempotencyStore.js")).claimIdempotencyKey(args),
  complete   : async (args) => (await import("../memory/write/IdempotencyStore.js")).completeIdempotencyClaim(args),
  release    : async (args) => (await import("../memory/write/IdempotencyStore.js")).releaseIdempotencyClaim(args),
  reflect    : async (params) => {
    const [{ MemoryManager }, { WRITE_ENTRIES }] = await Promise.all([
      import("../memory/MemoryManager.js"), import("../memory/write/WriteGate.js")
    ]);
    return MemoryManager.getInstance().reflect(params, { writeEntry: WRITE_ENTRIES.REFLECT });
  },
  token      : () => crypto.randomUUID()
});

/**
 * 처리기를 만든다.
 *
 * @param {Partial<typeof DEFAULT_DEPS>} [overrides]
 * @returns {(event: object, ctx: { signal: AbortSignal }) => Promise<void>}
 */
export function createHookReflectHandler(overrides = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };

  return async function hookReflectHandler(event, { signal } = {}) {
    let payload;
    let key;
    try {
      payload = validateHookReflectPayload(event.payload);
      key     = await confirmKey(deps.validateKey, payload.keyId);
    } catch (err) {
      if (err instanceof OutboxPermanentError) recordHookReflect("rejected");
      throw err;
    }

    if (typeof event.aggregateId !== "string" || !event.aggregateId.startsWith("hook:")) {
      recordHookReflect("rejected");
      throw new OutboxPermanentError("hook.reflect aggregateId missing");
    }
    const claimArgs = {
      tool          : HOOK_REFLECT_IDEMPOTENCY_TOOL,
      idempotencyKey: event.aggregateId,
      keyId         : payload.keyId,
      token         : deps.token()
    };

    const claim = await deps.claim({ ...claimArgs, staleAfterMs: HOOK_CLAIM_STALE_MS, ttlDays: HOOK_CLAIM_TTL_DAYS });
    if (claim === "done") {
      recordHookReflect("duplicate");
      return;
    }
    if (claim !== "claimed") {
      recordHookReflect("busy");
      throw new Error("hook.reflect idempotency key is held by another delivery");
    }

    let result;
    try {
      if (signal?.aborted) throw new Error("hook.reflect aborted before reflect");
      result = await deps.reflect(buildHookReflectArgs(payload, key));
    } catch (err) {
      recordHookReflect("failed");
      await deps.release(claimArgs).catch((releaseErr) =>
        logWarn(`[HookReflect] claim release failed id=${event.id}: ${releaseErr.message}`));
      throw err;
    }

    const count   = (Number.isInteger(result?.count) ? result.count : 0) + (Number.isInteger(result?.breakdown?.episode) ? result.breakdown.episode : 0);
    const applied = await deps.complete({ ...claimArgs, summary: { count, outboxId: String(event.id) } });
    if (!applied) logWarn(`[HookReflect] claim taken over before completion id=${event.id}`);
    recordHookReflect("reflected");
    logInfo(`[HookReflect] ${payload.client}/${payload.event} reflected id=${event.id} fragments=${count}`);
  };
}

/**
 * hook.reflect 처리기를 outbox 등록부에 등록한다.
 *
 * @param {Partial<typeof DEFAULT_DEPS>} [overrides]
 * @returns {() => void} 등록 해제 함수
 */
export function registerHookReflectConsumer(overrides = {}) {
  return registerOutboxHandler(HOOK_REFLECT_TOPIC, createHookReflectHandler(overrides));
}
