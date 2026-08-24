import assert from "node:assert/strict";
import { test } from "node:test";
import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const FORBIDDEN = "EXTERNAL_NETWORK_FORBIDDEN";

function hostFrom(value, fallback = "") {
  if (typeof value === "string") {
    try {
      return new URL(value).hostname;
    } catch {
      return fallback;
    }
  }
  if (value && typeof value === "object") {
    if (value.hostname) return String(value.hostname);
    if (value.host) return String(value.host).replace(/^\[|\]$/g, "");
  }
  return fallback;
}

function isAllowed(host, allowedHosts) {
  return allowedHosts.has(String(host).toLowerCase());
}

function forbiddenError(host) {
  const error = new Error(`${FORBIDDEN}: ${host || "unknown"}`);
  error.code = FORBIDDEN;
  return error;
}

/**
 * Offline test boundary. All wrapped operations are rejected unless their
 * destination is explicitly allow-listed; every rejection is recorded.
 */
export function createNetworkTripwire({ allowedHosts = ["127.0.0.1", "localhost", "::1"] } = {}) {
  const allow = new Set(allowedHosts.map((host) => String(host).toLowerCase()));
  const externalNetworkAttempts = [];
  const originals = [];

  const wrap = (target, name, getHost, original = target[name]) => {
    const wrapped = function (...args) {
      const host = getHost(...args);
      if (!isAllowed(host, allow)) {
        const error = forbiddenError(host);
        externalNetworkAttempts.push({ name, host, error });
        throw error;
      }
      return original.apply(this, args);
    };
    target[name] = wrapped;
    originals.push(() => { target[name] = original; });
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (...args) {
    const host = hostFrom(args[0]);
    if (!isAllowed(host, allow)) {
      const error = forbiddenError(host);
      externalNetworkAttempts.push({ name: "fetch", host, error });
      throw error;
    }
    return originalFetch.apply(this, args);
  };
  originals.push(() => { globalThis.fetch = originalFetch; });

  wrap(net, "connect", (options) => hostFrom(options, "localhost"));
  wrap(tls, "connect", (options) => hostFrom(options, "localhost"));
  wrap(http, "request", (options) => hostFrom(options, "localhost"));
  wrap(https, "request", (options) => hostFrom(options, "localhost"));
  wrap(childProcess, "spawn", () => "child_process");
  wrap(childProcess, "execFile", () => "child_process");

  return {
    externalNetworkAttempts,
    restore() {
      while (originals.length) originals.pop()();
    },
    assertNoExternalNetworkCalls() {
      assert.equal(externalNetworkAttempts.length, 0, JSON.stringify(externalNetworkAttempts));
    },
  };
}

export function createOfflineTestAdapter(options = {}) {
  const tripwire = createNetworkTripwire(options);
  return {
    ...tripwire,
    db: { query: async () => ({ rows: [] }) },
    redis: { get: async () => null, set: async () => "OK" },
    llm: { complete: async () => ({ text: "synthetic response" }) },
  };
}

test("offline adapter rejects non-allowlisted network destinations", async () => {
  const adapter = createOfflineTestAdapter({ allowedHosts: ["127.0.0.1"] });
  try {
    assert.throws(() => net.connect({ host: "example.test", port: 443 }), { code: FORBIDDEN });
    assert.throws(() => tls.connect({ host: "example.test", port: 443 }), { code: FORBIDDEN });
    assert.throws(() => http.request("https://example.test/"), { code: FORBIDDEN });
    assert.throws(() => https.request("https://example.test/"), { code: FORBIDDEN });
    assert.throws(() => childProcess.spawn("curl", ["https://example.test/"]), { code: FORBIDDEN });
    assert.throws(() => childProcess.execFile("curl", ["https://example.test/"]), { code: FORBIDDEN });
    await assert.rejects(globalThis.fetch("https://example.test/"), { code: FORBIDDEN });
    assert.equal(adapter.externalNetworkAttempts.length, 7);
  } finally {
    adapter.restore();
  }
});

test("offline adapter allows only explicit loopback destinations", async () => {
  const adapter = createOfflineTestAdapter({ allowedHosts: ["127.0.0.1"] });
  const server = http.createServer((_req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await response.text(), "ok");
    adapter.assertNoExternalNetworkCalls();
  } finally {
    adapter.restore();
    await new Promise((resolve) => server.close(resolve));
  }
});
