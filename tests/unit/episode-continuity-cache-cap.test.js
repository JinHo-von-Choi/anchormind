/**
 * EpisodeContinuityService 스코프 캐시(LRU + TTL) 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-07-04
 * 수정일: 2026-08-15
 */
import { test } from "node:test";
import assert   from "node:assert";
import {
  _cacheLastEventForTest,
  _readCachedEventForTest,
  _lastEventCacheForTest
} from "../../lib/memory/processors/EpisodeContinuityService.js";

test("캐시가 상한(1000)을 넘으면 가장 오래된 항목부터 방출한다", () => {
  const cache = _lastEventCacheForTest();
  cache.clear();
  for (let i = 0; i < 1005; i++) {
    _cacheLastEventForTest(`agent-${i}:master:topic:t`, `event-${i}`);
  }
  assert.strictEqual(cache.size, 1000);
  assert.strictEqual(cache.has("agent-0:master:topic:t"), false);
  assert.strictEqual(cache.has("agent-1004:master:topic:t"), true);
});

test("기존 키 갱신은 최신 위치로 이동하며 크기를 늘리지 않는다", () => {
  const cache = _lastEventCacheForTest();
  cache.clear();
  _cacheLastEventForTest("a:master:topic:t", "event-1");
  _cacheLastEventForTest("b:master:topic:t", "event-2");
  _cacheLastEventForTest("a:master:topic:t", "event-3");
  assert.strictEqual(cache.size, 2);
  assert.strictEqual([...cache.keys()].pop(), "a:master:topic:t");
});

test("TTL 만료 전에는 캐시된 이벤트 ID를 반환한다", () => {
  const cache = _lastEventCacheForTest();
  cache.clear();
  _cacheLastEventForTest("agent-x:master:workspace:proj-a", "event-fresh");
  assert.strictEqual(_readCachedEventForTest("agent-x:master:workspace:proj-a"), "event-fresh");
});

test("TTL 만료 후에는 miss(undefined)로 취급하고 항목을 제거한다", () => {
  const cache = _lastEventCacheForTest();
  cache.clear();
  _cacheLastEventForTest("agent-y:master:workspace:proj-b", "event-stale");
  cache.set("agent-y:master:workspace:proj-b", { eventId: "event-stale", expiresAt: Date.now() - 1 });

  assert.strictEqual(_readCachedEventForTest("agent-y:master:workspace:proj-b"), undefined);
  assert.strictEqual(cache.has("agent-y:master:workspace:proj-b"), false);
});

test("캐시에 없는 스코프 키는 undefined를 반환한다", () => {
  const cache = _lastEventCacheForTest();
  cache.clear();
  assert.strictEqual(_readCachedEventForTest("agent-z:master:topic:none"), undefined);
});

test("workspace 스코프와 topic 스코프는 서로 다른 캐시 키로 분리된다", () => {
  const cache = _lastEventCacheForTest();
  cache.clear();
  _cacheLastEventForTest("agent-w:master:workspace:proj-a", "event-ws");
  _cacheLastEventForTest("agent-w:master:topic:proj-a", "event-topic");
  assert.strictEqual(_readCachedEventForTest("agent-w:master:workspace:proj-a"), "event-ws");
  assert.strictEqual(_readCachedEventForTest("agent-w:master:topic:proj-a"), "event-topic");
});
