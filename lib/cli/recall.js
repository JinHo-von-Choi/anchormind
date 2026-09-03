/**
 * CLI: recall - 터미널에서 파편 검색
 *
 * 작성자: 최진호
 * 작성일: 2026-03-28
 * 수정일: 2026-04-20 (usage export, --format table|json|csv, --remote 원격 모드)
 */

import { MemoryManager }  from "../memory/MemoryManager.js";
import { shutdownPool }   from "../tools/db.js";
import { resolveFormat, renderTable, renderJson, renderCsv } from "./_format.js";
import { McpClient }      from "./_mcpClient.js";

export const usage = [
  "Usage: memento-mcp recall <query> [options]",
  "",
  "Search memory fragments from the terminal.",
  "",
  "Options:",
  "  --topic <name>            Filter by topic",
  "  --type <type>             Filter by fragment type (fact|decision|error|preference|procedure|relation)",
  "  --limit <n>               Max results (default: 10)",
  "  --time-range <from,to>    ISO date range, e.g. 2026-01-01,2026-04-20",
  "  --workspace <name>        Search this workspace plus global fragments",
  "  --all-workspaces          Master-only explicit cross-workspace search",
  "  --format table|json|csv   Output format (default: table if TTY, json otherwise)",
  "  --json                    Shorthand for --format json",
  "  --remote <URL>            MCP 원격 서버 URL (env: MEMENTO_CLI_REMOTE)",
  "  --key <KEY>               API 키 Bearer 토큰 (env: MEMENTO_CLI_KEY)",
  "  --timeout <ms>            원격 요청 타임아웃 밀리초 (default: 30000)",
  "",
  "Examples:",
  "  memento-mcp recall nginx ssl",
  "  memento-mcp recall auth --topic backend --limit 5",
  "  memento-mcp recall deploy --format csv",
  "  memento-mcp recall nginx --remote https://memento.anchormind.net/mcp --key mmcp_xxx",
].join("\n");

export default async function recall(args) {
  const query = args._.join(" ");
  if (!query) {
    console.error("Usage: memento recall <query> [--topic x] [--limit n] [--time-range from,to] [--json]");
    process.exit(1);
  }

  const remoteUrl = args.remote || process.env.MEMENTO_CLI_REMOTE;
  const remoteKey = args.key    || process.env.MEMENTO_CLI_KEY;

  if (remoteUrl && !remoteKey) {
    console.error("--remote 사용 시 --key <API_KEY> 또는 MEMENTO_CLI_KEY 환경변수가 필요합니다.");
    process.exit(1);
  }

  const limit = args.limit ? parseInt(args.limit, 10) : 10;

  const params = {
    text        : query,
    keywords    : query.split(/\s+/),
    topic       : args.topic || undefined,
    type        : args.type  || undefined,
    tokenBudget : limit * 200,
    pageSize    : limit,
    workspace   : args.workspace || undefined,
    allWorkspaces: args["all-workspaces"] === true,
  };

  if (args["time-range"]) {
    const [from, to] = args["time-range"].split(",");
    params.timeRange = { from: from.trim(), to: to ? to.trim() : undefined };
  }

  let result;

  if (remoteUrl) {
    const timeoutMs = args.timeout ? parseInt(args.timeout, 10) : undefined;
    const client    = new McpClient(remoteUrl, remoteKey, { timeoutMs });
    result = await client.call("recall", params);
  } else {
    const mgr = MemoryManager.create();
    try {
      result = await mgr.recall(params);
    } finally {
      shutdownPool().catch(() => {});
      setTimeout(() => process.exit(0), 500);
    }
  }

  try {
    const fmt = resolveFormat(args);

    if (fmt === "json") {
      console.log(renderJson(result));
      return;
    }

    if (!result.fragments || result.fragments.length === 0) {
      if (fmt === "csv") {
        console.log("idx,id,content,topic,type,importance,confidence,age_days,access");
      } else {
        const topicLabel = params.topic ? `, topic: ${params.topic}` : "";
        console.log(`Recall: "${query}" (limit: ${limit}${topicLabel})`);
        console.log("(no results)");
      }
      return;
    }

    const tableRows = result.fragments.map((f, i) => ({
      idx        : i + 1,
      id         : (f.id || "").slice(0, 16) + "...",
      content    : (f.content || "").slice(0, 60),
      topic      : f.topic      || "--",
      type       : f.type       || "--",
      importance : f.importance !== undefined ? String(f.importance) : "--",
      confidence : f.similarity !== undefined ? f.similarity.toFixed(2) : "--",
      age_days   : f.created_at
        ? String(Math.floor((Date.now() - new Date(f.created_at).getTime()) / 86400000))
        : "?",
      access     : String(f.access_count ?? 0),
    }));

    const COLUMNS = ["idx", "id", "content", "topic", "type", "importance", "confidence", "age_days", "access"];

    if (fmt === "csv") {
      console.log(renderCsv(tableRows, COLUMNS));
      return;
    }

    const topicLabel = params.topic ? `, topic: ${params.topic}` : "";
    console.log(`Recall: "${query}" (limit: ${limit}${topicLabel})`);
    console.log(renderTable(tableRows, COLUMNS));

    if (result.hasMore) {
      console.log(`\n... ${result.totalCount - result.count} more results (total: ${result.totalCount})`);
    }
  } catch (err) {
    console.error(`[recall] ${err.message}`);
    process.exit(1);
  }
}
