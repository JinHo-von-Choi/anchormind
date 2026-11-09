/**
 * 키 캐시 무효화와 프로세스 간 전파
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * 키 상태(세션 재확인), 정책(hard gate, allowed_workspaces, 외부 전송 정책, workspace 별칭), 할당량 사용량 캐시는
 * 프로세스마다 따로 있다.
 * 관리 API가 키를 바꾸면 이 프로세스의 캐시는 바로 지우고, Redis가 켜져 있으면 같은 Redis를 쓰는 다른 서버
 * 프로세스에 키 id를 알린다. CLI도 같은 채널로 알리므로 실행 중인 서버가 재확인 주기를 기다리지 않는다.
 * Redis가 꺼져 있거나 알림이 실패하면 다른 프로세스는 재확인 주기(MEMENTO_SESSION_KEY_RECHECK_MS) 안에 반영한다.
 */

import crypto from "node:crypto";

import { REDIS_ENABLED }             from "../config.js";
import { logInfo, logWarn }          from "../logger.js";
import { redisClient }               from "../redis.js";
import { invalidateKeyState }        from "./key-state-cache.js";
import { invalidateKeyPolicyCaches } from "./policy.js";
import { invalidateUsageCache }      from "../memory/quota-usage-cache.js";

/** Redis pub/sub 채널은 DB 번호와 무관하게 서버 전체에서 공유되므로 이 서비스 이름을 붙인다. */
export const KEY_INVALIDATION_CHANNEL = "memento-mcp:key-invalidate";

/** 한 알림에 싣는 키 id 상한. 그룹 하나의 멤버 수보다 넉넉하다. */
const MAX_KEYS_PER_MESSAGE = 1_000;

/** 자기가 보낸 알림을 받아 다시 지우지 않도록 프로세스마다 다른 id를 싣는다. */
const INSTANCE_ID = crypto.randomUUID();

let subscriber = null;

/**
 * @param {Iterable<string|null|undefined>} keyIds
 * @returns {string[]}
 */
function distinctKeyIds(keyIds) {
  return [...new Set([...keyIds].filter((id) => typeof id === "string" && id !== ""))];
}

/**
 * 이 프로세스의 키 상태와 정책 캐시를 지운다.
 *
 * @param {Iterable<string>} keyIds
 */
export function invalidateKeyCachesLocally(keyIds) {
  for (const keyId of distinctKeyIds(keyIds)) {
    invalidateKeyState(keyId);
    invalidateKeyPolicyCaches(keyId);
    invalidateUsageCache(keyId);
  }
}

/**
 * 다른 프로세스에 키 id를 알린다. Redis가 꺼져 있으면 아무것도 하지 않는다. 실패는 경고로만 남긴다.
 *
 * @param {Iterable<string>} keyIds
 * @param {{ client?: { status?: string, publish: Function }, enabled?: boolean }} [deps]
 * @returns {Promise<boolean>} 알림을 보냈으면 true
 */
export async function broadcastKeyInvalidation(keyIds, { client = redisClient, enabled = REDIS_ENABLED } = {}) {
  const ids = distinctKeyIds(keyIds);
  // iron-laws: ignore[IL-307] Redis나 보낼 키가 없으면 알림을 보내지 않았다는 결과다
  if (!enabled || ids.length === 0 || !client || client.status === "stub") return false;
  try {
    for (let i = 0; i < ids.length; i += MAX_KEYS_PER_MESSAGE) {
      const message = JSON.stringify({ from: INSTANCE_ID, keyIds: ids.slice(i, i + MAX_KEYS_PER_MESSAGE) });
      await client.publish(KEY_INVALIDATION_CHANNEL, message);
    }
    return true;
  } catch (err) {
    logWarn(`[KeyInvalidation] 다른 프로세스에 알리지 못했다(재확인 주기 안에 반영된다): ${err.message}`);
    return false;
  }
}

/**
 * 이 프로세스의 캐시를 지우고 다른 프로세스에 알린다. 알림은 기다리지 않는다.
 *
 * @param {Iterable<string>} keyIds
 */
export function invalidateKeys(keyIds) {
  const ids = distinctKeyIds(keyIds);
  // iron-laws: ignore[IL-307] 지울 키가 없으면 할 일이 없다
  if (ids.length === 0) return;
  invalidateKeyCachesLocally(ids);
  void broadcastKeyInvalidation(ids);
}

/**
 * 받은 알림을 해석해 캐시를 지운다. 이 프로세스가 보낸 알림과 형식이 맞지 않는 알림은 무시한다.
 *
 * @param {string} raw
 * @returns {number} 지운 키 수
 */
export function handleKeyInvalidationMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  // iron-laws: ignore[IL-301] 해석할 수 없는 알림은 아래에서 경고로 남기고 무시한다
  } catch {
    logWarn("[KeyInvalidation] 해석할 수 없는 알림을 무시했다");
    return 0;
  }
  // iron-laws: ignore[IL-307] 자기 알림과 형식이 맞지 않는 알림은 무시한다
  if (!message || message.from === INSTANCE_ID || !Array.isArray(message.keyIds)) return 0;
  const ids = distinctKeyIds(message.keyIds.slice(0, MAX_KEYS_PER_MESSAGE));
  invalidateKeyCachesLocally(ids);
  return ids.length;
}

/**
 * 서버 기동 때 알림 구독을 연다. 구독은 명령을 보낼 수 없으므로 별도 연결을 쓴다.
 * Redis가 꺼져 있으면 열지 않는다. 연결 실패는 경고로 남기고 기동을 막지 않는다.
 *
 * @returns {Promise<boolean>}
 */
export async function startKeyInvalidationSubscriber() {
  // iron-laws: ignore[IL-307] Redis가 없거나 이미 구독 중이면 열지 않는다
  if (!REDIS_ENABLED || subscriber || typeof redisClient.duplicate !== "function") return false;
  const conn = redisClient.duplicate();
  conn.on("error", (err) => logWarn(`[KeyInvalidation] 구독 연결 오류: ${err.message}`));
  conn.on("message", (channel, raw) => {
    if (channel === KEY_INVALIDATION_CHANNEL) handleKeyInvalidationMessage(raw);
  });
  try {
    await conn.subscribe(KEY_INVALIDATION_CHANNEL);
    subscriber = conn;
    logInfo(`[KeyInvalidation] ${KEY_INVALIDATION_CHANNEL} 구독 시작`);
    return true;
  } catch (err) {
    logWarn(`[KeyInvalidation] 구독을 열지 못했다(재확인 주기로 반영한다): ${err.message}`);
    conn.disconnect();
    return false;
  }
}

/** 종료 때 구독 연결을 닫는다. */
export async function stopKeyInvalidationSubscriber() {
  if (!subscriber) return;
  const conn = subscriber;
  subscriber = null;
  try {
    await conn.quit();
  } catch (err) {
    logWarn(`[KeyInvalidation] 구독 연결 종료 실패: ${err.message}`);
    conn.disconnect();
  }
}
