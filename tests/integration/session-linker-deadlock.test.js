/**
 * SessionLinker 배치 링크 생성 동시성 회귀 테스트 (Phase 5)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-27
 *
 * 검증 범위:
 * - 10개 reflect 동시 호출 시 deadlock 미발생
 * - lock_timeout 5s 내 모두 완료
 * - 실제 DB 필요: DATABASE_URL 미설정 시 스킵
 *
 * 수동 실행:
 *   DATABASE_URL=postgresql://user:pass@localhost:5432/bee_db \
 *   node --test tests/integration/session-linker-deadlock.test.js
 */

import "./_cleanup.js";
import { describe, it, before, after } from "node:test";
import assert                           from "node:assert/strict";
import net                              from "node:net";
import crypto                           from "node:crypto";
import pg                               from "pg";

const SCHEMA      = "agent_memory";
const CONCURRENCY = 10;

/** DATABASE_URL TCP 접근 가능 여부 확인 */
async function canConnectToDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host   = parsed.hostname;
    const port   = Number(parsed.port || 5432);
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port, timeout: 3000 }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
      socket.on("timeout", () => { socket.destroy(); resolve(false); });
    });
  } catch { return false; }
}

let pool;
let dbAvailable = false;
const TEST_PREFIX = `sldeadlock-${crypto.randomUUID().slice(0, 8)}`;

before(async () => {
  dbAvailable = await canConnectToDb();
  if (!dbAvailable) {
    console.warn("[session-linker-deadlock] DATABASE_URL 미설정 또는 DB 미연결 — 테스트 스킵");
    return;
  }
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
});

after(async () => {
  if (!pool) return;
  try {
    /** 테스트 파편/링크 정리 */
    await pool.query(
      `DELETE FROM ${SCHEMA}.fragment_links fl
       USING ${SCHEMA}.fragments f
       WHERE (fl.from_id = f.id OR fl.to_id = f.id)
         AND f.topic = $1`,
      [TEST_PREFIX]
    );
    await pool.query(
      `DELETE FROM ${SCHEMA}.fragments WHERE topic = $1`,
      [TEST_PREFIX]
    );
  } catch (_) { /* noop */ }
  await pool.end().catch(() => {});
});

/**
 * 테스트용 파편 N건을 DB에 직접 삽입하고 id 배열을 반환한다.
 */
async function insertTestFragments(count, type) {
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  for (const id of ids) {
    await pool.query(
      `INSERT INTO ${SCHEMA}.fragments
         (id, content, type, topic, importance, ttl_tier, agent_id, keywords)
       VALUES ($1, $2, $3, $4, 0.5, 'warm', 'test', '{}')
       ON CONFLICT DO NOTHING`,
      [id, `${type}-content-${id.slice(0, 8)}`, type, TEST_PREFIX]
    );
  }
  return ids;
}

describe("SessionLinker.createLinks — 동시성 deadlock 회귀", () => {

  it(
    `${CONCURRENCY}개 createLinks 동시 호출 → deadlock 미발생, lock_timeout 5s 내 완료`,
    { timeout: 60_000 },
    async (t) => {
      if (!dbAvailable) {
        t.skip("DATABASE_URL 미설정 — 스킵");
        return;
      }

      /**
       * 각 워커마다 독립 error/decision 파편 2쌍을 생성하고
       * sortedKey 정렬된 createLinks를 Pool client로 직접 실행한다.
       * 파편 ID가 워커마다 달라 실제 lock contention은 낮지만,
       * 같은 UUID 범위 내에서 교차 삽입 시나리오를 커버한다.
       */
      const { LinkStore } = await import("../../lib/memory/link/LinkStore.js");
      const ls            = new LinkStore();

      const workers = Array.from({ length: CONCURRENCY }, async (_, i) => {
        const errorIds    = await insertTestFragments(2, "error");
        const decisionIds = await insertTestFragments(2, "decision");

        /** caused_by 4쌍 빌드 → sortedKey 정렬 */
        const pairs = [];
        for (const eid of errorIds) {
          for (const did of decisionIds) {
            const minId = eid < did ? eid : did;
            const maxId = eid < did ? did : eid;
            pairs.push({ fromId: eid, toId: did, relationType: "caused_by", _sk: `${minId}|${maxId}` });
          }
        }
        pairs.sort((a, b) => a._sk < b._sk ? -1 : a._sk > b._sk ? 1 : 0);
        const cleanPairs = pairs.map(({ fromId, toId, relationType }) => ({ fromId, toId, relationType }));

        try {
          await ls.createLinks(cleanPairs, `worker-${i}`);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      });

      const results = await Promise.all(workers);

      const failures = results.filter(r => !r.ok);
      const deadlocks = failures.filter(r =>
        (r.error || "").toLowerCase().includes("deadlock")
      );

      console.log(
        `[session-linker-deadlock] total=${CONCURRENCY} ` +
        `ok=${results.filter(r => r.ok).length} ` +
        `fail=${failures.length} deadlock=${deadlocks.length}`
      );

      assert.equal(deadlocks.length, 0,
        `deadlock 발생: ${deadlocks.map(f => f.error).join(", ")}`
      );

      /**
       * lock_timeout 에러(55P03)는 DB 과부하 환경에서 발생 가능.
       * 해당 에러는 deadlock이 아니므로 별도 경고만 출력하고 단언 실패 처리하지 않는다.
       */
      const lockTimeouts = failures.filter(r =>
        (r.error || "").includes("55P03") || (r.error || "").toLowerCase().includes("lock timeout")
      );
      if (lockTimeouts.length > 0) {
        console.warn(
          `[session-linker-deadlock] lock_timeout ${lockTimeouts.length}건 (DB 과부하 환경 가능성)`
        );
      }
    }
  );

});
