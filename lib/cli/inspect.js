/**
 * CLI: inspect - 파편 상세 + 1-hop 링크 조회
 *
 * MemoryManager 없이 DB 직접 쿼리 (경량).
 * 원격 모드: fragment_history 도구로 상세 조회.
 *
 * 작성자: 최진호
 * 작성일: 2026-03-28
 * 수정일: 2026-04-20 (usage export, --format table|json|csv, --remote 원격 모드)
 */

import { getPrimaryPool, shutdownPool } from "../tools/db.js";
import { resolveFormat, renderTable, renderFieldTable, renderJson, renderCsv } from "./_format.js";
import { McpClient } from "./_mcpClient.js";
import { SCHEMA } from "../memory/schema.js";

export const usage = [
  "Usage: memento-mcp inspect <fragment-id> [options]",
  "",
  "Show a single fragment's fields and 1-hop links.",
  "",
  "Options:",
  "  --format table|json|csv   Output format (default: table if TTY, json otherwise)",
  "  --json                    Shorthand for --format json",
  "  --remote <URL>            MCP 원격 서버 URL (env: MEMENTO_CLI_REMOTE)",
  "  --key <KEY>               API 키 Bearer 토큰 (env: MEMENTO_CLI_KEY)",
  "  --timeout <ms>            원격 요청 타임아웃 밀리초 (default: 30000)",
  "",
  "Examples:",
  "  memento-mcp inspect abc123",
  "  memento-mcp inspect abc123 --json",
  "  memento-mcp inspect abc123 --remote https://memento.anchormind.net/mcp --key mmcp_xxx",
].join("\n");

