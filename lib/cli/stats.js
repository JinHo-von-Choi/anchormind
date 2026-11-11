/**
 * CLI stats 서브커맨드 - 파편 통계 조회
 *
 * 작성자: 최진호
 * 작성일: 2026-03-28
 * 수정일: 2026-04-20 (usage export, --format table|json|csv, --remote 원격 모드)
 */
import pg from 'pg';
import { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD } from '../config.js';
import { resolveFormat, print, renderTable } from './_format.js';
import { McpClient } from './_mcpClient.js';
import { NOT_WM_ROW } from "../memory/WorkingMemorySql.js";

export const usage = [
  "Usage: memento-mcp stats [options]",
  "",
  "Show fragment statistics (counts, top topics, noise ratio).",
  "",
  "Options:",
  "  --format table|json|csv   Output format (default: table if TTY, json otherwise)",
  "  --json                    Shorthand for --format json",
  "  --remote <URL>            MCP 원격 서버 URL (env: MEMENTO_CLI_REMOTE)",
  "  --key <KEY>               API 키 Bearer 토큰 (env: MEMENTO_CLI_KEY)",
  "  --timeout <ms>            원격 요청 타임아웃 밀리초 (default: 30000)",
  "",
  "Examples:",
  "  memento-mcp stats",
  "  memento-mcp stats --format csv",
  "  memento-mcp stats --json",
  "  memento-mcp stats --remote https://memento.anchormind.net/mcp --key mmcp_xxx",
].join("\n");

const SCHEMA = 'agent_memory';

export default async function stats(opts) {
  const remoteUrl = opts.remote || process.env.MEMENTO_CLI_REMOTE;
  const remoteKey = opts.key    || process.env.MEMENTO_CLI_KEY;

  if (remoteUrl && !remoteKey) {
    console.error("--remote 사용 시 --key <API_KEY> 또는 MEMENTO_CLI_KEY 환경변수가 필요합니다.");
    process.exit(1);
  }

  /** 원격 모드 */
  if (remoteUrl) {
    const timeoutMs = opts.timeout ? parseInt(opts.timeout, 10) : undefined;
    const client    = new McpClient(remoteUrl, remoteKey, { timeoutMs });
    try {
      const data = await client.call("memory_stats", {});
      const fmt  = resolveFormat(opts);

      if (fmt === "json") {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      /** table/csv: 플랫 구조로 변환 */
      const summaryRows = Object.entries(data)
        .filter(([, v]) => typeof v !== "object" || v === null)
        .map(([k, v]) => ({ key: k, value: String(v ?? "") }));

      if (fmt === "csv") {
        print(summaryRows, { format: "csv", columns: ["key", "value"] });
        return;
      }

      console.log("Memento MCP Statistics (remote)");
      console.log(renderTable(summaryRows, ["key", "value"]));
    } catch (err) {
      console.error(`[stats] ${err.message}`);
      process.exit(1);
    }
    return;
  }

  /** 로컬 모드 */
  const pool = new pg.Pool({
    host:     DB_HOST,
    port:     DB_PORT,
    database: DB_NAME,
    user:     DB_USER,
    password: DB_PASSWORD,
    max:      2,
  });

  try {
    const [countsRes, topicCountRes, avgUtilRes, noiseRes, topTopicsRes] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int                                          AS total,
          COUNT(*) FILTER (WHERE is_anchor = TRUE)::int         AS anchors,
          COUNT(*) FILTER (WHERE valid_to IS NULL)::int         AS active,
          COUNT(*) FILTER (WHERE valid_to IS NOT NULL)::int     AS expired
        FROM ${SCHEMA}.fragments WHERE ${NOT_WM_ROW}
      `),
      pool.query(`
        SELECT COUNT(DISTINCT topic)::int AS cnt
        FROM ${SCHEMA}.fragments WHERE ${NOT_WM_ROW}
      `),
      pool.query(`
        SELECT COALESCE(ROUND(AVG(utility_score)::numeric, 2), 0) AS avg
        FROM ${SCHEMA}.fragments
        WHERE valid_to IS NULL
      `),
      pool.query(`
        SELECT COUNT(*)::int AS cnt
        FROM ${SCHEMA}.fragments
        WHERE LENGTH(content) < 10 AND ${NOT_WM_ROW}
      `),
      pool.query(`
        SELECT topic, COUNT(*)::int AS cnt
        FROM ${SCHEMA}.fragments WHERE ${NOT_WM_ROW}
        GROUP BY topic
        ORDER BY cnt DESC
        LIMIT 5
      `),
    ]);

    const counts    = countsRes.rows[0];
    const topics    = topicCountRes.rows[0].cnt;
    const avgUtil   = Number(avgUtilRes.rows[0].avg);
    const noiseCount = noiseRes.rows[0].cnt;
    const total     = counts.total || 1;
    const noiseRatio = ((noiseCount / total) * 100).toFixed(1);
    const topTopics = topTopicsRes.rows;

    const data = {
      fragments:     counts.total,
      anchors:       counts.anchors,
      active:        counts.active,
      expired:       counts.expired,
      topics,
      avgUtility:    avgUtil,
      noiseEstimate: { count: noiseCount, ratio: Number(noiseRatio) },
      topTopics:     topTopics.map(r => ({ topic: r.topic, fragments: r.cnt })),
    };

    const fmt = resolveFormat(opts);

    if (fmt === "json") {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (fmt === "csv") {
      // summary rows as key/value pairs for CSV
      const summaryRows = [
        { key: "fragments",    value: data.fragments },
        { key: "anchors",      value: data.anchors },
        { key: "active",       value: data.active },
        { key: "expired",      value: data.expired },
        { key: "topics",       value: data.topics },
        { key: "avgUtility",   value: data.avgUtility },
        { key: "noiseCount",   value: data.noiseEstimate.count },
        { key: "noiseRatio",   value: data.noiseEstimate.ratio },
      ];
      print(summaryRows, { format: "csv", columns: ["key", "value"] });
      return;
    }

    // table: key/value 1열 테이블
    const summaryRows = [
      { key: "Fragments",   value: counts.total.toLocaleString() },
      { key: "  Anchors",   value: counts.anchors.toLocaleString() },
      { key: "  Active",    value: counts.active.toLocaleString() },
      { key: "  Expired",   value: counts.expired.toLocaleString() },
      { key: "Topics",      value: topics.toLocaleString() },
      { key: "Avg utility", value: String(avgUtil) },
      { key: "Noise ratio", value: `${noiseRatio}% (est.)` },
    ];
    console.log("Memento MCP Statistics");
    console.log(renderTable(summaryRows, ["key", "value"]));

    if (topTopics.length > 0) {
      console.log("\nTop 5 topics:");
      const topRows = topTopics.map(r => ({ topic: r.topic, fragments: r.cnt }));
      console.log(renderTable(topRows, ["topic", "fragments"]));
    }
  } finally {
    await pool.end();
  }
}
