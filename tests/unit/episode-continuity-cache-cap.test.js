/**
 * EpisodeContinuityService 캐시 상한 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-07-04
 */
import { test } from "node:test";
import assert   from "node:assert";
import { _rememberLastEventForTest, _lastEventCacheForTest } from "../../lib/memory/EpisodeContinuityService.js";

test("캐시가 상한(1000)을 넘으면 가장 오래된 항목부터 방출한다", () => {
  const cache = _lastEventCacheForTest();
  cache.clear();
  for (let i = 0; i < 1005; i++) {
    _rememberLastEventForTest(`agent-${i}:master`, { eventId: i });
  }
  assert.strictEqual(cache.size, 1000);
  assert.strictEqual(cache.has("agent-0:master"), false);
  assert.strictEqual(cache.has("agent-1004:master"), true);
});

test("기존 키 갱신은 최신 위치로 이동하며 크기를 늘리지 않는다", () => {
  const cache = _lastEventCacheForTest();
  cache.clear();
  _rememberLastEventForTest("a:master", { eventId: 1 });
  _rememberLastEventForTest("b:master", { eventId: 2 });
  _rememberLastEventForTest("a:master", { eventId: 3 });
  assert.strictEqual(cache.size, 2);
  assert.strictEqual([...cache.keys()].pop(), "a:master");
});
