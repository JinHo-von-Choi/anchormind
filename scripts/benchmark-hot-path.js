#!/usr/bin/env node
/**
 * benchmark-hot-path.js — hot path p50/p95/p99 latency 측정
 *
 * 작성자: 최진호
 * 수정일: 2026-04-20 (v2.12.0 문서 현행화 반영)
 *
 * 목적: remember/recall/link/reflect 4개 hot path의 p50/p95/p99 latency를 측정하여
 *       Symbolic Memory 도입 전후 회귀 기준선을 확보한다.
 * 호출 조건: v2.8.0 Symbolic Memory 계층 활성화 전 baseline 확보,
 *            feature flag 전환 후 오버헤드 비교 측정
 * 빈도: 조건부 (Symbolic Memory Phase 전환 전 1회)
 * 의존: DATABASE_URL (테스트 DB 전용. 프로덕션 DB 실행 금지)
 * 관련 문서: docs/operations/benchmark-hot-path.md, docs/operations/maintenance.md
 *
 * MemoryManager: v2.10.0 이후 내부 분해로 MemoryRememberer 등 하위 클래스로 재편되었으나,
 *   이 스크립트는 MemoryManager facade를 경유하여 동일하게 동작한다. 직접 참조 변경 불필요.
 *
 * 출력: scripts/baseline-v27.json (overwrite). { runAt, gitSha, remember, recall, link, reflect }
 *       각 항목은 { p50, p95, p99, n } 구조.
 */

import fs                from 'node:fs';
import path              from 'node:path';
import { execFileSync }  from 'node:child_process';
import dotenv            from 'dotenv';
import { MemoryManager } from '../lib/memory/MemoryManager.js';

dotenv.config();

/* ------------------------------------------------------------------ */
/*  CLI                                                               */
/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node scripts/benchmark-hot-path.js [options]

Options:
  --help, -h         Show this help
  --remember <N>     remember() iterations (default: 100)
  --recall <N>       recall() iterations   (default: 100)
  --link <N>         link() iterations     (default: 100)
  --reflect <N>      reflect() iterations  (default: 10)
  --output <path>    Output JSON path      (default: scripts/baseline-v27.json)

Environment:
  DATABASE_URL       PostgreSQL connection string (required)

Example:
  DATABASE_URL=postgresql://user:pw@localhost:5432/memento_test \\
    node scripts/benchmark-hot-path.js --remember 200
