import { renderJson } from "./_format.js";
import { McpClient } from "./_mcpClient.js";

export const usage = [
  "Usage: memento-mcp context [options]",
  "",
  "Print MCP context as JSON.",
  "",
  "  --view full|index         Full context or compact index (default: full)",
  "  --workspace <name>        Read context in the selected workspace",
  "  --remote <URL>            MCP server URL (env: MEMENTO_CLI_REMOTE)",
  "  --key <KEY>               API key (env: MEMENTO_CLI_KEY)",
  "  --timeout <ms>            Remote request timeout",
].join("\n");

export default async function context(args, defaults = {}) {
  const view = args.view ?? "full";
  if (view !== "full" && view !== "index") throw new Error("--view must be full or index.");
  if (args.workspace !== undefined && typeof args.workspace !== "string") throw new Error("--workspace requires a name.");
  const params = { view, structured: true, workspace: args.workspace };
  const remoteUrl = args.remote || defaults.remote;
  const remoteKey = args.key || defaults.key;

  let result;
  if (remoteUrl) {
    if (typeof remoteKey !== "string" || !remoteKey) throw new Error("--remote requires --key or MEMENTO_CLI_KEY.");
    const timeoutMs = args.timeout === undefined ? undefined : Number(args.timeout);
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)) {
      throw new Error("--timeout must be an integer from 1 to 300000.");
    }
    const client = new McpClient(remoteUrl, remoteKey, { timeoutMs });
    result = await client.call("context", params);
  } else {
    const { MemoryManager } = await import("../memory/MemoryManager.js");
    const { shutdownPool } = await import("../tools/db.js");
    const { closeRedis } = await import("../redis.js");
    try {
      result = await MemoryManager.create().context({ ...params, _isMaster: true });
    } finally {
      await Promise.all([shutdownPool(), closeRedis()]);
    }
  }
  console.log(renderJson(result));
  if (result?.success === false) process.exitCode = 1;
}
