#!/usr/bin/env node
/**
 * backfill-claims.js — 기존 파편에 ClaimExtractor 소급 실행
 *
 * 작성자: 최진호
 * 수정일: 2026-04-20 (v2.12.0 문서 현행화 반영)
 *
 * 목적: v2.7.0 이전 코퍼스에 ClaimExtractor를 소급 실행하여 fragment_claims 테이블을 채운다.
 *       실행 이후 신규 파편은 RememberPostProcessor 8단계 hook에서 실시간 추출되므로
 *       이 스크립트는 기존 코퍼스 전용이다.
 * 호출 조건: Phase 1 Shadow(MEMENTO_SYMBOLIC_SHADOW=true) 활성화 전 1회
 * 빈도: 일회성
 * 의존: DATABASE_URL, OPENAI_API_KEY(또는 로컬 transformers provider)
 * 관련 문서: docs/operations/backfill-claims.md, docs/operations/maintenance.md
 *
 * 옵션: --batch-size N, --rate-limit-ms N, --tenant-key KEY, --limit N,
 *       --min-confidence 0..1, --dry-run, --verbose
 * 전제: 실행 전 반드시 --dry-run으로 추출 볼륨과 tenant_violations 수치를 확인한다.
 *
 * 작성자: 최진호
 * 수정일: 2026-04-19
 *
 * 목적: Phase 1 Shadow 진입 시 기존 v2.7.0 파편(미추출 상태)을 대상으로
 *       claim 을 소급 생성한다. 실행 시점에 새로 들어오는 파편은 RememberPostProcessor
 *       의 8단계 hook 에서 실시간으로 추출되므로, 이 스크립트는 기존 코퍼스 전용이다.
 *
 * 설계 원칙:
 *  1) 테넌트별 그룹 처리. master(key_id IS NULL) 와 각 tenant 키를 별도 SELECT 로 분리해서
 *     ClaimStore.insert(fragment, claims, { keyId }) 호출. master 는 keyId=null.
 *  2) 배치 키셋 페이지네이션. id DESC 로 가져오면서 마지막 id 를 next cursor 로 사용하면
 *     OFFSET N 페이지네이션이 대량 파편에서 느려지는 문제를 피할 수 있다.
 *  3) rate-limit 100ms per batch. DB 와 Gemini(MorphemeIndex) 에 압력을 덜 준다.
 *  4) --dry-run 은 extract 까지만 실행하고 insert 는 skip. claim 수만 계산.
 *  5) 누적 메트릭: examined, claims_extracted, claims_inserted, extractor_errors,
 *     tenant_violations. 끝에 표로 출력.
 *
 * 실행 방법:
 *   DATABASE_URL=postgresql://... node scripts/backfill-claims.js
 *   DATABASE_URL=... node scripts/backfill-claims.js --batch-size 200 --dry-run
 *   DATABASE_URL=... node scripts/backfill-claims.js --tenant-key api-key-42 --limit 1000
 *
 * 주의:
 *  - 테스트 DB 권장. 프로덕션 DB 실행 전 --dry-run 으로 먼저 수치 확인.
 *  - MEMENTO_SYMBOLIC_ENABLED 등 런타임 플래그와 무관하게 스크립트 자체가 결정.
 */

import _path from "node:path";
import dotenv from "dotenv";

dotenv.config();

/* ------------------------------------------------------------------ */
/*  CLI                                                               */
/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/backfill-claims.js [options]

Options:
  --help, -h               Show this help
  --batch-size <N>         Rows per batch  (default: 500)
  --rate-limit-ms <N>      Pause between batches (default: 100)
  --tenant-key <KEY>       Only process this specific key_id (default: all tenants)
                           Use the literal string 'master' for key_id IS NULL.
  --limit <N>              Maximum total rows to process (default: unlimited)
  --min-confidence <0..1>  Drop claims below this confidence (default: 0.5)
  --dry-run                Run extraction but skip ClaimStore.insert
  --verbose                Per-batch log output