export default async function inspect(args) {
  const id = args._[0];
  if (!id) {
    console.error("Usage: memento inspect <fragment-id> [--json]");
    process.exit(1);
  }

  const remoteUrl = args.remote || process.env.MEMENTO_CLI_REMOTE;
  const remoteKey = args.key    || process.env.MEMENTO_CLI_KEY;

  if (remoteUrl && !remoteKey) {
    console.error("--remote 사용 시 --key <API_KEY> 또는 MEMENTO_CLI_KEY 환경변수가 필요합니다.");
    process.exit(1);
  }

  /** 원격 모드: fragment_history 도구로 파편 이력 + 링크 조회 */
  if (remoteUrl) {
    const timeoutMs = args.timeout ? parseInt(args.timeout, 10) : undefined;
    const client    = new McpClient(remoteUrl, remoteKey, { timeoutMs });
    try {
      const result = await client.call("fragment_history", { id });
      const fmt    = resolveFormat(args);

      if (fmt === "json") {
        console.log(renderJson(result));
        return;
      }

      /** fragment 필드 테이블 */
      const frag = result.fragment ?? result;
      if (!frag || typeof frag !== "object") {
        console.log(renderJson(result));
        return;
      }

      const fieldObj = Object.fromEntries(
        Object.entries(frag).map(([k, v]) => [
          k,
          Array.isArray(v) ? v.join(", ") : (v === null || v === undefined ? "--" : String(v)),
        ])
      );

      if (fmt === "csv") {
        console.log(renderCsv([fieldObj], Object.keys(fieldObj)));
        return;
      }

      console.log(`Fragment (remote): ${id}`);
      console.log(renderFieldTable(fieldObj));

      const links = result.links ?? [];
      if (links.length > 0) {
        console.log(`\nLinks (${links.length}):`);
        const linkRows = links.map(l => ({
          dir      : l.direction ?? "->",
          peer     : l.to_id ?? l.from_id ?? "--",
          relation : l.relation_type ?? "--",
          weight   : l.weight ?? "--",
          preview  : (l.preview || "").slice(0, 60),
        }));
        console.log(renderTable(linkRows, ["dir", "peer", "relation", "weight", "preview"]));
      } else {
        console.log("\nLinks: (none)");
      }
    } catch (err) {
      console.error(`[inspect] ${err.message}`);
      process.exit(1);
    }
    return;
  }

  /** 로컬 모드 */
  const pool = getPrimaryPool();

  try {
    const fragResult = await pool.query(
      `SELECT id, content, topic, type, importance, utility_score,
              ema_score, access_count, created_at, last_accessed_at,
              is_anchor, ttl_tier, valid_from, valid_to, key_id,
              agent_id, source, keywords, metadata
       FROM ${SCHEMA}.fragments
       WHERE id = $1`,
      [id]
    );

    if (fragResult.rows.length === 0) {
      console.error(`Fragment not found: ${id}`);
      process.exit(1);
    }

    const frag = fragResult.rows[0];

    const outLinks = await pool.query(
      `SELECT fl.to_id, fl.relation_type, fl.weight, LEFT(f.content, 60) AS preview
       FROM ${SCHEMA}.fragment_links fl
       JOIN ${SCHEMA}.fragments f ON f.id = fl.to_id
       WHERE fl.from_id = $1
       ORDER BY fl.weight DESC`,
      [id]
    );

    const inLinks = await pool.query(
      `SELECT fl.from_id, fl.relation_type, fl.weight, LEFT(f.content, 60) AS preview
       FROM ${SCHEMA}.fragment_links fl
       JOIN ${SCHEMA}.fragments f ON f.id = fl.from_id
       WHERE fl.to_id = $1
       ORDER BY fl.weight DESC`,
      [id]
    );

    const payload = {
      fragment : frag,
      outLinks : outLinks.rows,
      inLinks  : inLinks.rows,
    };

    const fmt = resolveFormat(args);

    if (fmt === "json") {
      console.log(renderJson(payload));
      return;
    }

    // 단일 파편 필드 테이블
    const fieldObj = {
      id         : frag.id,
      content    : (frag.content || "").slice(0, 200),
      topic      : frag.topic      || "--",
      type       : frag.type       || "--",
      importance : frag.importance ?? "--",
      utility    : frag.utility_score ?? "--",
      ema        : frag.ema_score  ?? "--",
      access     : frag.access_count ?? 0,
      created    : frag.created_at    ? new Date(frag.created_at).toISOString()    : "--",
      accessed   : frag.last_accessed_at ? new Date(frag.last_accessed_at).toISOString() : "--",
      anchor     : frag.is_anchor   ? "Yes" : "No",
      ttl_tier   : frag.ttl_tier   || "--",
      valid_from : frag.valid_from  ? new Date(frag.valid_from).toISOString()  : "--",
      valid_to   : frag.valid_to    ? new Date(frag.valid_to).toISOString()    : "--",
      key_id     : frag.key_id     || "--",
      agent_id   : frag.agent_id   || "--",
      source     : frag.source     || "--",
      keywords   : Array.isArray(frag.keywords) ? frag.keywords.join(", ") : (frag.keywords || "--"),
    };

    if (fmt === "csv") {
      console.log(renderCsv([fieldObj], Object.keys(fieldObj)));
      return;
    }

    // table
    console.log(`Fragment: ${frag.id}`);
    console.log(renderFieldTable(fieldObj));

    const totalLinks = outLinks.rows.length + inLinks.rows.length;
    if (totalLinks > 0) {
      console.log(`\nLinks (${totalLinks}):`);
      const linkRows = [
        ...outLinks.rows.map(l => ({ dir: "->", peer: l.to_id,   relation: l.relation_type, weight: l.weight ?? "--", preview: l.preview || "" })),
        ...inLinks.rows.map(l  => ({ dir: "<-", peer: l.from_id, relation: l.relation_type, weight: l.weight ?? "--", preview: l.preview || "" })),
      ];
      console.log(renderTable(linkRows, ["dir", "peer", "relation", "weight", "preview"]));
    } else {
      console.log("\nLinks: (none)");
    }
  } finally {
    await shutdownPool();
  }
}
