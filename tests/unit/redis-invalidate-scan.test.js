/**
 * invalidateCacheByPattern SCAN 커서 순회 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-07-04
 */
import { test } from "node:test";
import assert   from "node:assert";
import { redisClient, invalidateCacheByPattern } from "../../lib/redis.js";

test("SCAN 커서를 끝까지 순회하며 페이지별로 삭제한다", async () => {
  const pages   = [["10", ["k1", "k2"]], ["0", ["k3"]]];
  const deleted = [];
  redisClient.scan = async (cursor) => pages[cursor === "0" ? 0 : 1];
  redisClient.del  = async (...keys) => { deleted.push(...keys); return keys.length; };
  redisClient.keys = async () => { throw new Error("KEYS가 호출되면 안 된다"); };

  const n = await invalidateCacheByPattern("db:*");
  assert.strictEqual(n, 3);
  assert.deepStrictEqual(deleted, ["k1", "k2", "k3"]);
});
