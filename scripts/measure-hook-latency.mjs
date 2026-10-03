#!/usr/bin/env node
/**
 * 훅 회고 접수(202) 지연 측정 스크립트
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 일회용 시험 데이터베이스(tests/db-concurrency/_harness.js가 허용하는 서버만)를 만들어 실제 인증(API 키 조회)과
 * 실제 접수 확인 질의, 실제 outbox 기록으로 POST /hooks/codex/Stop을 동시에 보내고, 응답 시간의 p50, p95, p99와
 * 단계별(인증, 접수 확인, 기록) 시간을 JSON으로 출력한다. 부하는 별도 스레드(worker_threads)에서 만들어 서버의
 * 이벤트 루프와 나눈다. 끝나면 데이터베이스를 지운다.
 *
 * 사용: DOTENV_CONFIG_PATH=.env.test MEMENTO_ACCESS_KEY=<임의 값> node scripts/measure-hook-latency.mjs
 *       [--concurrency 50] [--rounds 10] [--keys 1|50]
 *   --keys 1   모든 요청이 같은 API 키(사용량 행 하나를 함께 갱신한다)
 *   --keys N   동시 요청마다 다른 키(N개를 돌려 쓴다)
 * 처리기의 키별 요청 한도는 측정 동안 높여 둔다(기본 RATE_LIMIT_PER_KEY에 걸리지 않게). 측정 중에는 소비자가 없어
 * 대기 행이 쌓이므로, 키 하나에 500건 넘게 보내는 설정(--keys가 작을 때)은 접수 확인 질의를 실제로 실행하되 대기 수
 * 상한 판정만 건너뛴다(출력의 pendingCapBypassed).
 */

import http       from "node:http";
import { Worker } from "node:worker_threads";

import { parseArgs } from "../lib/cli/parseArgs.js";

const { prepareLaneDatabase, dropLaneDatabase } = await import("../tests/db-concurrency/_harness.js");

const args        = parseArgs(process.argv.slice(2));
const concurrency = Number(args.concurrency ?? 50);
const rounds      = Number(args.rounds ?? 10);
const keyCount    = Number(args.keys ?? 1);

await prepareLaneDatabase();

const { shutdownPool }                                       = await import("../lib/tools/db.js");
const { createApiKey }                                       = await import("../lib/admin/ApiKeyStore.js");
const { createHookHandler, HOOK_HANDLER_DEFAULTS }           = await import("../lib/handlers/hook-handler.js");
const { RateLimiter }                                        = await import("../lib/rate-limiter.js");

/** 백분위(가장 가까운 순위) */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(1));
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: percentile(sorted, 100) };
}

const phases = { auth: [], admission: [], enqueue: [] };

/** 단계 시간을 재는 감싸기 */
function timed(name, fn) {
  return async (...a) => {
    const started = performance.now();
    try {
      return await fn(...a);
    } finally {
      phases[name].push(performance.now() - started);
    }
  };
}

/** 별도 스레드의 부하 생성기. 라운드마다 concurrency개를 동시에 보내고 응답 시간을 돌려준다. */
const LOAD_SCRIPT = `
const { parentPort, workerData } = require("node:worker_threads");
const http = require("node:http");
const { url, keys, concurrency, rounds, warmup, sequential } = workerData;
const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
let seq = 0;
function once(i) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ session_id: "lat-" + (seq++), excerpt: "[user]\\n질문 " + i + "\\n\\n[assistant]\\n" + "작업을 마쳤다. ".repeat(200) });
    const started = performance.now();
    const req = http.request(url, { method: "POST", agent, headers: {
      "Content-Type": "application/json", Authorization: "Bearer " + keys[i % keys.length], "Content-Length": Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on("end", () => resolve({ ms: performance.now() - started, status: res.statusCode })); });
    req.on("error", reject);
    req.end(body);
  });
}
(async () => {
  const round = () => Promise.all(Array.from({ length: concurrency }, (_, i) => once(i)));
  for (let r = 0; r < warmup; r++) await round();
  parentPort.postMessage({ type: "warm" });
  const seqResults = [];
  for (let i = 0; i < sequential; i++) seqResults.push(await once(i));
  parentPort.postMessage({ type: "sequential", results: seqResults });
  const results = [];
  for (let r = 0; r < rounds; r++) results.push(...await round());
  agent.destroy();
  parentPort.postMessage({ type: "done", results });
})().catch((err) => parentPort.postMessage({ type: "error", message: err.message }));
`;

let server;
let pendingCapBypassed = false;
try {
  const keys = [];
  for (let i = 0; i < keyCount; i++) {
    keys.push((await createApiKey({ name: `lane-hook-${Date.now()}-${i}`, permissions: ["read", "write"], daily_limit: 1_000_000 })).raw_key);
  }
  const perKey             = Math.ceil(((2 + rounds) * concurrency + 50) / keyCount);
  pendingCapBypassed       = perKey >= 500;
  const admission          = pendingCapBypassed
    ? async (a) => ({ ...(await HOOK_HANDLER_DEFAULTS.admission(a)), pending: 0 })
    : HOOK_HANDLER_DEFAULTS.admission;
  const handler = createHookHandler({
    authenticate: timed("auth", HOOK_HANDLER_DEFAULTS.authenticate),
    admission   : timed("admission", admission),
    enqueue     : timed("enqueue", HOOK_HANDLER_DEFAULTS.enqueue),
    limiters    : {
      key    : new RateLimiter({ windowMs: 60_000, maxRequests: 1e9 }),
      failure: new RateLimiter({ windowMs: 60_000, maxRequests: 1e9 })
    }
  });
  server = http.createServer((req, res) => {
    handler(req, res, { pathname: new URL(req.url, "http://localhost").pathname });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/hooks/codex/Stop`;

  const worker = new Worker(LOAD_SCRIPT, { eval: true, workerData: { url, keys, concurrency, rounds, warmup: 2, sequential: 50 } });
  const output = await new Promise((resolve, reject) => {
    const collected = {};
    worker.on("message", (msg) => {
      if (msg.type === "warm") for (const list of Object.values(phases)) list.length = 0;
      if (msg.type === "sequential") {
        collected.sequential = msg.results;
        for (const list of Object.values(phases)) list.length = 0;
      }
      if (msg.type === "done") resolve({ ...collected, concurrent: msg.results });
      if (msg.type === "error") reject(new Error(msg.message));
    });
    worker.on("error", reject);
  });
  await worker.terminate();

  const statuses = output.concurrent.reduce((acc, { status }) => ({ ...acc, [status]: (acc[status] ?? 0) + 1 }), {});
  console.log(JSON.stringify({
    concurrency, rounds, keys: keyCount, pendingCapBypassed, statuses,
    concurrent: summary(output.concurrent.map(r => r.ms)),
    sequential: summary(output.sequential.map(r => r.ms)),
    phases    : Object.fromEntries(Object.entries(phases).map(([name, list]) => [name, summary(list)]))
  }, null, 2));
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await shutdownPool();
  await dropLaneDatabase();
}
