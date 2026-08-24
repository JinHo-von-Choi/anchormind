import { createHttpServer } from "../../lib/http-server.js";
import { runAutoReflectFixture } from "../../lib/memory/processors/AutoReflect.js";

const TOKENS = new Map([["pilot-key-a", "key-a"], ["pilot-key-b", "key-b"]]);
const tripwireState = { outside: [], originalFetch: null, previousSpreading: undefined };

export const networkTripwire = {
  callsOutsideLoopback() { return tripwireState.outside.length; },
  attempts() { return [...tripwireState.outside]; }
};

function isLoopback(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "::1" || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

function installTripwire() {
  if (tripwireState.originalFetch) return;
  tripwireState.outside = [];
  tripwireState.previousSpreading = process.env.ENABLE_SPREADING_ACTIVATION;
  process.env.ENABLE_SPREADING_ACTIVATION = "false";
  tripwireState.originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (!isLoopback(url)) {
      tripwireState.outside.push(String(url));
      throw new Error("EXTERNAL_NETWORK_FORBIDDEN");
    }
    return tripwireState.originalFetch(url, options);
  };
}

function restoreTripwire() {
  if (!tripwireState.originalFetch) return;
  globalThis.fetch = tripwireState.originalFetch;
  if (tripwireState.previousSpreading === undefined) delete process.env.ENABLE_SPREADING_ACTIVATION;
  else process.env.ENABLE_SPREADING_ACTIVATION = tripwireState.previousSpreading;
  tripwireState.previousSpreading = undefined;
  tripwireState.originalFetch = null;
}

function exactRows(fixture, scope) {
  return fixture.fragments.filter(row => row.key_id === scope.keyId && row.workspace === scope.workspace);
}

function toolResult(fixture, name, args, tokenKeyId) {
  const scope = { keyId: tokenKeyId, workspace: args.workspace };
  const rows = exactRows(fixture, scope);
  if (name === "recall") return { fragments: rows.filter(row => (args.keywords || []).includes(row.topic)) };
  if (name === "memory_stats") return { stats: { total: rows.length } };
  if (name === "fragment_history") {
    const row = rows.find(candidate => candidate.id === args.id);
    return row ? { success: true, fragment: row } : { success: false, reason: "not_found" };
  }
  throw new Error(`FAKE_TOOL_NOT_IMPLEMENTED:${name}`);
}

export function createSecurityPilotHarness(fixture) {
  let server;
  let baseUrl;
  let closed = false;

  const requestHandler = async (req, res) => {
    if (req.method !== "POST" || new URL(req.url || "/", "http://127.0.0.1").pathname !== "/mcp") {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }
    const authorization = req.headers.authorization || "";
    const token = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] || req.headers["memento-access-key"];
    const tokenKeyId = TOKENS.get(token);
    if (!tokenKeyId) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    let raw = "";
    for await (const chunk of req) raw += chunk;
    const msg = JSON.parse(raw || "null");
    const name = msg?.params?.name;
    const args = msg?.params?.arguments || {};
    const result = toolResult(fixture, name, args, tokenKeyId);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg?.id ?? null, result }));
  };

  return {
    async start() {
      if (server) return { baseUrl };
      installTripwire();
      server = createHttpServer({ requestHandler, host: "127.0.0.1" });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      return { baseUrl, close: this.close };
    },
    async callTool(name, args = {}) {
      if (!baseUrl) await this.start();
      const token = args._keyId === "key-b" ? "pilot-key-b" : "pilot-key-a";
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: { name, arguments: args }
        })
      });
      if (!response.ok) throw new Error(`MCP_${response.status}`);
      const body = await response.json();
      if (body.error) throw new Error(body.error.message || body.error);
      return body.result;
    },
    async close() {
      if (closed) return;
      closed = true;
      restoreTripwire();
      if (server) {
        await new Promise(resolve => server.close(() => resolve()));
        server = null;
      }
    }
  };
}

export { runAutoReflectFixture };
