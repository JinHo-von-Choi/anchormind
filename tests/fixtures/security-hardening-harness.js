import { createRequire } from "node:module";
import { createHttpServer } from "../../lib/http-server.js";
import { handleMcpPost } from "../../lib/handlers/mcp-handler.js";
import { runAutoReflectFixture } from "../../lib/memory/processors/AutoReflect.js";
import { createSecurityPilotFakeAdapters } from "./security-hardening-adapters.js";

const require = createRequire(import.meta.url);
const tripwireState = { outside: [], patches: [], originalFetch: null, previousSpreading: undefined };

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

function hostFromArgs(args) {
  const first = args[0];
  if (typeof first === "string") {
    try { return new URL(first).hostname; } catch { return args[1] || null; }
  }
  if (first && typeof first === "object") return first.hostname || first.host || "127.0.0.1";
  return typeof args[1] === "string" ? args[1] : "127.0.0.1";
}

function guardDestination(kind, args) {
  const host = hostFromArgs(args);
  if (host && !isLoopback(`http://${host}`)) {
    tripwireState.outside.push(`${kind}:${host}`);
    throw new Error("EXTERNAL_NETWORK_FORBIDDEN");
  }
}

function patchMethod(target, name, wrapper) {
  if (!target || typeof target[name] !== "function") return;
  const original = target[name];
  target[name] = wrapper(original);
  tripwireState.patches.push(() => { target[name] = original; });
}

function installTripwire() {
  if (tripwireState.originalFetch) return;
  tripwireState.outside = [];
  tripwireState.previousSpreading = process.env.ENABLE_SPREADING_ACTIVATION;
  process.env.ENABLE_SPREADING_ACTIVATION = "false";
  tripwireState.originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (!isLoopback(url)) {
      tripwireState.outside.push(`fetch:${String(url)}`);
      throw new Error("EXTERNAL_NETWORK_FORBIDDEN");
    }
    return tripwireState.originalFetch(url, options);
  };

  const http = require("node:http");
  const https = require("node:https");
  const net = require("node:net");
  const tls = require("node:tls");
  const childProcess = require("node:child_process");

  for (const [module, name, kind] of [
    [http, "request", "http"], [http, "get", "http"],
    [https, "request", "https"], [https, "get", "https"],
    [net, "connect", "net"], [net, "createConnection", "net"],
    [tls, "connect", "tls"]
  ]) {
    patchMethod(module, name, original => (...args) => {
      guardDestination(kind, args);
      return original.apply(module, args);
    });
  }

  const dns = require("node:dns");
  const dnsPromises = require("node:dns/promises");
  const dnsTargets = [dns, dnsPromises, dns.promises].filter((target, index, all) => target && all.indexOf(target) === index);
  for (const name of [
    "lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa",
    "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr",
    "resolveSoa", "resolveSrv", "resolveTxt", "reverse"
  ]) for (const target of dnsTargets) {
    patchMethod(target, name, original => (...args) => {
      const host = args[0];
      if (host && !isLoopback(`http://${host}`)) {
        tripwireState.outside.push(`dns:${host}`);
        if (target === dnsPromises || target === dns.promises) {
          return Promise.reject(new Error("EXTERNAL_NETWORK_FORBIDDEN"));
        }
        throw new Error("EXTERNAL_NETWORK_FORBIDDEN");
      }
      return original.apply(target, args);
    });
  }

  for (const name of ["spawn", "exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"]) {
    patchMethod(childProcess, name, _original => (..._args) => {
      tripwireState.outside.push(`child_process:${name}`);
      throw new Error("EXTERNAL_NETWORK_FORBIDDEN");
    });
  }
}

function restoreTripwire() {
  for (const restore of tripwireState.patches.splice(0).reverse()) restore();
  if (tripwireState.originalFetch) globalThis.fetch = tripwireState.originalFetch;
  tripwireState.originalFetch = null;
  if (tripwireState.previousSpreading === undefined) delete process.env.ENABLE_SPREADING_ACTIVATION;
  else process.env.ENABLE_SPREADING_ACTIVATION = tripwireState.previousSpreading;
  tripwireState.previousSpreading = undefined;
}

export function createSecurityPilotHarness(fixture) {
  let server;
  let baseUrl;
  let sessionId;
  let closed = false;
  const { authenticate, dispatch } = createSecurityPilotFakeAdapters(fixture);

  const requestHandler = async (req, res) => {
    await handleMcpPost(req, res, process.hrtime.bigint(), { allow: () => true }, {
      authenticate,
      dispatch,
      skipRateLimitHeaders: true
    });
  };

  return {
    get baseUrl() { return baseUrl; },
    async start() {
      if (server) return { baseUrl };
      closed = false;
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
      if (!sessionId) {
        const init = await fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer pilot-key-a" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {} } })
        });
        if (!init.ok) throw new Error(`MCP_INIT_${init.status}`);
        sessionId = init.headers.get("mcp-session-id");
      }
      const token = "pilot-key-a";
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "mcp-session-id": sessionId },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } })
      });
      if (!response.ok) throw new Error(`MCP_${response.status}`);
      const body = await response.json();
      if (body.error) throw new Error(body.error.message || body.error);
      return body.result;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (server) await new Promise(resolve => server.close(() => resolve()));
      restoreTripwire();
      server = null;
      sessionId = null;
    }
  };
}

export { runAutoReflectFixture };
