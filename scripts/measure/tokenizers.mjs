#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import Redis from "ioredis";
import { McpClient } from "../../lib/cli/_mcpClient.js";
import { parseArgs } from "../../lib/cli/parseArgs.js";
import { createIsolatedLaneDatabase } from "../../tests/db-concurrency/_harness.js";
import { runWithConcurrency } from "./recall-metrics.mjs";

const MODES = {
  base: ["js", "wasm"], bpe: ["native", "wasm"], garu: ["js", "native"], both: ["native", "native"]
};
const PHRASES = [
  "앵커마인드는 기억 파편을 저장하고 검색할 때 한글 형태소와 기술 용어를 분석한다. ",
  "검색 결과에 포함된 파편의 출처와 유효 시간을 확인하고 색인 설정을 조정한다. ",
  "저장에 앞서 요청을 검증하고 읽기 작업의 응답 시간을 지속해서 관찰한다. "
];
const MORPHEME_TERMS = ["형태소", "기술", "검색", "유효", "출처", "저장", "관찰", "설정"];
const EMBEDDING_VARS = ["EMBEDDING_PROVIDER", "EMBEDDING_API_KEY", "EMBEDDING_BASE_URL", "EMBEDDING_MODEL", "EMBEDDING_DIMENSIONS"];
const WORKSPACE = "/benchmark/tokenizers";
const PARITY_WORKSPACE = "/benchmark/tokenizer-parity";
const PARITY_TOPIC = "배포 호환성 검증";
const PARITY_FRAGMENTS = [
  { type: "decision", importance: 0.95, content: "배포 호환성 검증에서 한글 형태소와 저장 토큰 수를 확인한다." },
  { type: "decision", importance: 0.7, content: "배포 호환성 검증에서 검색 결과와 응답 순서를 비교한다." },
  { type: "decision", importance: 0.5, content: "배포 호환성 검증에서 컨텍스트 예산과 이전 기록을 점검한다." }
];
const ANCHOR_TEXT = "검색 성능 검증에서 사용하는 기준 파편이다. 검증용고정문장으로 찾을 수 있다.";
const USAGE = "Usage: node scripts/measure/tokenizers.mjs [--mode all|base|bpe|garu|both] " +
  "[--rounds 1..4] [--language ko|mixed] [--redis-port PORT] [--embeddings]";

function options(argv) {
  const args = parseArgs(argv);
  const mode = args.mode ?? "all";
  const rounds = Number(args.rounds ?? 3);
  const language = args.language ?? "ko";
  const redisPort = Number(args["redis-port"] ?? 0);
  assert.ok(mode === "all" || Object.hasOwn(MODES, mode), "mode must be all, base, bpe, garu, or both");
  assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 4, "rounds must be between 1 and 4");
  assert.ok(["ko", "mixed"].includes(language), "language must be ko or mixed");
  assert.ok(Number.isInteger(redisPort) && redisPort >= 0 && redisPort <= 65535 && redisPort !== 6379,
    "use an isolated Redis with a non-default port, or omit --redis-port");
  return { mode, rounds, language, redisPort, embeddings: args.embeddings === true };
}

function childEnv(opts, mode, logDir, accessKey, redisDb, db) {
  const env = {
    PATH: process.env.PATH, LOG_DIR: logDir, LOG_LEVEL: "error", MEMENTO_LOG_STDERR: "true",
    DOTENV_CONFIG_PATH: path.join(logDir, "dotenv-disabled"),
    PORT: "0", MEMENTO_BIND_HOST: "127.0.0.1", MEMENTO_ACCESS_KEY: accessKey,
    PGSSLMODE: "disable", MEMENTO_METRICS_DEFAULT: "on",
    MEMENTO_TOKEN_COUNTER: MODES[mode][0], MEMENTO_GARU_BACKEND: MODES[mode][1],
    REDIS_ENABLED: String(Boolean(opts.redisPort)), REDIS_HOST: "127.0.0.1",
    REDIS_PORT: String(opts.redisPort || 6379), REDIS_DB: String(redisDb),
    RATE_LIMIT_PER_IP: "5000", UPDATE_CHECK_DISABLED: "true",
    POSTGRES_HOST: db.host, POSTGRES_PORT: String(db.port), POSTGRES_DB: db.database,
    POSTGRES_USER: db.user, POSTGRES_PASSWORD: db.password
  };
  if (opts.embeddings) for (const key of EMBEDDING_VARS) env[key] = process.env[key];
  assert.ok(!opts.embeddings || env.EMBEDDING_API_KEY || env.EMBEDDING_BASE_URL || env.EMBEDDING_PROVIDER === "transformers",
    "supply an explicit embedding provider or endpoint with --embeddings");
  return env;
}

