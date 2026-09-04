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
  "  --include-peer-agents     Master-only: include all agents within key/workspace scope",
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

const GLOBAL_ONLY_EMPTY_HINT =
  "전역(workspace 없음) 범위에서만 검색했으며 결과가 없습니다. " +
  "workspace별로 저장한 기억을 찾으려면 --workspace <name>을 지정해 다시 검색하세요.";

/**
 * 원격 응답의 서버 힌트를 우선 사용하고, 로컬 global-only 조회에는 같은 취지의
 * CLI 안내를 제공한다. CSV에서는 stdout 형식을 보존하기 위해 호출부가 stderr로
 * 출력한다.
 */
export function resolveEmptyRecallHint(result, params = {}) {
  const serverHint = result?._meta?.hints?.find(
    hint => typeof hint?.suggestion === "string" && hint.suggestion.trim()
  );
  if (serverHint) return serverHint.suggestion;

  if (params.allWorkspaces !== true && !params.workspace) {
    return GLOBAL_ONLY_EMPTY_HINT;
  }
  return null;
}

/** 로컬 JSON 출력에도 서버 응답과 같은 최소 `_meta.hints` 형태를 보충한다. */
export function attachEmptyRecallHint(result, params = {}) {
  if (Array.isArray(result?.fragments) && result.fragments.length > 0) return result;
  if (result?._meta?.hints?.length) return result;

  const suggestion = resolveEmptyRecallHint(result, params);
  if (!suggestion) return result;

  return {
    ...(result ?? {}),
    _meta: {
      ...(result?._meta ?? {}),
      hints: [{ signal: "no_results", suggestion, trigger: "recall" }]
    }
  };
}

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
    includePeerAgents: args["include-peer-agents"] === true,
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
      /** 로컬 CLI는 서버 인증 세션이 없으므로 명시적으로 로컬 master 진입점임을 표시한다. */
      params._isMaster = true;
      result = await mgr.recall(params);
    } finally {
      shutdownPool().catch(() => {});
      setTimeout(() => process.exit(0), 500);
    }
  }

  try {
    const fmt = resolveFormat(args);

    if (fmt === "json") {
      console.log(renderJson(attachEmptyRecallHint(result, params)));
      return;
    }

    if (!result.fragments || result.fragments.length === 0) {
      const emptyHint = resolveEmptyRecallHint(result, params);
      if (fmt === "csv") {
        console.log("idx,id,content,topic,type,importance,confidence,age_days,access");
        if (emptyHint) console.error(`[hint] ${emptyHint}`);
      } else {
        const topicLabel = params.topic ? `, topic: ${params.topic}` : "";
        console.log(`Recall: "${query}" (limit: ${limit}${topicLabel})`);
        console.log("(no results)");
        if (emptyHint) console.log(`[hint] ${emptyHint}`);
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
