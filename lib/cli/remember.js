/**
 * CLI: remember - 터미널에서 파편 저장
 *
 * MemoryManager는 Redis/EmbeddingWorker 등 서버 컴포넌트를 초기화하여
 * CLI에서 프로세스가 종료되지 않는 문제가 있다.
 * 로컬 모드: FragmentFactory + FragmentWriter로 직접 DB INSERT.
 * 원격 모드: MCP remember 도구 호출.
 *
 * 작성자: 최진호
 * 작성일: 2026-03-28
 * 수정일: 2026-04-20 (--remote 원격 모드, --stdin 파이프 입력)
 */

import pg from "pg";
import { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD } from "../config.js";
import { FragmentFactory } from "../memory/write/FragmentFactory.js";
import { McpClient }       from "./_mcpClient.js";
import { readStdin }       from "./_stdin.js";

const VALID_TYPES = new Set(["fact", "decision", "error", "preference", "procedure", "relation"]);

export const usage = [
  "Usage: memento-mcp remember <content> --topic <name> [options]",
  "       memento-mcp remember --stdin --topic <name> [options]",
  "       echo 'content' | memento-mcp remember --topic <name> [options]",
  "",
  "Store a memory fragment directly from the terminal.",
  "",
  "Options:",
  "  --topic <name>        Topic label (required in local mode)",
  "  --type <type>         Fragment type: fact|decision|error|preference|procedure|relation (default: fact)",
  "  --importance <0-1>    Importance score (default: auto from type)",
  "  --keywords <a,b,c>    Comma-separated keywords",
  "  --source <name>       Source label (default: cli)",
  "  --stdin               Read content from stdin (auto-detected when not a TTY)",
  "  --json                Output result as JSON",
  "  --remote <URL>        MCP 원격 서버 URL (env: MEMENTO_CLI_REMOTE)",
  "  --key <KEY>           API 키 Bearer 토큰 (env: MEMENTO_CLI_KEY)",
  "  --timeout <ms>        원격 요청 타임아웃 밀리초 (default: 30000)",
  "",
  "stdin rules:",
  "  - Use positional argument OR stdin, not both.",
  "  - Empty stdin is an error.",
  "  - Max stdin size: 1MB.",
  "",
  "Examples:",
  "  memento-mcp remember 'Redis port is 6380' --topic infra --type fact",
  "  memento-mcp remember 'Use bcrypt rounds=12' --topic security --type decision --importance 0.8",
  "  cat note.txt | memento-mcp remember --topic docs --type procedure",
  "  memento-mcp remember --stdin --topic ops < fix.txt",
  "  memento-mcp remember 'nginx restart fixed' --topic ops --remote https://memento.anchormind.net/mcp --key mmcp_xxx",
].join("\n");

export default async function remember(args) {
  const remoteUrl     = args.remote || process.env.MEMENTO_CLI_REMOTE;
  const remoteKey     = args.key    || process.env.MEMENTO_CLI_KEY;
  const positional    = args._.join(" ").trim();
  const useStdin      = args.stdin === true || process.stdin.isTTY === false;

  /** positional 인자와 stdin 동시 제공 충돌 */
  if (positional && useStdin && args.stdin === true) {
    console.error("Error: use positional or stdin, not both.");
    process.exit(1);
  }

  let content = positional;

  /** stdin 경로 */
  if (!content && useStdin) {
    try {
      content = await readStdin();
    } catch (err) {
      console.error(`[remember] ${err.message}`);
      process.exit(1);
    }
  }

  /** content 미제공 */
  if (!content || !content.trim()) {
    console.error("Usage: memento remember <content> --topic x [--type fact] [--importance 0.7] [--json]");
    process.exit(1);
  }

  content = content.trim();

  if (remoteUrl && !remoteKey) {
    console.error("--remote 사용 시 --key <API_KEY> 또는 MEMENTO_CLI_KEY 환경변수가 필요합니다.");
    process.exit(1);
  }

  const type = args.type || "fact";
  if (!VALID_TYPES.has(type)) {
    console.error(`Invalid type: ${type}. Valid: ${[...VALID_TYPES].join(", ")}`);
    process.exit(1);
  }

  /** 원격 모드 */
  if (remoteUrl) {
    if (!args.topic) {
      console.error("--topic <name> 이 필요합니다.");
      process.exit(1);
    }
    const timeoutMs   = args.timeout ? parseInt(args.timeout, 10) : undefined;
    const client      = new McpClient(remoteUrl, remoteKey, { timeoutMs });
    const toolArgs    = {
      content,
      topic      : args.topic,
      type,
      importance : args.importance ? parseFloat(args.importance) : undefined,
      keywords   : args.keywords   ? args.keywords.split(",").map(k => k.trim()) : undefined,
      source     : args.source     || "cli",
    };

    try {
      const result = await client.call("remember", toolArgs);
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const id = result.id ?? result.fragment?.id ?? "(unknown)";
        console.log("Fragment stored (remote)");
        console.log("========================");
        console.log(`ID:    ${id}`);
        console.log(`Type:  ${type}`);
        console.log(`Topic: ${args.topic}`);
      }
    } catch (err) {
      console.error(`[remember] ${err.message}`);
      process.exit(1);
    }
    return;
  }

  /** 로컬 모드 — 직접 DB INSERT */
  if (!args.topic) {
    console.error("Usage: memento remember <content> --topic x [--type fact] [--importance 0.7] [--json]");
    process.exit(1);
  }

  const pool = new pg.Pool({
    host: DB_HOST, port: DB_PORT, database: DB_NAME,
    user: DB_USER, password: DB_PASSWORD, max: 2
  });

  try {
    const factory  = new FragmentFactory();
    const fragment = factory.create({
      content,
      topic:      args.topic,
      type,
      importance: args.importance ? parseFloat(args.importance) : undefined,
      keywords:   args.keywords  ? args.keywords.split(",").map(k => k.trim()) : undefined,
      source:     args.source    || "cli",
      agentId:    "cli",
    });

    await pool.query("SET search_path TO agent_memory, public");
    await pool.query(
      `INSERT INTO fragments
        (id, content, topic, keywords, type, importance, content_hash, ttl_tier, source, agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        fragment.id, fragment.content, fragment.topic,
        fragment.keywords, fragment.type, fragment.importance,
        fragment.content_hash, fragment.ttl_tier || "warm",
        fragment.source || "cli", fragment.agent_id || "cli"
      ]
    );

    if (args.json) {
      console.log(JSON.stringify({ success: true, id: fragment.id, keywords: fragment.keywords, type: fragment.type, importance: fragment.importance }, null, 2));
    } else {
      console.log("Fragment stored");
      console.log("===============");
      console.log(`ID:         ${fragment.id}`);
      console.log(`Keywords:   ${(fragment.keywords || []).join(", ")}`);
      console.log(`Type:       ${fragment.type}`);
      console.log(`Importance: ${fragment.importance}`);
      console.log(`TTL tier:   ${fragment.ttl_tier || "warm"}`);

      if (fragment.importance < 0.3) {
        console.log(`\nWarning: low importance (${fragment.importance}) — may be garbage collected early.`);
      }
    }
  } catch (err) {
    console.error(`[remember] ${err.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}
