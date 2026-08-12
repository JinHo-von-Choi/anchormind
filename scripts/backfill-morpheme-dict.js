#!/usr/bin/env node
/**
 * backfill-morpheme-dict.js — morpheme_dict의 embedding NULL 행 일괄 재임베딩
 *
 * 작성자: 최진호
 * 작성일: 2026-08-12
 *
 * 목적: 임베딩 계산 실패의 잔재로 NULL이 된 morpheme_dict 행을 배치 재계산한다.
 *       fragments 대상 backfill-embeddings.js·MorphemeBackfill은 이 테이블을
 *       다루지 않으므로 전용 진입점이 필요하다.
 * 호출 조건: NULL 행 누적 확인 시 수동 실행 (비용 승인 후)
 * 빈도: 조건부
 * 의존: .env (DB·임베딩 프로바이더 설정)
 *
 * 사용:
 *   node scripts/backfill-morpheme-dict.js --dry-run          # 대상 수·표본만 출력
 *   node scripts/backfill-morpheme-dict.js                    # 기본 배치 100, 배치 간 1초
 *   node scripts/backfill-morpheme-dict.js --batch 200 --sleep-ms 500 --max 5000
 *
 * 실패 처리: 배치 안에서 치유되지 않은 형태소는 재시도하지 않고 격리 목록으로
 * 집계한다(무한 재선택 방지). 프로바이더 쿨다운이 활성화되면 즉시 중단한다.
 */

import dotenv from "dotenv";
dotenv.config();

import { getPrimaryPool } from "../lib/tools/db.js";
import { MorphemeIndex }  from "../lib/memory/embedding/MorphemeIndex.js";

const SCHEMA = "agent_memory";

const args    = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

function intArg(name, def) {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0 || idx + 1 >= args.length) return def;
  const n = parseInt(args[idx + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const BATCH_SIZE = intArg("batch", 100);
const SLEEP_MS   = intArg("sleep-ms", 1000);
const MAX_TOTAL  = intArg("max", Infinity);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const pool = getPrimaryPool();
  if (!pool) {
    console.error("DB pool 초기화 실패 — .env의 POSTGRES_* 설정을 확인하라.");
    process.exit(1);
  }

  const { rows: [{ count }] } = await pool.query(
    `SELECT count(*)::int AS count FROM ${SCHEMA}.morpheme_dict WHERE embedding IS NULL`
  );
  console.log(`morpheme_dict embedding NULL: ${count}행`);

  if (DRY_RUN) {
    const { rows } = await pool.query(
      `SELECT morpheme FROM ${SCHEMA}.morpheme_dict WHERE embedding IS NULL ORDER BY morpheme LIMIT 10`
    );
    console.log("표본:", rows.map(r => r.morpheme).join(", "));
    console.log(`dry-run 종료. 실제 실행 시 배치 ${BATCH_SIZE}건, 배치 간 ${SLEEP_MS}ms.`);
    await pool.end();
    return;
  }

  const index      = new MorphemeIndex();
  const quarantine = [];
  let   healed     = 0;
  let   attempted  = 0;
  let   cursor     = "";

  while (attempted < MAX_TOTAL) {
    const { rows } = await pool.query(
      `SELECT morpheme FROM ${SCHEMA}.morpheme_dict
       WHERE embedding IS NULL AND morpheme > $1
       ORDER BY morpheme LIMIT $2`,
      [cursor, BATCH_SIZE]
    );
    if (rows.length === 0) break;

    const batch = rows.map(r => r.morpheme);
    cursor      = batch[batch.length - 1];
    attempted  += batch.length;

    /** getOrRegisterEmbeddings가 NULL 행을 miss로 취급해 재계산·조건부 UPDATE로 치유한다. */
    await index.getOrRegisterEmbeddings(batch);

    const { rows: remain } = await pool.query(
      `SELECT morpheme FROM ${SCHEMA}.morpheme_dict
       WHERE embedding IS NULL AND morpheme = ANY($1)`,
      [batch]
    );
    const failedSet = new Set(remain.map(r => r.morpheme));
    healed += batch.length - failedSet.size;
    quarantine.push(...failedSet);

    console.log(`진행: 시도 ${attempted} / 치유 ${healed} / 격리 ${quarantine.length} (커서: ${cursor})`);

    /** 배치 전체가 실패했다면 프로바이더 쿨다운 상태로 판단하고 중단한다. */
    if (failedSet.size === batch.length) {
      console.error("배치 전체 실패 — 프로바이더 상태를 확인 후 재실행하라.");
      break;
    }

    if (SLEEP_MS > 0) await sleep(SLEEP_MS);
  }

  console.log(`완료: 치유 ${healed}행, 격리 ${quarantine.length}행.`);
  if (quarantine.length > 0) {
    console.log("격리 형태소(최대 50):", quarantine.slice(0, 50).join(", "));
  }
  await pool.end();
}

main().catch(err => {
  console.error("backfill 실패:", err);
  process.exit(1);
});
