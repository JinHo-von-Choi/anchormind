#!/usr/bin/env node
/**
 * recall-scale.mjs - 파편 수에 따른 recall 지연 측정
 *
 * 작성자: 최진호
 * 작성일: 2026-10-12
 *
 * 일회용 DB에 합성 파편을 단계별 개수(--sizes)까지 채우고, 단계마다 tool_recall 전 경로(검색, 상태 표지,
 * 근거 상태, 묶음 요약 조회 포함)의 지연을 질의 유형별로 잰다. 임베딩 없이 돌므로 L3 의미 검색은 재지 않는다.
 *
 *   keywords        keywords 하나로 찾는 질의
 *   topic_event     topic과 timeRange basis=event로 찾는 질의(세계 시각 색인 경로)
 *   topic_history   topic, intent=state(이전 값 포함)로 찾는 질의
 *
 * 대상은 --database-url로만 받으며 로컬 호스트가 아니면 거부한다. 운영 DB에 쓰지 않는다.
 * 합성 파편은 workspace "scale-bench"에 두고 끝나면 지운다(--keep이면 남긴다).
 *
 * 사용: node scripts/measure/recall-scale.mjs --database-url postgresql://memento:memento_test@localhost:35433/memento_test \
 *         [--sizes 10000,100000] [--queries 100] [--keep]
 * 출력: 단계와 질의 유형별 { size, kind, n, p50, p95, max } JSON 한 줄씩
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const WORKSPACE   = "scale-bench";
const TOPICS      = 200;
const KEYWORDS    = 2000;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const url = arg("database-url", null);
if (!url) {
  console.error("--database-url이 필요하다");
  process.exit(2);
}
const parsed = new URL(url);
if (!LOCAL_HOSTS.has(parsed.hostname)) {
  console.error(`로컬 호스트가 아닌 대상은 거부한다: ${parsed.hostname}`);
  process.exit(2);
}

process.env.DATABASE_URL      = url;
process.env.POSTGRES_HOST     = parsed.hostname;
process.env.POSTGRES_PORT     = parsed.port || "5432";
process.env.POSTGRES_DB       = parsed.pathname.slice(1);
process.env.POSTGRES_USER     = decodeURIComponent(parsed.username);
process.env.POSTGRES_PASSWORD = decodeURIComponent(parsed.password);
process.env.REDIS_ENABLED     = "false";
process.env.CACHE_ENABLED     = "false";
process.env.EMBEDDING_ENABLED = "false";
process.env.MEMENTO_METRICS_DEFAULT = "off";

const sizes   = String(arg("sizes", "10000,100000")).split(",").map(Number).filter(n => n > 0).sort((a, b) => a - b);
const queries = Number(arg("queries", "100"));
const keep    = process.argv.includes("--keep");

const { getPrimaryPool } = await import("../../lib/tools/db.js");
const { tool_recall }    = await import("../../lib/tools/memory.js");
const pool = getPrimaryPool();

/** 현재 개수에서 target까지 합성 파편을 채운다 */
async function seedTo(target) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM agent_memory.fragments WHERE workspace = $1`, [WORKSPACE]);
  const have = rows[0].n;
  if (have >= target) return;
  await pool.query(
    `INSERT INTO agent_memory.fragments
            (id, content, topic, keywords, type, importance, content_hash, agent_id, workspace,
             created_at, mention_time, event_time, event_time_precision)
     SELECT 'scale-' || g,
            'scale fact ' || g || ' about item ' || (g % $3) || ' value ' || (g * 7 % 1000),
            'scale-topic-' || (g % $4),
            ARRAY['scale-kw-' || (g % $3), 'scale'],
            CASE WHEN g % 10 = 0 THEN 'preference' ELSE 'fact' END,
            0.5,
            md5('scale-' || g),
            'default',
            $5,
            NOW() - make_interval(secs => g),
            TIMESTAMPTZ '2023-01-01' + make_interval(days => (g % 1000)),
            CASE WHEN g % 3 = 0 THEN TIMESTAMPTZ '2023-01-01' + make_interval(days => (g % 1000) - 5) END,
            CASE WHEN g % 3 = 0 THEN 'day' END
       FROM generate_series($1::int + 1, $2::int) AS g`,
    [have, target, KEYWORDS, TOPICS, WORKSPACE]
  );
  /** 이전 값 경로를 재도록 topic마다 대체 링크 하나를 둔다 */
  await pool.query(
    `INSERT INTO agent_memory.fragment_links (from_id, to_id, relation_type)
     SELECT 'scale-' || g, 'scale-' || (g + $1), 'superseded_by'
       FROM generate_series($2::int + 1, LEAST($2::int + $1, $3::int - $1)) AS g
     ON CONFLICT DO NOTHING`,
    [TOPICS, have, target]
  );
  await pool.query(`ANALYZE agent_memory.fragments`);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

async function measure(size, kind, makeArgs) {
  const times = [];
  for (let i = 0; i < queries; i++) {
    const start = process.hrtime.bigint();
    const res   = await tool_recall({ workspace: WORKSPACE, tokenBudget: 2000, ...makeArgs(i) });
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
    if (res.success !== true) throw new Error(`recall 실패(${kind}): ${res.error}`);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({
    size, kind, n: times.length,
    p50: +percentile(times, 0.5).toFixed(1), p95: +percentile(times, 0.95).toFixed(1), max: +times.at(-1).toFixed(1)
  }));
}

try {
  for (const size of sizes) {
    await seedTo(size);
    await measure(size, "keywords", i => ({ keywords: [`scale-kw-${(i * 37) % KEYWORDS}`] }));
    await measure(size, "topic_event", i => ({
      topic: `scale-topic-${(i * 13) % TOPICS}`,
      timeRange: { from: "2023-06-01", to: "2024-06-01", basis: "event" }
    }));
    await measure(size, "topic_history", i => ({ topic: `scale-topic-${(i * 17) % TOPICS}`, intent: "state" }));
  }
} finally {
  if (!keep) {
    await pool.query(`DELETE FROM agent_memory.fragment_links WHERE from_id LIKE 'scale-%' OR to_id LIKE 'scale-%'`);
    await pool.query(`DELETE FROM agent_memory.fragments WHERE workspace = $1`, [WORKSPACE]);
  }
  await pool.end?.();
}
process.exit(0);