Environment:
  DATABASE_URL             PostgreSQL connection string (required)

Notes:
  - Processes fragments in DESC id order with keyset pagination.
  - One tenant at a time (master → each API key). Tenant violations are counted and skipped.
  - Use --dry-run first to estimate volume before committing to write.
`);
  process.exit(0);
}

const getArg = (name, def, parser = Number) => {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0 || idx + 1 >= args.length) return def;
  const v = parser(args[idx + 1]);
  return Number.isFinite(v) || typeof v === "string" ? v : def;
};
const getStrArg = (name, def) => {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0 || idx + 1 >= args.length) return def;
  return args[idx + 1];
};

const BATCH_SIZE     = Math.max(1, getArg("batch-size", 500));
const RATE_LIMIT_MS  = Math.max(0, getArg("rate-limit-ms", 100));
const LIMIT          = getArg("limit", Infinity);
const TENANT_KEY     = getStrArg("tenant-key", null);  // null → all, 'master' → NULL, else tenant key_id
const MIN_CONFIDENCE = Number(getStrArg("min-confidence", "0.5"));
const DRY_RUN        = args.includes("--dry-run");
const VERBOSE        = args.includes("--verbose");

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable is required");
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/*  Imports                                                           */
/* ------------------------------------------------------------------ */

const { getPrimaryPool } = await import("../lib/tools/db.js");
const { ClaimExtractor } = await import("../lib/symbolic/ClaimExtractor.js");
const { ClaimStore, TENANT_ISOLATION_VIOLATION } = await import("../lib/symbolic/ClaimStore.js");

const pool      = getPrimaryPool();
const extractor = new ClaimExtractor();
const store     = new ClaimStore();

if (!pool) {
  console.error("ERROR: failed to acquire primary DB pool");
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/*  Tenant enumeration                                                */
/* ------------------------------------------------------------------ */

/**
 * 처리할 테넌트 목록을 결정.
 * - TENANT_KEY === null : master + DB 에 존재하는 모든 key_id
 * - TENANT_KEY === 'master' : master(NULL) 단독
 * - 그 외 : 해당 key_id 단독
 *
 * 각 원소는 { label, keyId(null|string) } 구조.
 */
async function resolveTenants() {
  if (TENANT_KEY === "master") {
    return [{ label: "master", keyId: null }];
  }
  if (TENANT_KEY) {
    return [{ label: TENANT_KEY, keyId: TENANT_KEY }];
  }

  const out = [{ label: "master", keyId: null }];
  const { rows } = await pool.query(
    `SELECT DISTINCT key_id
       FROM agent_memory.fragments
      WHERE key_id IS NOT NULL
      ORDER BY key_id ASC`
  );
  for (const r of rows) out.push({ label: r.key_id, keyId: r.key_id });
  return out;
}

/**
 * 단일 테넌트 범위 내에서 fragment 배치 조회 (키셋 페이지네이션).
 * keyId === null 이면 master. 그 외는 동등 매칭.
 *
 * @param {string|null} keyId
 * @param {string|null} cursorId    이전 배치 마지막 id (DESC 기준 "less than")
 * @param {number}      limit
 */
async function fetchBatch(keyId, cursorId, limit) {
  const cursorSql = cursorId ? "AND id < $CURSOR" : "";
  const baseSql   = `
    SELECT id, key_id, content, topic, type
      FROM agent_memory.fragments
     WHERE key_id IS NOT DISTINCT FROM $1
       AND content IS NOT NULL
       AND valid_to IS NULL
       ${cursorSql}
     ORDER BY id DESC
     LIMIT $2
  `;

  let sql;
  let params;
  if (cursorId) {
    sql = baseSql.replace("$CURSOR", "$3");
    params = [keyId, limit, cursorId];
  } else {
    sql = baseSql;
    params = [keyId, limit];
  }

  const { rows } = await pool.query(sql, params);
  return rows;
}

/* ------------------------------------------------------------------ */
/*  Per-fragment processing                                           */
/* ------------------------------------------------------------------ */

const counters = {
  examined          : 0,
  claims_extracted  : 0,
  claims_inserted   : 0,
  claims_filtered   : 0,
  extractor_errors  : 0,
  insert_errors     : 0,
  tenant_violations : 0,
  fragments_with_claims: 0,
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function processFragment(fragment, keyId) {
  counters.examined++;

  let claims;
  try {
    claims = await extractor.extract(fragment.content, fragment.topic);
  } catch {
    counters.extractor_errors++;
    return;
  }
  if (!Array.isArray(claims) || claims.length === 0) return;

  const kept = claims.filter(c => typeof c.confidence === "number" && c.confidence >= MIN_CONFIDENCE);
  counters.claims_extracted += claims.length;
  counters.claims_filtered  += claims.length - kept.length;
  if (kept.length === 0) return;

  if (DRY_RUN) {
    counters.fragments_with_claims++;
    return;
  }

  try {
    const inserted = await store.insert(fragment, kept, { keyId });
    counters.claims_inserted += inserted;
    counters.fragments_with_claims++;
  } catch (err) {
    if (err && err.message === TENANT_ISOLATION_VIOLATION) {
      counters.tenant_violations++;
    } else {
      counters.insert_errors++;
      if (VERBOSE) console.error(`[backfill] insert failed for ${fragment.id}: ${err?.message ?? err}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Main                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const tenants = await resolveTenants();
  console.log(`[backfill] tenants to process: ${tenants.length} (${tenants.map(t => t.label).join(", ")})`);
  console.log(`[backfill] batch_size=${BATCH_SIZE} rate_limit_ms=${RATE_LIMIT_MS} limit=${LIMIT} dry_run=${DRY_RUN}`);

  const t0 = Date.now();

  outer:
  for (const { label, keyId } of tenants) {
    let cursor = null;
    let tenantCount = 0;

    for (;;) {
      const remaining = LIMIT - counters.examined;
      if (remaining <= 0) break outer;

      const take = Math.min(BATCH_SIZE, remaining);
      const rows = await fetchBatch(keyId, cursor, take);
      if (rows.length === 0) break;

      for (const row of rows) {
        await processFragment(row, keyId);
      }

      tenantCount += rows.length;
      cursor       = rows[rows.length - 1].id;

      if (VERBOSE) {
        console.log(`[backfill] tenant=${label} batch=${rows.length} cursor=${cursor} total_examined=${counters.examined}`);
      }

      if (RATE_LIMIT_MS > 0) await sleep(RATE_LIMIT_MS);
      if (rows.length < take) break;
    }

    console.log(`[backfill] tenant=${label} processed=${tenantCount}`);
  }

  const elapsedMs = Date.now() - t0;

  console.log("");
  console.log("[backfill] ===== summary =====");
  console.log(`  elapsed_ms           : ${elapsedMs}`);
  console.log(`  examined             : ${counters.examined}`);
  console.log(`  fragments_with_claims: ${counters.fragments_with_claims}`);
  console.log(`  claims_extracted     : ${counters.claims_extracted}`);
  console.log(`  claims_filtered      : ${counters.claims_filtered} (confidence < ${MIN_CONFIDENCE})`);
  console.log(`  claims_inserted      : ${counters.claims_inserted}`);
  console.log(`  extractor_errors     : ${counters.extractor_errors}`);
  console.log(`  insert_errors        : ${counters.insert_errors}`);
  console.log(`  tenant_violations    : ${counters.tenant_violations}`);
  console.log(`  mode                 : ${DRY_RUN ? "DRY RUN (no inserts)" : "WRITE"}`);

  await pool.end?.();
}

main().catch(async (err) => {
  console.error("[backfill] fatal:", err);
  try { await pool.end?.(); } catch {}
  process.exit(1);
});
