/**
 * 벡터 색인 미리 적재
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * 의미 검색의 HNSW 색인이 DB 공유 버퍼에서 밀려나면 첫 질의가 색인 페이지를 디스크에서 읽느라 수 초 걸린다(운영에서
 * 같은 질의가 첫 호출 3.9초, 이어서 44ms). DB를 다른 서비스와 함께 쓰는 설치에서 자주 생긴다. 이 작업은 agent_memory
 * 스키마의 HNSW 색인을 pg_prewarm으로 주기적으로 읽어 버퍼에 남긴다. 이미 버퍼에 있는 페이지는 디스크를 읽지 않는다.
 *
 * 주기는 MEMENTO_VECTOR_PREWARM_MINUTES(기본 10, 0이면 끔). pg_prewarm 확장이 없거나 실행 권한이 없으면 한 번만
 * 경고하고 이후 주기는 아무것도 하지 않는다.
 */

import { getPrimaryPool } from "../../tools/db.js";
import { logInfo, logWarn } from "../../logger.js";
import { SCHEMA }         from "../schema.js";

/** PostgreSQL undefined_function, undefined_object, insufficient_privilege */
const UNAVAILABLE_CODES = new Set(["42883", "42704", "42501"]);

let disabled = false;

/**
 * 미리 적재할 HNSW 색인 이름 목록.
 *
 * @param {import("pg").Pool} pool
 * @returns {Promise<string[]>}
 */
async function hnswIndexes(pool) {
  const { rows } = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexdef ILIKE '%USING hnsw%' ORDER BY indexname`,
    [SCHEMA]
  );
  return rows.map((r) => r.indexname);
}

/**
 * HNSW 색인을 버퍼에 읽어 둔다. 확장이 없으면 끄고 0을 돌려준다.
 *
 * @param {import("pg").Pool} [pool]
 * @returns {Promise<{ indexes: number, blocks: number }>}
 */
export async function prewarmVectorIndexes(pool = getPrimaryPool()) {
  if (disabled || !pool) return { indexes: 0, blocks: 0 };
  let blocks = 0;
  const names = await hnswIndexes(pool);
  try {
    for (const name of names) {
      const { rows } = await pool.query("SELECT pg_prewarm(format('%I.%I', $1::text, $2::text)::regclass) AS blocks", [SCHEMA, name]);
      blocks += Number(rows[0]?.blocks ?? 0);
    }
  } catch (err) {
    if (!UNAVAILABLE_CODES.has(err?.code)) throw err;
    disabled = true;
    logWarn(`[VectorPrewarm] pg_prewarm unavailable (code=${err.code}); vector index prewarm is off: ${err.message}`);
    return { indexes: 0, blocks: 0 };
  }
  return { indexes: names.length, blocks };
}

/**
 * 시작 30초 뒤 한 번과 주기마다 미리 적재한다. 주기가 0이면 아무것도 하지 않는다.
 *
 * @param {{ minutes: number, run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>,
 *           registry: { recordSuccess: Function, recordFailure: Function } }} opts
 *        run은 백그라운드 레인 실행기(pool-gate.runInBackground), registry는 스케줄러 작업 기록이다
 * @returns {NodeJS.Timeout|null}
 */
export function scheduleVectorPrewarm({ minutes, run, registry }) {
  if (!(minutes > 0)) return null;
  const tick = () => run("vectorPrewarm", async () => {
    try {
      registry.recordSuccess("vectorPrewarm", await prewarmVectorIndexes());
    } catch (err) {
      logWarn(`[VectorPrewarm] prewarm failed: ${err.message}`);
      registry.recordFailure("vectorPrewarm", err);
    }
  });
  setTimeout(tick, 30_000).unref();
  const timer = setInterval(tick, minutes * 60_000);
  timer.unref();
  logInfo(`Vector index prewarm: every ${minutes} minutes`);
  return timer;
}

/** 시험용: 비활성 상태를 되돌린다. */
export function resetVectorPrewarm() {
  disabled = false;
}
