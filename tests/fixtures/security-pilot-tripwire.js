import assert from "node:assert/strict";
import childProcess from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const FORBIDDEN = "EXTERNAL_NETWORK_FORBIDDEN";

export function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1";
}

function transportHost(args) {
  const [first, second] = args;
  if (typeof first === "string") {
    try { return new URL(first).hostname; } catch { return second || first; }
  }
  if (first && typeof first === "object") return first.hostname || first.host || "127.0.0.1";
  return typeof second === "string" ? second : "127.0.0.1";
}

/** DNS APIs always take the hostname/IP as their first argument. Callback,
 * rrtype, and options arguments must never be interpreted as destinations. */
function dnsHost(args) {
  const first = args[0];
  if (typeof first === "string") return first.replace(/^\[|\]$/g, "").toLowerCase();
  if (first && typeof first === "object" && typeof first.hostname === "string") {
    return first.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  }
  return null;
}

export function createNetworkTripwire({ allowedHosts = ["127.0.0.1", "::1"] } = {}) {
  const allowed = new Set(allowedHosts.map(host => String(host).toLowerCase()));
  const externalNetworkAttempts = [];
  const originals = [];

  const reject = (name, host) => {
    if (!host || allowed.has(host)) return;
    externalNetworkAttempts.push({ name, host });
    const error = new Error(`${FORBIDDEN}: ${host}`);
    error.code = FORBIDDEN;
    throw error;
  };
  const wrap = (target, name, getHost = transportHost) => {
    const original = target[name];
    target[name] = function (...args) {
      reject(name, getHost(args));
      return original.apply(this, args);
    };
    originals.push(() => { target[name] = original; });
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (...args) {
    reject("fetch", transportHost(args));
    return originalFetch.apply(this, args);
  };
  originals.push(() => { globalThis.fetch = originalFetch; });

  for (const [target, name] of [
    [net, "connect"], [net, "createConnection"], [tls, "connect"],
    [http, "request"], [http, "get"], [https, "request"], [https, "get"]
  ]) wrap(target, name);

  const dnsNames = [
    "lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa",
    "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr",
    "resolveSoa", "resolveSrv", "resolveTxt", "reverse"
  ];
  for (const name of dnsNames) {
    if (typeof dns[name] === "function") wrap(dns, name, dnsHost);
    if (typeof dns.promises[name] === "function") {
      const original = dns.promises[name];
      dns.promises[name] = async function (...args) {
        reject(`dns.promises.${name}`, dnsHost(args));
        return original.apply(this, args);
      };
      originals.push(() => { dns.promises[name] = original; });
    }
  }

  for (const name of ["spawn", "exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"]) {
    const original = childProcess[name];
    childProcess[name] = function (...args) {
      externalNetworkAttempts.push({ name: `child_process.${name}`, host: null });
      const error = new Error(`${FORBIDDEN}: child process`);
      error.code = FORBIDDEN;
      throw error;
    };
    originals.push(() => { childProcess[name] = original; });
  }

  return {
    externalNetworkAttempts,
    restore() { while (originals.length) originals.pop()(); },
    assertNoExternalNetworkCalls() { assert.equal(externalNetworkAttempts.length, 0); }
  };
}
