/**
 * SessionActivityTracker.getUnreflectedSessions SCAN 순회 상한 회귀 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-06-16
 *
 * 회귀 경위:
 *   Redis keyspace가 ~10M 키 규모로 성장하면서 frag:activity:* SCAN 루프가
 *   unreflected 세션을 찾지 못할 경우 전체 keyspace를 순회하여
 *   ContextBuilder.build()가 9초 이상 hang하는 현상이 발생했다.
 *   MAX_SCANS = 20 상한을 do-while 조건에 추가하여 수정.
 *
 * 이 파일은 다음을 검증한다:
 *   1. SCAN 반복이 MAX_SCANS(20) 이하에서 중단된다.
 *   2. 전체 keyspace가 커도 limit 개수 이상을 반환하지 않는다.
 *   3. Redis가 unavailable 상태면 빈 배열을 반환한다.
 *   4. cursor="0"이 즉시 반환되면 단 1회 SCAN으로 종료된다.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

/** ── 테스트 전용 getUnreflectedSessions 추출 ──────────────────────────
 *  실제 모듈은 redisClient 싱글턴에 의존하므로,
 *  동일 로직을 순수 함수로 재구현하여 mock redisClient를 주입한다.
 *  이 함수는 SessionActivityTracker.getUnreflectedSessions의 1:1 복사본이다.
 */
const KEY_PREFIX = "frag:activity:";

async function getUnreflectedSessions(redisClient, limit = 10) {
  if (!redisClient || redisClient.status !== "ready") return [];

  const result    = [];
  let   cursor    = "0";
  let   scanRound = 0;
  const MAX_SCANS = 20;

  try {
    do {
      const [nextCursor, keys] = await redisClient.scan(
        cursor, "MATCH", `${KEY_PREFIX}*`, "COUNT", 50
      );
      cursor = nextCursor;
      scanRound++;

      for (const key of keys) {
        if (result.length >= limit) break;
        const raw = await redisClient.get(key);
        if (!raw) continue;
        const log = JSON.parse(raw);
        if (!log.reflected) {
          const sid = key.replace(KEY_PREFIX, "");
          result.push(sid);
        }
      }
    } while (cursor !== "0" && result.length < limit && scanRound < MAX_SCANS);
  } catch { /* 무시 */ }

  return result;
}

/* ── Mock Redis 팩토리 ─────────────────────────────────────────────── */

/**
 * 지정한 총 페이지 수만큼 cursor를 순환하는 mock을 생성한다.
 * 각 SCAN은 빈 keys를 반환하므로 unreflected 세션을 하나도 찾지 못한다.
 * totalPages > MAX_SCANS 이면 무한 루프 위험 시나리오다.
 */
function makeInfiniteScanMock(totalPages) {
  let callCount = 0;
  return {
    status: "ready",
    scanCallCount: () => callCount,
    scan: async (_cursor, ...args) => {
      callCount++;
      const page = callCount;
      /** cursor가 "0"이 되면 루프가 끝나므로, 마지막 페이지에서만 "0"을 반환한다.
       *  단, totalPages=Infinity 시나리오에서는 절대 "0"을 반환하지 않는다. */
      const nextCursor = page >= totalPages ? "0" : String(page * 1000);
      return [nextCursor, []]; // 항상 빈 keys
    },
    get: async () => null
  };
}

/** unreflected 세션이 keyspace 깊숙이 묻혀 있는 mock. */
function makeDeepUnreflectedMock(targetPage, sessionId) {
  let callCount = 0;
  return {
    status: "ready",
    scan: async (_cursor, ...args) => {
      callCount++;
      if (callCount === targetPage) {
        return [String(callCount * 1000), [`${KEY_PREFIX}${sessionId}`]];
      }
      const isDone = callCount >= 100; // 100페이지 이후 종료
      return [isDone ? "0" : String(callCount * 1000), []];
    },
    get: async (key) => {
      if (key === `${KEY_PREFIX}${sessionId}`) {
        return JSON.stringify({ reflected: false });
      }
      return null;
    }
  };
}

/** cursor가 첫 번째 호출에서 "0"을 반환하는 단순 mock. */
function makeSinglePageMock(sessions = []) {
  return {
    status: "ready",
    scan: async () => [
      "0",
      sessions.map(s => `${KEY_PREFIX}${s}`)
    ],
    get: async (key) => {
      const sid = key.replace(KEY_PREFIX, "");
      const found = sessions.includes(sid);
      return found ? JSON.stringify({ reflected: false }) : null;
    }
  };
}

/* ── 테스트 스위트 ──────────────────────────────────────────────────── */

describe("SessionActivityTracker.getUnreflectedSessions SCAN 상한", () => {

  it("10M 키 규모(cursor 비종료) 환경에서 MAX_SCANS=20 이하로 SCAN이 중단된다", async () => {
    /** 총 페이지 수를 Infinity로 설정 — cursor가 절대 "0"이 되지 않는 worst case */
    const redis     = makeInfiniteScanMock(Infinity);
    const result    = await getUnreflectedSessions(redis, 3);

    assert.equal(result.length, 0, "unreflected 없으면 빈 배열 반환");
    assert.equal(redis.scanCallCount(), 20, "정확히 MAX_SCANS=20회 호출");
  });

  it("총 SCAN 페이지가 MAX_SCANS 미만이면 자연 종료된다(cursor=0)", async () => {
    const redis  = makeInfiniteScanMock(5); // 5페이지 후 cursor="0"
    const result = await getUnreflectedSessions(redis, 3);

    assert.equal(result.length, 0);
    assert.equal(redis.scanCallCount(), 5, "5페이지 후 cursor=0으로 자연 종료");
  });

  it("limit개 발견하면 MAX_SCANS 미만에서도 조기 종료된다", async () => {
    const sessions = ["s1", "s2", "s3", "s4", "s5"];
    const redis    = makeSinglePageMock(sessions);
    const result   = await getUnreflectedSessions(redis, 3);

    assert.equal(result.length, 3, "limit=3 초과 반환 안 함");
  });

  it("unreflected 세션이 MAX_SCANS 이후에 있으면 발견되지 않는다(정책적 허용)", async () => {
    /** page=25에 세션이 묻혀 있지만 MAX_SCANS=20이므로 도달 못 함 */
    const redis  = makeDeepUnreflectedMock(25, "deep-session");
    const result = await getUnreflectedSessions(redis, 3);

    assert.equal(result.length, 0, "20페이지 이후는 탐색하지 않음");
  });

  it("unreflected 세션이 MAX_SCANS 이내에 있으면 정상 반환된다", async () => {
    const redis  = makeDeepUnreflectedMock(10, "shallow-session");
    const result = await getUnreflectedSessions(redis, 3);

    assert.ok(result.includes("shallow-session"), "10페이지 이내 세션은 정상 탐색");
  });

  it("Redis 연결이 unavailable 상태면 빈 배열 반환", async () => {
    const redis  = { status: "disconnected" };
    const result = await getUnreflectedSessions(redis, 3);
    assert.deepEqual(result, []);
  });

  it("Redis가 null이면 빈 배열 반환", async () => {
    const result = await getUnreflectedSessions(null, 3);
    assert.deepEqual(result, []);
  });

  it("단일 페이지(cursor=0 즉시)에서 reflected 세션은 결과에 포함되지 않는다", async () => {
    const redis = {
      status: "ready",
      scan: async () => ["0", [`${KEY_PREFIX}reflected-sess`]],
      get:  async () => JSON.stringify({ reflected: true })
    };
    const result = await getUnreflectedSessions(redis, 5);
    assert.deepEqual(result, []);
  });
});
