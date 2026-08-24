import assert from "node:assert/strict";
import dns from "node:dns";
import { test } from "node:test";
import { createNetworkTripwire } from "../fixtures/security-pilot-tripwire.js";

test("DNS loopback overloads use only the first hostname argument", async () => {
  const original = {
    lookup: dns.lookup,
    resolve4: dns.resolve4,
    reverse: dns.reverse,
    promiseLookup: dns.promises.lookup,
    promiseResolve4: dns.promises.resolve4,
  };
  const calls = [];
  dns.lookup = (...args) => { calls.push(["lookup", args]); };
  dns.resolve4 = (...args) => { calls.push(["resolve4", args]); };
  dns.reverse = (...args) => { calls.push(["reverse", args]); };
  dns.promises.lookup = async (...args) => { calls.push(["promises.lookup", args]); return []; };
  dns.promises.resolve4 = async (...args) => { calls.push(["promises.resolve4", args]); return []; };

  const tripwire = createNetworkTripwire();
  try {
    dns.lookup("127.0.0.1", { all: true }, () => {});
    dns.lookup("::1", () => {});
    dns.resolve4("127.0.0.1", "A", () => {});
    dns.reverse("::1", { ttl: true }, () => {});
    await dns.promises.lookup("127.0.0.1", { all: true });
    await dns.promises.resolve4("::1");

    assert.equal(tripwire.externalNetworkAttempts.length, 0);
    assert.equal(calls.length, 6);
  } finally {
    tripwire.restore();
    dns.lookup = original.lookup;
    dns.resolve4 = original.resolve4;
    dns.reverse = original.reverse;
    dns.promises.lookup = original.promiseLookup;
    dns.promises.resolve4 = original.promiseResolve4;
  }
});

test("DNS names and external reverse IPs are rejected and recorded before resolution", async () => {
  const tripwire = createNetworkTripwire();
  try {
    assert.throws(
      () => dns.resolve("example.com", "A", () => {}),
      /EXTERNAL_NETWORK_FORBIDDEN: example\.com/
    );
    assert.throws(
      () => dns.reverse("203.0.113.10", () => {}),
      /EXTERNAL_NETWORK_FORBIDDEN: 203\.0\.113\.10/
    );
    await assert.rejects(
      () => dns.promises.resolve4("example.com"),
      /EXTERNAL_NETWORK_FORBIDDEN: example\.com/
    );
    await assert.rejects(
      () => dns.promises.reverse("203.0.113.10"),
      /EXTERNAL_NETWORK_FORBIDDEN: 203\.0\.113\.10/
    );

    assert.deepEqual(
      tripwire.externalNetworkAttempts.map(attempt => attempt.host),
      ["example.com", "203.0.113.10", "example.com", "203.0.113.10"]
    );
  } finally {
    tripwire.restore();
  }
});