`);
  process.exit(0);
}

const getArg = (name, def) => {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0 || idx + 1 >= args.length) return def;
  const n = parseInt(args[idx + 1], 10);
  return Number.isFinite(n) ? n : def;
};

const N_REMEMBER = getArg('remember', 100);
const N_RECALL   = getArg('recall',   100);
const N_LINK     = getArg('link',     100);
const N_REFLECT  = getArg('reflect',  10);

const outputIdx = args.indexOf('--output');
const OUTPUT    = outputIdx >= 0 && outputIdx + 1 < args.length
  ? args[outputIdx + 1]
  : path.join(import.meta.dirname, 'baseline-v27.json');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/*  Utils                                                             */
/* ------------------------------------------------------------------ */

const TOPICS = [
  'benchmark-topic-alpha', 'benchmark-topic-beta', 'benchmark-topic-gamma',
  'benchmark-topic-delta', 'benchmark-topic-epsilon'
];

const SAMPLE_CONTENTS = [
  'PostgreSQL HNSW 인덱스는 ef_construction 파라미터로 구축 품질을 제어한다.',
  'Redis L1 캐시는 warmup 시 RRF 가중치를 2배로 적용해 핫 파편을 우선한다.',
  '형태소 분석 기반 L3 검색은 한국어 조사 제거 후 매칭 정밀도가 상승한다.',
  'Cross-Encoder Reranker 는 상위 30건에 대해 쿼리-파편 쌍을 재점수화한다.',
  'fragment_links 의 weight 는 reconsolidation 시 exponential moving average 로 갱신된다.',
  'SpreadingActivation 은 1-hop 그래프 확장 후 ema_activation 으로 boost 한다.',
  'Master key 와 API key 의 key_id 격리는 partial unique index 로 강제된다.',
  'case_events 테이블은 goal/events/outcome 트리플로 CBR 검색을 지원한다.',
];

const SAMPLE_KEYWORDS = [
  'PostgreSQL', 'Redis', '형태소', 'Reranker', 'fragment_links',
  'SpreadingActivation', 'key_id', 'case_events', 'HNSW', 'RRF'
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const randomContent = (i) => `${pick(SAMPLE_CONTENTS)} (benchmark-run ${i})`;
const randomQuery   = ()  => pick(SAMPLE_KEYWORDS);

/**
 * git sha 조회. execFile 사용으로 shell injection 차단.
 * (인자 전부 정적이지만 codebase 보안 가이드 준수)
 */
const getGitSha = () => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd     : path.join(import.meta.dirname, '..'),
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
};

/**
 * Compute quantile (nearest-rank method).
 * @param {number[]} sortedAsc
 * @param {number} q  0.50 | 0.95 | 0.99
 */
const quantile = (sortedAsc, q) => {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil(q * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, Math.min(rank, sortedAsc.length - 1))];
};

const summarize = (samples) => {
  if (samples.length === 0) {
    return { p50: null, p95: null, p99: null, n: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: Number(quantile(sorted, 0.50).toFixed(2)),
    p95: Number(quantile(sorted, 0.95).toFixed(2)),
    p99: Number(quantile(sorted, 0.99).toFixed(2)),
    n  : samples.length,
  };
};

const measure = async (fn) => {
  const t0 = process.hrtime.bigint();
  await fn();
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6;  // ns → ms
};

/* ------------------------------------------------------------------ */
/*  Benchmark                                                         */
/* ------------------------------------------------------------------ */

async function run() {
  console.log('[benchmark] initializing MemoryManager...');
  const manager = new MemoryManager();
  await manager.init?.();

  const agentId = 'benchmark-agent';
  const keyId   = null;  // master key

  const rememberSamples = [];
  const recallSamples   = [];
  const linkSamples     = [];
  const reflectSamples  = [];
  const insertedIds     = [];

  /* ---------- remember ---------- */
  console.log(`[benchmark] remember x ${N_REMEMBER}...`);
  for (let i = 0; i < N_REMEMBER; i++) {
    const ms = await measure(async () => {
      const res = await manager.remember({
        topic     : pick(TOPICS),
        type      : 'fact',
        content   : randomContent(i),
        importance: 0.5,
        agentId,
        keyId,
      });
      if (res?.id) insertedIds.push(res.id);
    });
    rememberSamples.push(ms);
  }

  /* ---------- recall ---------- */
  console.log(`[benchmark] recall x ${N_RECALL}...`);
  for (let i = 0; i < N_RECALL; i++) {
    const ms = await measure(async () => {
      await manager.recall({
        query  : randomQuery(),
        limit  : 10,
        agentId,
        keyId,
      });
    });
    recallSamples.push(ms);
  }

  /* ---------- link ---------- */
  console.log(`[benchmark] link x ${N_LINK}...`);
  const linkPairs = Math.min(N_LINK, Math.floor(insertedIds.length / 2));
  for (let i = 0; i < linkPairs; i++) {
    const fromId = insertedIds[i * 2];
    const toId   = insertedIds[i * 2 + 1];
    if (!fromId || !toId) break;
    const ms = await measure(async () => {
      await manager.link?.({
        fromId,
        toId,
        relationType: 'related',
        agentId,
        keyId,
      });
    });
    linkSamples.push(ms);
  }

  /* ---------- reflect ---------- */
  console.log(`[benchmark] reflect x ${N_REFLECT}...`);
  for (let i = 0; i < N_REFLECT; i++) {
    const ms = await measure(async () => {
      await manager.reflect?.({
        topic: pick(TOPICS),
        agentId,
        keyId,
      });
    });
    reflectSamples.push(ms);
  }

  /* ---------- write result ---------- */
  const pkgVersion = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')
  ).version;
  const result = {
    runAt    : new Date().toISOString(),
    gitSha   : getGitSha(),
    note     : `v${pkgVersion} hot-path baseline for regression comparison`,
    remember : summarize(rememberSamples),
    recall   : summarize(recallSamples),
    link     : summarize(linkSamples),
    reflect  : summarize(reflectSamples),
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2) + '\n');
  console.log(`[benchmark] wrote ${OUTPUT}`);
  console.log(JSON.stringify(result, null, 2));

  await manager.close?.();
}

run().catch((err) => {
  console.error('[benchmark] failed:', err);
  process.exit(1);
});