async function requireEmptyRedis(port, db) {
  if (!port) return;
  const redis = new Redis({ host: "127.0.0.1", port, db, connectTimeout: 2000, maxRetriesPerRequest: 0, retryStrategy: () => null });
  try {
    assert.equal(await redis.dbsize(), 0, `isolated Redis database ${db} must be empty`);
  } finally {
    redis.disconnect();
  }
}

async function serverOrigin(child) {
  const lines = createInterface({ input: child.stdout });
  const deadline = AbortSignal.timeout(30_000);
  const stop = () => lines.close();
  deadline.addEventListener("abort", stop, { once: true });
  try {
    for await (const line of lines) {
      const match = /HTTP server listening on 127\.0\.0\.1 port (\d+)/.exec(line);
      if (match) return `http://127.0.0.1:${match[1]}`;
    }
    throw new Error("Benchmark server did not start listening");
  } finally {
    deadline.removeEventListener("abort", stop);
    lines.close();
    child.stdout.resume();
  }
}

function fragment(i, language) {
  const prefix = `문서 ${i} ${MORPHEME_TERMS[i % MORPHEME_TERMS.length]} `;
  const phrase = PHRASES[i % PHRASES.length];
  const body = language === "mixed" ? `${phrase} PostgreSQL searchIndex cache · 設定と検索 · 索引设置. ` : phrase;
  return { type: "fact", topic: "성능 측정", content: (prefix + body.repeat(8)).slice(0, 280), keywords: ["성능측정"] };
}

async function checked(client, name, input) {
  const result = await client.call(name, { workspace: WORKSPACE, ...input });
  assert.equal(result.success, true, JSON.stringify({ tool: name, error: result.error }));
  return result;
}

async function latencies(items, concurrency, call) {
  const values = await runWithConcurrency(items, concurrency, async item => {
    const start = performance.now();
    await call(item);
    return performance.now() - start;
  });
  values.sort((a, b) => a - b);
  const percentile = p => Number(values[Math.ceil(values.length * p) - 1].toFixed(2));
  return { n: values.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) };
}

