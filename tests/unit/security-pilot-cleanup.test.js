import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SECURITY_PILOT_DEFER_SYNTHETIC_CLEANUP,
  deleteSyntheticFixture,
  shouldDeferSyntheticCleanup
} from "../fixtures/security-pilot-cleanup.js";

test("synthetic cleanup deferral accepts only the exact runner value", () => {
  assert.equal(SECURITY_PILOT_DEFER_SYNTHETIC_CLEANUP, "SECURITY_PILOT_DEFER_SYNTHETIC_CLEANUP");
  assert.equal(shouldDeferSyntheticCleanup({ SECURITY_PILOT_DEFER_SYNTHETIC_CLEANUP: "true" }), true);
  assert.equal(shouldDeferSyntheticCleanup({ SECURITY_PILOT_DEFER_SYNTHETIC_CLEANUP: "false" }), false);
  assert.equal(shouldDeferSyntheticCleanup({ SECURITY_PILOT_DEFER_SYNTHETIC_CLEANUP: "TRUE" }), false);
  assert.equal(shouldDeferSyntheticCleanup({}), false);
});

test("synthetic fixture cleanup targets only the synthetic topic and fixture key IDs", async () => {
  const calls = [];
  const pool = { query: async (...args) => { calls.push(args); } };
  await deleteSyntheticFixture(pool);
  assert.deepEqual(calls, [
    ["DELETE FROM agent_memory.fragments WHERE topic = $1", ["security-pilot-synthetic"]],
    ["DELETE FROM agent_memory.api_keys WHERE id = ANY($1::text[])", [[
      "00000000-0000-0000-0000-00000000aaaa",
      "00000000-0000-0000-0000-00000000bbbb"
    ]]]
  ]);
});
