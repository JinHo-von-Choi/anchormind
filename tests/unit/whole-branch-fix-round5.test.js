import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { readFileSync } from "node:fs";

let dbCalls = 0;
mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => ({}) ,
    queryWithAgentVector: async () => {
      dbCalls += 1;
      throw new Error("database call reached security-pilot test");
    },
    withTransaction: async () => {
      dbCalls += 1;
      throw new Error("transaction reached security-pilot test");
    }
  }
});

const { FragmentStore } = await import("../../lib/memory/write/FragmentStore.js");

test("FragmentStore.deleteExpired skips the low-level writer without a DB call in pilot", async () => {
  const previousPilot = process.env.MEMENTO_SECURITY_PILOT_AUTOMATION;
  process.env.MEMENTO_SECURITY_PILOT_AUTOMATION = "off";
  dbCalls = 0;
  try {
    const deleted = await new FragmentStore().deleteExpired();
    assert.equal(deleted, 0);
    assert.equal(dbCalls, 0);
  } finally {
    if (previousPilot === undefined) delete process.env.MEMENTO_SECURITY_PILOT_AUTOMATION;
    else process.env.MEMENTO_SECURITY_PILOT_AUTOMATION = previousPilot;
  }
});

test("FragmentWriter exposes the pilot guard at the low-level delete boundary", () => {
  const source = readFileSync(new URL("../../lib/memory/write/FragmentWriter.js", import.meta.url), "utf8");
  assert.match(source, /isSecurityPilotAutomationOff/);
  assert.match(source, /async deleteExpired\(\)\s*\{\s*if \(isSecurityPilotAutomationOff\(\)\) return 0/s);
});

test("FragmentStore.deleteExpired keeps the legacy DB path outside the pilot", async () => {
  const previousPilot = process.env.MEMENTO_SECURITY_PILOT_AUTOMATION;
  process.env.MEMENTO_SECURITY_PILOT_AUTOMATION = "on";
  dbCalls = 0;
  try {
    await assert.rejects(() => new FragmentStore().deleteExpired(), /database call reached security-pilot test/);
    assert.equal(dbCalls, 1);
  } finally {
    if (previousPilot === undefined) delete process.env.MEMENTO_SECURITY_PILOT_AUTOMATION;
    else process.env.MEMENTO_SECURITY_PILOT_AUTOMATION = previousPilot;
  }
});