async function fetchMetrics(origin, key) {
  const res = await fetch(`${origin}/metrics`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
  assert.ok(res.ok, `metrics returned HTTP ${res.status}`);
  const metrics = new Map();
  for (const line of (await res.text()).split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [name, value] = line.split(/\s+/);
    metrics.set(name, Number(value));
  }
  return metrics;
}

async function workload(origin, accessKey, mode, language) {
  const client = new McpClient(`${origin}/mcp`, accessKey);
  const batch = async i => {
    const fragments = Array.from({ length: 10 }, (_, offset) => fragment(i * 10 + offset, language));
    assert.equal((await checked(client, "batch_remember", { fragments })).inserted, fragments.length);
  };
  const recall = text => checked(client, "recall", { text, pageSize: 5, excludeSeen: false });
  const context = () => checked(client, "context", { structured: true, tokenBudget: 400 });
  await checked(client, "remember", { content: ANCHOR_TEXT, topic: "성능 측정", keywords: ["검증용고정문장"] });
  for (let i = 1; i <= 6; i++) await batch(i);
  assert.ok((await recall("검증용고정문장 위치")).fragments.some(row => row.content === ANCHOR_TEXT));
  await context();
  const before = await fetchMetrics(origin, accessKey);
  for (const [i, name] of ["cl100k", "garu"].entries()) {
    assert.equal(before.get(`memento_tokenizer_native_active{tokenizer="${name}"}`), Number(MODES[mode][i] === "native"));
  }
  const start = performance.now();
  const [batchMs, recallMs, contextMs] = await Promise.all([
    latencies(Array.from({ length: 36 }, (_, i) => i + 7), 2, batch),
    latencies(Array.from({ length: 144 }, (_, i) => MORPHEME_TERMS[i % MORPHEME_TERMS.length]), 4, recall),
    latencies(Array.from({ length: 18 }), 1, context)
  ]);
  const seconds = (performance.now() - start) / 1000;
  const after = await fetchMetrics(origin, accessKey);
  for (const [name, value] of after) if (name.startsWith("memento_tokenizer_fallback_total{")) assert.equal(value, 0, name);
  return { batchMs, recallMs, contextMs, requestsPerSecond: (batchMs.n + recallMs.n + contextMs.n) / seconds,
    eventLoopP99Ms: after.get("mcp_nodejs_eventloop_lag_p99_seconds") * 1000,
    cpuSeconds: after.get("mcp_process_cpu_seconds_total") - before.get("mcp_process_cpu_seconds_total"),
    rssBytes: after.get("mcp_process_resident_memory_bytes") };
}

function parityView(fragments, result) {
  assert.equal(result.count, fragments.length);
  assert.ok(fragments.length > 0, "parity query returned no fragments");
  return { contents: fragments.map(row => row.content), totalTokens: result.totalTokens, budget: result.budget };
}

async function paritySnapshot(origin, key, db) {
  const client = new McpClient(`${origin}/mcp`, key);
  const scope = { workspace: PARITY_WORKSPACE };
  const fragments = PARITY_FRAGMENTS.map(row => ({ ...row, topic: PARITY_TOPIC, keywords: ["검수기록"] }));
  assert.equal((await checked(client, "batch_remember", { ...scope, fragments })).inserted, fragments.length);
  // Include a pre-existing row whose stored count is unavailable in the read comparison.
  const legacy = await queryLane(db, "UPDATE agent_memory.fragments SET estimated_tokens = NULL WHERE workspace = $1 AND content = $2",
    [PARITY_WORKSPACE, fragments[0].content]);
  assert.equal(legacy.rowCount, 1);

  const snapshots = [];
  for (const tokenBudget of [30, 400]) {
    const recall = await checked(client, "recall", { ...scope, topic: PARITY_TOPIC, text: PARITY_TOPIC, tokenBudget,
      excludeSeen: false, includeLinks: false, pageSize: fragments.length });
    const context = await checked(client, "context", { ...scope, tokenBudget, structured: true, types: ["decision"] });
    snapshots.push({ tokenBudget, recall: parityView(recall.fragments, recall),
      context: { ...parityView(context.fragments, context), injection: context.rankedInjection.items.map(row => row.content) } });
  }
  for (const tool of ["recall", "context"]) {
    assert.deepEqual(new Set(snapshots[1][tool].contents), new Set(fragments.map(row => row.content)));
    assert.ok(snapshots[0][tool].contents.length < snapshots[1][tool].contents.length, `${tool} did not apply the smaller token budget`);
  }
  return snapshots;
}

async function queryLane(db, sql, params) {
  const client = new pg.Client(db);
  await client.connect();
  try { return await client.query(sql, params); } finally { await client.end(); }
}

async function runVariant(opts, mode, redisDb) {
  const logDir = await mkdtemp(path.join(tmpdir(), "anchormind-tokenizers-"));
  let database;
  let child;
  let closed;
  try {
    await requireEmptyRedis(opts.redisPort, redisDb);
    database = await createIsolatedLaneDatabase();
    const db = database.config;
    await queryLane(db, "CREATE INDEX idx_fragments_content_tokens ON agent_memory.fragments USING gin (content_tokens)");
    const key = randomUUID();
    child = spawn(process.execPath, [fileURLToPath(new URL("../../server.js", import.meta.url))], {
      env: childEnv(opts, mode, logDir, key, redisDb, db), stdio: ["ignore", "pipe", "inherit"]
    });
    closed = once(child, "close");
    const origin = await serverOrigin(child);
    const measurements = await workload(origin, key, mode, opts.language);
    const { rows } = await queryLane(db, `SELECT content, estimated_tokens, content_tokens::text
      FROM agent_memory.fragments WHERE workspace = $1 ORDER BY content COLLATE "C"`, [WORKSPACE]);
    assert.equal(rows.length, 421);
    assert.ok(rows.every(row => row.estimated_tokens > 0 && row.content_tokens));
    const readParity = await paritySnapshot(origin, key, db);
    return { mode, ...measurements, storedDigest: createHash("sha256").update(JSON.stringify(rows)).digest("hex"), readParity };
  } finally {
    try {
      if (child) {
        child.kill("SIGTERM");
        const stopped = await Promise.race([closed.then(() => true), setTimeout(10_000, false, { ref: false })]);
        if (!stopped) child.kill("SIGKILL");
        await closed;
      }
    } finally {
      try { await database?.drop(); } finally { await rm(logDir, { recursive: true, force: true }); }
    }
  }
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const opts = options(argv);
const modes = opts.mode === "all" ? Object.keys(MODES) : [opts.mode];
const results = [];
for (let round = 0; round < opts.rounds; round++) {
  const order = round % 2 ? [...modes].reverse() : modes;
  for (const mode of order) {
    results.push({ round: round + 1, ...await runVariant(opts, mode, results.length) });
    console.error(`[tokenizers] round ${round + 1}/${opts.rounds} ${mode} complete`);
  }
}
assert.equal(new Set(results.map(row => row.storedDigest)).size, 1, "persisted tokenizations differ across runs");
for (const row of results) assert.deepEqual(row.readParity, results[0].readParity, `recall/context parity differs for ${row.mode}`);
console.log(JSON.stringify({ ...opts, results }, null, 2));
